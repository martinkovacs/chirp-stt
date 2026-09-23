import EventEmitter from "node:events";
import { uIOhook, UiohookKey } from "uiohook-napi";
import type { HotkeySource } from "./types.ts";
import { UIOHOOK_KEY_NAMES } from "./keycodes.ts";

// Refcount across all sources so concurrent sources don't kill each other's hook.
let refCount = 0;
let hookStarted = false;

async function acquireHook(): Promise<void> {
  refCount++;
  if (!hookStarted) {
    hookStarted = true;
    await uIOhook.start();
  }
}

function releaseHook(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && hookStarted) {
    hookStarted = false;
    uIOhook.stop();
  }
}

interface RawUiohookEvent {
  type: number;
  keycode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Global hotkey capture via uiohook-napi (X11/Windows/macOS).
 * Note: this does NOT receive events on native Wayland sessions.
 */
export class UiohookHotkeySource extends EventEmitter implements HotkeySource {
  readonly kind = "uiohook" as const;
  private readonly keycode: number;
  private held = false;
  private chordEmitted = false;
  private stopped = true;
  private onKeyDown: ((e: RawUiohookEvent) => void) | null = null;
  private onKeyUp: ((e: RawUiohookEvent) => void) | null = null;

  constructor(opts: { key: string }) {
    super();
    const keycode = (UiohookKey as Record<string, number | undefined>)[opts.key];
    if (keycode === undefined || !UIOHOOK_KEY_NAMES.includes(opts.key)) {
      throw new Error(`Unknown uiohook key name: ${opts.key}`);
    }
    this.keycode = keycode;
  }

  describe(): string {
    const n = this.keyNameOf(this.keycode);
    return n.replace(/(Right|Left)$/, " $1").replace(/^([a-z])/, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  private keyNameOf(code: number): string {
    const found = UIOHOOK_KEY_NAMES.find((n) => (UiohookKey as Record<string, number>)[n] === code);
    return found ?? String(code);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.held = false;
    this.chordEmitted = false;
    await acquireHook();
    this.onKeyDown = (e) => {
      if (e.keycode === undefined) return;
      if (e.keycode === this.keycode) {
        if (!this.held) {
          // keydown events repeat with modifiers present; only first counts
          this.held = true;
          this.chordEmitted = false;
          this.emit("down");
        }
      } else if (this.held && !this.chordEmitted) {
        this.chordEmitted = true;
        this.emit("chord");
      }
    };
    this.onKeyUp = (e) => {
      if (e.keycode === this.keycode && this.held) {
        this.held = false;
        this.emit("up");
      }
    };
    uIOhook.on("keydown", this.onKeyDown);
    uIOhook.on("keyup", this.onKeyUp);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.onKeyDown) uIOhook.removeListener("keydown", this.onKeyDown);
    if (this.onKeyUp) uIOhook.removeListener("keyup", this.onKeyUp);
    this.onKeyDown = null;
    this.onKeyUp = null;
    releaseHook();
  }
}
