import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/jetbrains-mono/500.css";
import "./style.css";
import { LANGUAGES } from "../../shared/types.ts";
import type { AppStatus, BackendChoice, HistoryEntry, Settings } from "../../shared/types.ts";
import type { HotkeyInfo } from "../../preload/index.ts";
import { icon, langPair } from "../icons.ts";

const chirp = window.chirp;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const EVDEV_CHOICES: [string, string][] = [
  ["KEY_RIGHTALT", "Right Alt / AltGr"],
  ["KEY_RIGHTCTRL", "Right Ctrl"],
  ["KEY_RIGHTMETA", "Right Super"],
  ["KEY_CAPSLOCK", "Caps Lock"],
  ["KEY_COMPOSE", "Menu"],
  ["KEY_PAUSE", "Pause"],
  ["KEY_SCROLLLOCK", "Scroll Lock"],
  ["KEY_INSERT", "Insert"],
  ...[13, 14, 15, 16, 17, 18, 19, 20].map((n): [string, string] => [`KEY_F${n}`, `F${n}`]),
];
const UIOHOOK_CHOICES: [string, string][] = [
  ["AltRight", "Right Alt"],
  ["CtrlRight", "Right Ctrl"],
  ["MetaRight", "Right Super / Cmd"],
  ["CapsLock", "Caps Lock"],
  ["ScrollLock", "Scroll Lock"],
  ["Insert", "Insert"],
  ...[13, 14, 15, 16, 17, 18, 19, 20].map((n): [string, string] => [`F${n}`, `F${n}`]),
];

function fill(select: HTMLSelectElement, entries: [string, string][]) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

const langs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));
fill($<HTMLSelectElement>("source"), langs);
fill($<HTMLSelectElement>("target"), langs);
fill($<HTMLSelectElement>("evdev-key"), EVDEV_CHOICES);
fill($<HTMLSelectElement>("uiohook-key"), UIOHOOK_CHOICES);

let settings: Settings;

function save(patch: Partial<Settings>) {
  void chirp.setSettings(patch).then(render);
}

function render(s: Settings) {
  settings = s;
  $<HTMLSelectElement>("source").value = s.sourceLanguage;
  $<HTMLSelectElement>("target").value = s.targetLanguage;
  $("mode-note").textContent =
    s.sourceLanguage === s.targetLanguage
      ? `Plain transcription in ${LANGUAGES[s.sourceLanguage]}.`
      : `You speak ${LANGUAGES[s.sourceLanguage]}, Chirp writes ${LANGUAGES[s.targetLanguage]}.`;

  $<HTMLSelectElement>("hotkey-backend").value = s.hotkeyBackend;
  $<HTMLSelectElement>("evdev-key").value = s.evdevKey;
  $<HTMLSelectElement>("uiohook-key").value = s.uiohookKey;
  $<HTMLInputElement>("portal-trigger").value = s.portalTrigger;
  $<HTMLInputElement>("chord").checked = s.cancelOnChord;

  const isLinux = chirp.platform === "linux";
  const b = s.hotkeyBackend;
  $("evdev-field").hidden = !(b === "evdev" || (b === "auto" && isLinux));
  $("uiohook-field").hidden = !(b === "uiohook" || (b === "auto" && !isLinux));
  $("portal-field").hidden = !(b === "portal" || (b === "auto" && isLinux));

  for (const btn of $("output-mode").querySelectorAll<HTMLButtonElement>("button")) {
    btn.setAttribute("aria-checked", String(btn.dataset.value === s.outputMode));
  }
  $<HTMLSelectElement>("paste-combo").value = s.pasteCombo;
  $<HTMLSelectElement>("paste-combo").disabled = s.outputMode !== "paste";
  $<HTMLInputElement>("space").checked = s.appendSpace;
  $<HTMLInputElement>("login").checked = s.launchAtLogin;
  $<HTMLSelectElement>("mic").value = s.micDeviceId;
  renderBackends();
}

// ---- compute backend ----
let backends: BackendChoice[] = [];
function renderBackends(list = backends) {
  backends = list;
  const select = $<HTMLSelectElement>("compute-backend");
  select.replaceChildren(...list.map((b) => new Option([b.label, b.device].filter(Boolean).join(" · "), b.backend)));
  // Until the user picks one, show the best available backend (listed first).
  const saved = settings?.computeBackend;
  select.value = list.some((b) => b.backend === saved) ? saved : (list[0]?.backend ?? "");
  select.disabled = list.length === 0;
}

// ---- bindings ----
const bindSelect = (id: string, key: keyof Settings) =>
  $<HTMLSelectElement>(id).addEventListener("change", (e) =>
    save({ [key]: (e.target as HTMLSelectElement).value } as Partial<Settings>),
  );
