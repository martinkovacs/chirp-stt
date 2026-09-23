// Text output: always copies to the clipboard, then optionally simulates a
// paste keystroke so the text lands in the focused window. No direct electron
// imports — the caller injects clipboard.writeText.

import type { OutputMode, PasteCombo } from "../../shared/types.ts";
import { UINPUT_KEYS, VirtualKeyboard, pasteComboKeys } from "./uinput.ts";
import { UiohookKey, uIOhook } from "uiohook-napi";
import type { EventEmitter } from "node:events";

export interface PasterDeps {
  /** e.g. electron clipboard.writeText; injected to keep this module Electron-free. */
  writeClipboard: (text: string) => void | Promise<void>;
}

export interface PasteResult {
  method: "uinput" | "uiohook" | "clipboard";
}

export interface PasteOptions {
  mode: OutputMode;
  combo: PasteCombo;
}

export function pasteComboUiohook(
  combo: PasteCombo,
  platform: NodeJS.Platform = process.platform,
): { key: number; modifiers: number[] } {
  const ctrlLike = platform === "darwin" ? UiohookKey.Meta : UiohookKey.Ctrl;
  switch (combo) {
    case "ctrl+v":
      return { key: UiohookKey.V, modifiers: [ctrlLike] };
    case "ctrl+shift+v":
      return { key: UiohookKey.V, modifiers: [ctrlLike, UiohookKey.Shift] };
    case "shift+insert":
      return { key: UiohookKey.Insert, modifiers: [UiohookKey.Shift] };
  }
}

/** True when the app runs under X11 (uiohook works there; not on native Wayland). */
export function isX11Session(): boolean {
  const t = process.env.XDG_SESSION_TYPE;
  if (t === "x11") return true;
  if (t === "wayland") return false;
  return Boolean(process.env.DISPLAY) && !process.env.WAYLAND_DISPLAY;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLIPBOARD_SETTLE_MS = 80;

export class Paster {
  private readonly deps: PasterDeps;
  private keyboard: VirtualKeyboard | null = null;

  constructor(deps: PasterDeps) {
    this.deps = deps;
  }

  async paste(text: string, opts: PasteOptions): Promise<PasteResult> {
    await this.deps.writeClipboard(text); // clipboard owner must be established before pasting
    if (opts.mode !== "paste") return { method: "clipboard" };

    if (process.platform === "linux" && VirtualKeyboard.available()) {
      try {
        this.ensureKeyboard();
        await sleep(CLIPBOARD_SETTLE_MS);
        await this.keyboard!.tap(pasteComboKeys(opts.combo));
        return { method: "uinput" };
      } catch (err) {
        console.error("chirp: uinput paste failed, falling back to clipboard:", err);
      }
    }

    // Simulated input via uiohook on win32/darwin and Linux X11.
    if (process.platform !== "linux" || isX11Session()) {
      try {
        const { key, modifiers } = pasteComboUiohook(opts.combo, process.platform);
        uIOhook.keyTap(key, modifiers);
        return { method: "uiohook" };
      } catch (err) {
        console.error("chirp: uiohook paste failed, falling back to clipboard:", err);
      }
    }

    return { method: "clipboard" };
  }

  /** Creates the virtual keyboard up front so the first paste doesn't wait for the compositor to pick it up. */
  prepare(): void {
    if (process.platform !== "linux" || !VirtualKeyboard.available()) return;
    try {
      this.ensureKeyboard();
    } catch (err) {
      console.error("chirp: could not create uinput keyboard:", err);
    }
  }

  private ensureKeyboard(): void {
    if (!this.keyboard) {
      this.keyboard = new VirtualKeyboard();
      // Keep the device open for the app lifetime; Paster.dispose() closes it.
      this.keyboard.open(UINPUT_KEYS);
    }
  }

  dispose(): void {
    this.keyboard?.close();
    this.keyboard = null;
  }
}
