import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, session, Tray } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { IPC, LANGUAGES } from "../shared/types.ts";
import type { AppStatus, DecodeOptions, OverlayState, Settings } from "../shared/types.ts";
import { SettingsStore } from "./settings.ts";
import { HistoryStore } from "./history.ts";
import { DEFAULT_MODEL, defaultModelPath, downloadModel, modelExists, resolveModelPath } from "./model-manager.ts";
import { SttClient, defaultWorkerPath } from "./stt/client.ts";
import { createHotkeySource } from "./input/hotkey.ts";
import { PortalHotkeySource } from "./input/portal.ts";
import type { HotkeySource } from "./input/types.ts";
import { Paster } from "./output/paster.ts";
import { ensureDesktopEntry, LINUX_APP_ID, setAutostart } from "./autostart.ts";

// Under native Wayland an app can neither position its windows nor keep them
// on top, which the overlay needs. XWayland handles both (and clipboard sync)
// on KDE/GNOME. Hotkeys and pasting go through evdev/uinput/portal, so they
// are unaffected. Opt out with CHIRP_NATIVE_WAYLAND=1.
if (process.platform === "linux" && !process.env.CHIRP_NATIVE_WAYLAND) {
  app.commandLine.appendSwitch("ozone-platform", "x11");
  // The UI is two tiny windows; software rendering avoids GPU-process crashes
  // seen with NVIDIA under XWayland and leaves VRAM to the speech model.
  app.disableHardwareAcceleration();
}
app.setName("chirp-stt");