const bindCheck = (id: string, key: keyof Settings) =>
  $<HTMLInputElement>(id).addEventListener("change", (e) =>
    save({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>),
  );

bindSelect("source", "sourceLanguage");
bindSelect("target", "targetLanguage");
bindSelect("hotkey-backend", "hotkeyBackend");
bindSelect("evdev-key", "evdevKey");
bindSelect("uiohook-key", "uiohookKey");
bindSelect("paste-combo", "pasteCombo");
bindSelect("mic", "micDeviceId");
bindSelect("compute-backend", "computeBackend");
bindCheck("chord", "cancelOnChord");
bindCheck("space", "appendSpace");
bindCheck("login", "launchAtLogin");
$<HTMLInputElement>("portal-trigger").addEventListener("change", (e) =>
  save({ portalTrigger: (e.target as HTMLInputElement).value.trim() || "CTRL+space" }),
);
$("swap").addEventListener("click", () =>
  save({ sourceLanguage: settings.targetLanguage, targetLanguage: settings.sourceLanguage }),
);
$("output-mode").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest("button")?.dataset.value;
  if (v === "paste" || v === "clipboard") save({ outputMode: v });
});
$("download").addEventListener("click", () => {
  $<HTMLButtonElement>("download").disabled = true;
  void chirp.downloadModel().finally(() => ($<HTMLButtonElement>("download").disabled = false));
});
$("pick").addEventListener("click", () => void chirp.pickModel());

// ---- status ----
function mb(n: number) {
  return (n / 1e6).toFixed(0);
}
function renderStatus(s: AppStatus) {
  const engine = $("engine");
  engine.dataset.state = s.state;
  const label = $("engine-label");
  $("model-card").hidden = !(s.state === "no-model" || s.state === "downloading");
  $("progress").hidden = s.state !== "downloading";
  $("progress-label").textContent = "";
  switch (s.state) {
    case "no-model":
      label.textContent = "model missing";
      break;
    case "downloading": {
      const pct = s.total ? (100 * s.received) / s.total : 0;
      label.textContent = `downloading ${pct.toFixed(0)}%`;
      $("bar").style.width = `${pct}%`;
      $("progress-label").textContent = `${mb(s.received)} / ${mb(s.total)} MB`;
      $<HTMLButtonElement>("download").disabled = true;
      break;
    }
    case "loading":
      label.textContent = "loading model…";
      break;
    case "ready":
      label.textContent = `ready · ${s.backend}`;
      break;
    case "error":
      label.textContent = s.message;
      engine.title = s.message;
      break;
  }
}

// ---- hotkey info ----
function renderHotkey(h: HotkeyInfo) {
  $("key-label").textContent = h.label || "not bound";
  $("key-kind").textContent = h.kind || "none";
  $("warnings").replaceChildren(
    ...h.warnings.map((w) => {
      const li = document.createElement("li");
      // Render `code` spans from backtick-quoted parts; everything else is plain text.
      w.split(/(`[^`]+`)/).forEach((part) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          const c = document.createElement("code");
          c.textContent = part.slice(1, -1);
          li.append(c);
        } else li.append(part);
      });
      return li;
    }),
  );
}

// ---- history ----
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
function duration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
function renderHistory(items: HistoryEntry[]) {
  $("history-empty").hidden = items.length > 0;
  $("history-clear").hidden = items.length === 0;
  $("history").replaceChildren(
    ...items.slice(0, 50).map((h) => {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = timeFmt.format(h.at);
      const when = document.createElement("span");
      when.className = "when";
      when.append(time);
      if (h.finalMs !== undefined) {
        const dur = document.createElement("span");
        dur.className = "dur";
        dur.textContent = duration(h.finalMs);
        dur.title = `Final transcription took ${duration(h.finalMs)} for ${duration(h.audioMs)} of audio`;
        when.append(dur);
      }
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = h.text;
      const l = document.createElement("span");
      l.className = "l";
      l.replaceChildren(...langPair(h.sourceLanguage, h.targetLanguage));
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Delete";
      del.setAttribute("aria-label", "Delete");
      del.append(icon("trash"));
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        li.remove(); // the store broadcasts the updated list right after
        void chirp.deleteHistory(h.at);
      });
      li.title = "Click to copy";
      li.append(when, t, l, del);
      li.addEventListener("click", () => {
        void chirp.copyText(h.text);
        li.classList.add("copied");
        l.textContent = "COPIED";
        setTimeout(() => renderHistory(items), 1200);
      });
      return li;
    }),
  );
}

$("history-clear").addEventListener("click", () => {
  if (confirm("Delete all recent transcriptions? This cannot be undone.")) void chirp.clearHistory();
});

// ---- microphones ----
async function loadMics() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const mics = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default");
  fill($<HTMLSelectElement>("mic"), [
    ["", "System default"],
    ...mics.map((d, i): [string, string] => [d.deviceId, d.label || `Microphone ${i + 1}`]),
  ]);
  if (settings) $<HTMLSelectElement>("mic").value = settings.micDeviceId;
}

async function init() {
  await loadMics();
  backends = await chirp.getBackends();
  render(await chirp.getSettings());
  renderStatus(await chirp.getStatus());
  renderHotkey(await chirp.getHotkeyInfo());
  renderHistory(await chirp.getHistory());
  chirp.onSettings(render);
  chirp.onStatus(renderStatus);
  chirp.onHotkeyInfo(renderHotkey);
  chirp.onHistory(renderHistory);
  chirp.onBackends(renderBackends);
  navigator.mediaDevices.addEventListener("devicechange", () => void loadMics());
}
void init();
