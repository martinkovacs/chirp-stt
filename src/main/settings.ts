// Settings persistence: settings.json in the given directory. Pure node.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
} from "../shared/types.ts";
import type {
  ComputeBackend,
  HotkeyBackend,
  OutputMode,
  PasteCombo,
  Settings,
} from "../shared/types.ts";

const HOTKEY_BACKENDS: readonly HotkeyBackend[] = ["auto", "evdev", "portal", "uiohook"];
const COMPUTE_BACKENDS: readonly ComputeBackend[] = ["auto", "vulkan", "cuda", "rocm", "metal", "cpu"];
const OUTPUT_MODES: readonly OutputMode[] = ["paste", "clipboard"];
const PASTE_COMBOS: readonly PasteCombo[] = ["ctrl+v", "ctrl+shift+v", "shift+insert"];

/** Replace invalid / unknown fields with defaults. Always returns a full Settings. */
export function sanitize(raw: unknown): Settings {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const s = { ...DEFAULT_SETTINGS };
  if (typeof src.modelPath === "string") s.modelPath = src.modelPath;
  if (typeof src.sourceLanguage === "string" && src.sourceLanguage in LANGUAGES) {
    s.sourceLanguage = src.sourceLanguage;
  }
  if (typeof src.targetLanguage === "string" && src.targetLanguage in LANGUAGES) {
    s.targetLanguage = src.targetLanguage;
  }
  if (typeof src.hotkeyBackend === "string" && (HOTKEY_BACKENDS as readonly string[]).includes(src.hotkeyBackend)) {
    s.hotkeyBackend = src.hotkeyBackend as HotkeyBackend;
  }
  if (typeof src.computeBackend === "string" && (COMPUTE_BACKENDS as readonly string[]).includes(src.computeBackend)) {
    s.computeBackend = src.computeBackend as ComputeBackend;
  }
  if (typeof src.evdevKey === "string" && src.evdevKey !== "") s.evdevKey = src.evdevKey;
  if (typeof src.uiohookKey === "string" && src.uiohookKey !== "") s.uiohookKey = src.uiohookKey;
  if (typeof src.portalTrigger === "string" && src.portalTrigger !== "") s.portalTrigger = src.portalTrigger;
  if (typeof src.cancelOnChord === "boolean") s.cancelOnChord = src.cancelOnChord;
  if (typeof src.outputMode === "string" && (OUTPUT_MODES as readonly string[]).includes(src.outputMode)) {
    s.outputMode = src.outputMode as OutputMode;
  }
  if (typeof src.pasteCombo === "string" && (PASTE_COMBOS as readonly string[]).includes(src.pasteCombo)) {
    s.pasteCombo = src.pasteCombo as PasteCombo;
  }
  if (typeof src.appendSpace === "boolean") s.appendSpace = src.appendSpace;
  if (typeof src.micDeviceId === "string") s.micDeviceId = src.micDeviceId;
  if (typeof src.launchAtLogin === "boolean") s.launchAtLogin = src.launchAtLogin;
  return s;
}

/** Merge a partial patch over a full Settings, sanitizing the result. */
function merge(current: Settings, patch: Partial<Settings>): Settings {
  return sanitize({ ...current, ...patch });
}

export class SettingsStore extends EventEmitter {
  readonly #file: string;
  #settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, "settings.json");
    this.#load();
  }

  #load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch {
      this.#settings = { ...DEFAULT_SETTINGS };
      return;
    }
    try {
      const parsed = JSON.parse(text);
      this.#settings = sanitize({ ...DEFAULT_SETTINGS, ...parsed });
    } catch {
      // Corrupt: fall back to defaults, keep a backup of the bad file.
      try {
        fs.copyFileSync(this.#file, this.#file + ".bak");
      } catch {
        /* ignore */
      }
      this.#settings = { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return { ...this.#settings };
  }

  update(patch: Partial<Settings>): Settings {
    const prev = { ...this.#settings };
    const next = merge(prev, patch);
    const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])
      .some((k) => !Object.is(next[k], prev[k]));
    if (!changed) return { ...prev };
    this.#settings = next;
    this.#write(next);
    this.emit("change", next, prev);
    return { ...next };
  }

  #write(settings: Settings): void {
    const tmp = this.#file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, this.#file);
  }
}
