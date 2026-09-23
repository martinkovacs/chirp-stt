import type { EventEmitter } from "node:events";

/**
 * A global push-to-talk key source.
 *
 * Events:
 *  - "down"          hotkey pressed (auto-repeat must NOT re-emit)
 *  - "up"            hotkey released
 *  - "chord"         another key was pressed while the hotkey is held
 *                    (e.g. AltGr+V to type "@"); consumer cancels the recording
 *  - "error" (err)   non-fatal runtime error (device vanished, dbus dropped, ...)
 */
export interface HotkeySource extends EventEmitter {
  /** Short identifier shown in the UI: "evdev" | "portal" | "uiohook". */
  readonly kind: string;
  /** Human-readable description of the active binding, e.g. "Right Alt" or "Ctrl+Space". */
  describe(): string;
  /** Starts listening. Rejects if the backend is unusable (permissions, no portal, ...). */
  start(): Promise<void>;
  stop(): void;
}
