// Contracts shared between main process, STT worker, preload and renderers.

export const SAMPLE_RATE = 16000;

/** Canary-1B-v2 languages (ASR source and translation targets). */
export const LANGUAGES: Record<string, string> = {
  bg: "Bulgarian", hr: "Croatian", cs: "Czech", da: "Danish", nl: "Dutch",
  en: "English", et: "Estonian", fi: "Finnish", fr: "French", de: "German",
  el: "Greek", hu: "Hungarian", it: "Italian", lv: "Latvian", lt: "Lithuanian",
  mt: "Maltese", pl: "Polish", pt: "Portuguese", ro: "Romanian", sk: "Slovak",
  sl: "Slovenian", es: "Spanish", sv: "Swedish", ru: "Russian", uk: "Ukrainian",
};

export type HotkeyBackend = "auto" | "evdev" | "portal" | "uiohook";
export type ComputeBackend = "auto" | "vulkan" | "cuda" | "rocm" | "metal" | "cpu";
export type OutputMode = "paste" | "clipboard";
export type PasteCombo = "ctrl+v" | "ctrl+shift+v" | "shift+insert";

/** One available compute backend as shown in the settings UI, best first. */
export interface BackendChoice {
  backend: Exclude<ComputeBackend, "auto">;
  label: string;
  /** Human device description, e.g. "NVIDIA GeForce RTX 5060 Ti", or "" if unknown. */
  device: string;
}

export interface Settings {
  /** Absolute path to the GGUF model. Empty = default location in userData/models. */
  modelPath: string;
  /** Compute backend for inference. "auto" (never picked by the user) = best available. */
  computeBackend: ComputeBackend;
  /** Spoken language (Canary has no auto-detect). */
  sourceLanguage: string;
  /** Output language. Equal to sourceLanguage = plain transcription. */
  targetLanguage: string;
  hotkeyBackend: HotkeyBackend;
  /** Linux evdev key name, e.g. "KEY_RIGHTALT" (see src/main/input/keycodes.ts). */
  evdevKey: string;
  /** uiohook key name (Windows/macOS/X11), e.g. "AltRight". */
  uiohookKey: string;
  /** Preferred trigger suggested to the xdg GlobalShortcuts portal, e.g. "CTRL+space". */
  portalTrigger: string;
  /** Cancel the recording if another key is pressed while the hotkey is held (AltGr chords). */
  cancelOnChord: boolean;
  outputMode: OutputMode;
  pasteCombo: PasteCombo;
  /** Append a trailing space after pasted text. */
  appendSpace: boolean;
  /** MediaDeviceInfo.deviceId, "" = system default. */
  micDeviceId: string;
  launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  modelPath: "",
  computeBackend: "auto",
  sourceLanguage: "hu",
  targetLanguage: "en",
  hotkeyBackend: "auto",
  evdevKey: "KEY_RIGHTALT",
  uiohookKey: "AltRight",
  portalTrigger: "CTRL+space",
  cancelOnChord: true,
  outputMode: "paste",
  pasteCombo: "ctrl+v",
  appendSpace: true,
  micDeviceId: "",
  launchAtLogin: false,
};

export interface HistoryEntry {
  at: number; // epoch ms
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  audioMs: number;
  /** Time from releasing the key (stop request) until the final text was ready. */
  finalMs?: number;
}

// ---------------------------------------------------------------------------
// Main <-> STT worker (Electron utilityProcess, process.parentPort messages)
// ---------------------------------------------------------------------------

export interface DecodeOptions {
  language: string;
  /** Present only when translating (targetLanguage !== language). */
  targetLanguage?: string;
  task: "transcribe" | "translate";
}

export type ToWorker =
  | { type: "load"; loadId: number; modelPath: string; backend: ComputeBackend }
  | { type: "start"; id: number; options: DecodeOptions }
  | { type: "audio"; id: number; pcm: Float32Array }
  | { type: "stop"; id: number }
  | { type: "cancel"; id: number };

export type FromWorker =
  | { type: "loaded"; loadId: number; backend: string; loadMs: number; backends: BackendChoice[] }
  | { type: "backends"; backends: BackendChoice[] }
  | { type: "load-error"; loadId: number; message: string }
  | { type: "partial"; id: number; committed: string; tentative: string }
  | { type: "final"; id: number; text: string; audioMs: number; decodeMs: number }
  | { type: "error"; id?: number; message: string };

// ---------------------------------------------------------------------------
// Main <-> renderer (preload bridge, exposed as window.chirp)
// ---------------------------------------------------------------------------

export type AppStatus =
  | { state: "no-model"; model: { label: string; size: number } }
  | { state: "downloading"; received: number; total: number }
  | { state: "loading" }
  | { state: "ready"; backend: string }
  | { state: "error"; message: string };

export type OverlayState =
  | { phase: "hidden" }
  | { phase: "listening"; committed: string; tentative: string; level: number }
  | { phase: "finishing"; committed: string; tentative: string }
  | { phase: "done"; text: string }
  | { phase: "error"; message: string };

export const IPC = {
  // renderer -> main
  getSettings: "settings:get",
  setSettings: "settings:set",
  getBackends: "backends:get",
  getStatus: "status:get",
  getHistory: "history:get",
  deleteHistory: "history:delete",
  clearHistory: "history:clear",
  downloadModel: "model:download",
  pickModel: "model:pick",
  copyText: "text:copy",
  hotkeyInfo: "hotkey:info",
  audioChunk: "audio:chunk", // (pcm: Float32Array, level: number)
  captureError: "audio:error",
  // main -> renderer
  status: "status:changed",
  settingsChanged: "settings:changed",
  overlay: "overlay:state",
  captureStart: "audio:start", // (micDeviceId: string)
  captureStop: "audio:stop",
  historyChanged: "history:changed",
  backendsChanged: "backends:changed",
} as const;