const here = fileURLToPath(new URL(".", import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : join(here, "../../resources");
const preloadPath = join(here, "../preload/index.mjs");

// A second launch with --toggle starts/stops dictation, so users can bind the
// command to any desktop shortcut as a fallback.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let settingsStore: SettingsStore;
let history: HistoryStore;
let stt: SttClient;
let paster: Paster;
let tray: Tray | null = null;
let overlayWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let status: AppStatus = { state: "loading" };
let hotkey: HotkeySource | null = null;
let hotkeyInfo = { kind: "", label: "", warnings: [] as string[] };
let downloadAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function loadPage(win: BrowserWindow, page: "overlay" | "settings") {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}/index.html`);
  else void win.loadFile(join(here, `../renderer/${page}/index.html`));
}

const OVERLAY_W = 720;
const OVERLAY_H = 132;

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    type: process.platform === "linux" ? "notification" : undefined,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadPage(overlayWin, "overlay");
}

function positionOverlay() {
  if (!overlayWin) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  overlayWin.setBounds({
    x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2),
    y: Math.round(wa.y + wa.height - OVERLAY_H - 28),
    width: OVERLAY_W,
    height: OVERLAY_H,
  });
}

let overlayHideTimer: NodeJS.Timeout | null = null;

function setOverlay(state: OverlayState) {
  if (!overlayWin) return;
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  overlayWin.webContents.send(IPC.overlay, state);
  if (state.phase === "hidden") {
    // let the CSS fade-out finish before unmapping the window
    overlayHideTimer = setTimeout(() => overlayWin?.hide(), 220);
  } else if (!overlayWin.isVisible()) {
    positionOverlay();
    overlayWin.showInactive();
  }
}

function flashOverlay(state: OverlayState, ms: number) {
  setOverlay(state);
  overlayHideTimer = setTimeout(() => setOverlay({ phase: "hidden" }), ms);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 620,
    height: 860,
    minWidth: 520,
    minHeight: 500,
    title: "Chirp",
    backgroundColor: "#0f0f0e",
    icon: join(resources, "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: preloadPath, sandbox: false },
  });
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => (settingsWin = null));
  loadPage(settingsWin, "settings");
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayImage(kind: "idle" | "rec" | "off") {
  const name = kind === "idle" ? "tray" : kind === "rec" ? "tray-rec" : "tray-off";
  const img = nativeImage.createFromPath(join(resources, `${name}.png`));
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(join(resources, `${name}@2x.png`)).toPNG() });
  return img;
}

function statusLine(): string {
  switch (status.state) {
    case "ready": return `Ready · ${status.backend}`;
    case "loading": return "Loading model…";
    case "downloading": return `Downloading model ${status.total ? Math.round((100 * status.received) / status.total) : 0}%`;
    case "no-model": return "Model not downloaded";
    case "error": return `Error: ${status.message}`;
  }
}

function langSubmenu(key: "sourceLanguage" | "targetLanguage"): MenuItemConstructorOptions[] {
  const s = settingsStore.get();
  return Object.entries(LANGUAGES)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => ({
      label: name,
      type: "radio" as const,
      checked: s[key] === code,
      click: () => settingsStore.update({ [key]: code }),
    }));
}

function refreshTray() {
  if (!tray) return;
  const s = settingsStore.get();
  const recording = phase === "recording" || phase === "finishing";
  tray.setImage(trayImage(recording ? "rec" : status.state === "ready" ? "idle" : "off"));
  const mode = s.sourceLanguage === s.targetLanguage
    ? `${LANGUAGES[s.sourceLanguage]}`
    : `${LANGUAGES[s.sourceLanguage]} → ${LANGUAGES[s.targetLanguage]}`;
  tray.setToolTip(`Chirp — ${mode}\n${statusLine()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { label: hotkeyInfo.label ? `Hold ${hotkeyInfo.label} to dictate` : "No hotkey active", enabled: false },
      { type: "separator" },
      { label: `I speak: ${LANGUAGES[s.sourceLanguage]}`, submenu: langSubmenu("sourceLanguage") },
      { label: `Write in: ${LANGUAGES[s.targetLanguage]}`, submenu: langSubmenu("targetLanguage") },
      {
        label: "Swap languages",
        click: () => settingsStore.update({ sourceLanguage: s.targetLanguage, targetLanguage: s.sourceLanguage }),
      },
      { type: "separator" },
      {
        label: "Paste into focused app",
        type: "checkbox",
        checked: s.outputMode === "paste",
        click: (item) => settingsStore.update({ outputMode: item.checked ? "paste" : "clipboard" }),
      },
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      { label: "Quit Chirp", click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function setStatus(s: AppStatus) {
  status = s;
  broadcast(IPC.status, s);
  refreshTray();
}

async function loadModel() {
  const path = resolveModelPath(settingsStore.get(), app.getPath("userData"));
  if (!modelExists(path)) {
    setStatus({ state: "no-model" });
    return;
  }
  setStatus({ state: "loading" });
  try {
    const { backend } = await stt.load(path);
    setStatus({ state: "ready", backend });
  } catch (err) {
    setStatus({ state: "error", message: errMsg(err) });
  }
}

async function startDownload() {
  if (downloadAbort) return;
  downloadAbort = new AbortController();
  const dest = defaultModelPath(app.getPath("userData"));
  try {
    setStatus({ state: "downloading", received: 0, total: DEFAULT_MODEL.size });
    await downloadModel({
      dest,
      expectedSize: DEFAULT_MODEL.size,
      signal: downloadAbort.signal,
      onProgress: (received, total) => setStatus({ state: "downloading", received, total }),
    });
    settingsStore.update({ modelPath: "" });
    await loadModel();
  } catch (err) {
    setStatus({ state: "error", message: `Download failed: ${errMsg(err)}` });
  } finally {
    downloadAbort = null;
  }
}

// ---------------------------------------------------------------------------
// Dictation state machine
// ---------------------------------------------------------------------------

type Phase = "idle" | "recording" | "finishing";
let phase: Phase = "idle";
let sessionId = -1;
let capturing = false;
let showTimer: NodeJS.Timeout | null = null;
let lastPartial = { committed: "", tentative: "" };

// Keep recording briefly after release so the last syllable isn't clipped.
const RELEASE_TAIL_MS = 220;
// Delay showing the overlay so AltGr chords (typing "@") don't flash it.
const SHOW_DELAY_MS = 140;

function decodeOptions(s: Settings): DecodeOptions {
  return s.sourceLanguage === s.targetLanguage
    ? { task: "transcribe", language: s.sourceLanguage }
    : { task: "translate", language: s.sourceLanguage, targetLanguage: s.targetLanguage };
}

function onHotkeyDown() {
  if (phase !== "idle") return;
  if (status.state !== "ready") {
    flashOverlay({ phase: "error", message: status.state === "loading" ? "Model is still loading…" : statusLine() }, 2200);
    if (status.state === "no-model") openSettings();
    return;
  }
  const s = settingsStore.get();
  phase = "recording";
  lastPartial = { committed: "", tentative: "" };
  sessionId = stt.start(decodeOptions(s));
  capturing = true;
  overlayWin?.webContents.send(IPC.captureStart, s.micDeviceId);
  showTimer = setTimeout(() => {
    showTimer = null;
    if (phase === "recording") setOverlay({ phase: "listening", ...lastPartial, level: 0 });
  }, SHOW_DELAY_MS);
  refreshTray();
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  overlayWin?.webContents.send(IPC.captureStop);
}

function cancelDictation() {
  if (phase === "idle") return;
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  stopCapture();
  stt.cancel(sessionId);
  phase = "idle";
  setOverlay({ phase: "hidden" });
  refreshTray();
}

async function onHotkeyUp() {
  if (phase !== "recording") return;
  phase = "finishing";
  const id = sessionId;
  const overlayShown = showTimer === null;
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  if (overlayShown) setOverlay({ phase: "finishing", ...lastPartial });

  await delay(RELEASE_TAIL_MS);
  stopCapture();
  if (phase !== "finishing" || sessionId !== id) return;

  const s = settingsStore.get();
  try {
    const result = await stt.stop(id);
    if (sessionId !== id) return;
    const text = result.text.trim();
    if (!text) {
      setOverlay({ phase: "hidden" });
      return;
    }
    const out = s.appendSpace ? `${text} ` : text;
    const { method } = await paster.paste(out, { mode: s.outputMode, combo: s.pasteCombo });
    history.add({
      at: Date.now(),
      text,
      sourceLanguage: s.sourceLanguage,
      targetLanguage: s.targetLanguage,
      audioMs: result.audioMs,
    });
    flashOverlay({ phase: "done", text: method === "clipboard" && s.outputMode === "paste" ? `${text}  (copied)` : text }, 1400);
  } catch (err) {
    flashOverlay({ phase: "error", message: errMsg(err) }, 3000);
  } finally {
    if (sessionId === id) phase = "idle";
    refreshTray();
  }
}

function onChord() {
  if (phase === "recording" && settingsStore.get().cancelOnChord) cancelDictation();
}

function toggleDictation() {
  if (phase === "idle") onHotkeyDown();
  else if (phase === "recording") void onHotkeyUp();
}

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

const EVDEV_HELP =
  "Right Alt needs direct keyboard access on Wayland. Run `sudo usermod -aG input $USER`, then log out and back in.";

async function setupHotkey() {
  hotkey?.removeAllListeners();
  hotkey?.stop();
  hotkey = null;
  const s = settingsStore.get();
  try {
    const { source, warnings } = await createHotkeySource(s, {
      portalFactory: () =>
        new PortalHotkeySource({ preferredTrigger: s.portalTrigger, description: "Hold to dictate (Chirp)", appId: LINUX_APP_ID }),
    });
    hotkey = source;
    source.on("down", onHotkeyDown);
    source.on("up", () => void onHotkeyUp());
    source.on("chord", onChord);
    source.on("error", (err: unknown) => console.error("[hotkey]", err));
    const w = warnings.map((m) => (/input.*group|EACCES|permission/i.test(m) ? EVDEV_HELP : m));
    hotkeyInfo = { kind: source.kind, label: source.describe(), warnings: [...new Set(w)] };
  } catch (err) {
    const [evdevPart, portalPart] = errMsg(err).split(" Portal: ");
    hotkeyInfo = {
      kind: "",
      label: "",
      warnings: [
        /input.*group|EACCES|permission/i.test(evdevPart) ? EVDEV_HELP : evdevPart,
        ...(portalPart ? [`Desktop portal shortcut failed: ${portalPart}`] : []),
        "Fallback: bind `chirp-stt --toggle` to a shortcut in your desktop settings (press once to start, again to stop).",
      ],
    };
  }
  broadcast(IPC.hotkeyInfo, hotkeyInfo);
  refreshTray();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(IPC.getSettings, () => settingsStore.get());
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => settingsStore.update(patch));
  ipcMain.handle(IPC.getStatus, () => status);
  ipcMain.handle(IPC.getHistory, () => history.list());
  ipcMain.handle(IPC.hotkeyInfo, () => hotkeyInfo);
  ipcMain.handle(IPC.downloadModel, () => startDownload());
  ipcMain.handle(IPC.copyText, (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle(IPC.pickModel, async () => {
    const opts = { title: "Choose a Canary GGUF model", filters: [{ name: "GGUF", extensions: ["gguf"] }], properties: ["openFile" as const] };
    const r = settingsWin ? await dialog.showOpenDialog(settingsWin, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    settingsStore.update({ modelPath: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.on(IPC.audioChunk, (_e, pcm: Float32Array) => {
    if (phase !== "idle" && capturing) stt.push(sessionId, pcm);
  });
  ipcMain.on(IPC.captureError, (_e, message: string) => {
    console.error("[capture]", message);
    cancelDictation();
    flashOverlay({ phase: "error", message: `Microphone: ${message}` }, 3500);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

app.on("second-instance", (_e, argv) => {
  if (argv.includes("--toggle")) toggleDictation();
  else openSettings();
});

// Tray app: keep running with no windows open.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  downloadAbort?.abort();
  hotkey?.stop();
  history?.flush();
  paster?.dispose();
  stt?.dispose();
});

void app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(userData);
  history = new HistoryStore(userData);
  paster = new Paster({ writeClipboard: (t) => clipboard.writeText(t) });
  paster.prepare();
  stt = new SttClient(defaultWorkerPath());

  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");

  ensureDesktopEntry();
  registerIpc();
  createOverlay();

  tray = new Tray(trayImage("off"));
  tray.on("click", openSettings);
  refreshTray();

  stt.on("partial", (id: number, committed: string, tentative: string) => {
    if (id !== sessionId || phase !== "recording") return;
    lastPartial = { committed, tentative };
    if (!showTimer) setOverlay({ phase: "listening", committed, tentative, level: 0 });
  });
  stt.on("crashed", (reason: string) => {
    console.error("[stt] worker crashed:", reason);
    cancelDictation();
    setStatus({ state: "error", message: "Speech engine crashed, reloading…" });
    void loadModel();
  });

  settingsStore.on("change", (next: Settings, prev: Settings) => {
    broadcast(IPC.settingsChanged, next);
    refreshTray();
    if (next.modelPath !== prev.modelPath) void loadModel();
    if (
      next.hotkeyBackend !== prev.hotkeyBackend ||
      next.evdevKey !== prev.evdevKey ||
      next.uiohookKey !== prev.uiohookKey ||
      next.portalTrigger !== prev.portalTrigger
    ) {
      void setupHotkey();
    }
    if (next.launchAtLogin !== prev.launchAtLogin) setAutostart(next.launchAtLogin);
  });
  history.on("change", () => broadcast(IPC.historyChanged, history.list()));

  if (process.argv.includes("--settings")) openSettings();
  await Promise.all([loadModel(), setupHotkey()]);
  if (status.state === "no-model" || hotkeyInfo.warnings.length) openSettings();
});
