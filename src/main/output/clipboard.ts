// Clipboard writes that work while another app has focus. On Wayland a client
// can only set the selection when it holds keyboard focus, and Chirp never
// does (its overlay is unfocusable), so Electron's clipboard silently no-ops.
// wl-copy uses the data-control protocol instead, which has no such rule.

import { spawn, spawnSync } from "node:child_process";
import { clipboard } from "electron";

let wlCopy: boolean | undefined;

function hasWlCopy(): boolean {
  if (wlCopy === undefined) {
    wlCopy =
      process.platform === "linux" &&
      Boolean(process.env.WAYLAND_DISPLAY) &&
      spawnSync("wl-copy", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return wlCopy;
}

function viaWlCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // wl-copy returns once it owns the selection; a forked child keeps serving it.
    const proc = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`wl-copy exited ${code}: ${stderr.trim()}`)),
    );
    proc.stdin.end(text);
  });
}

export async function writeClipboardText(text: string): Promise<void> {
  if (hasWlCopy()) {
    try {
      await viaWlCopy(text);
      return;
    } catch (err) {
      console.error("chirp: wl-copy failed, using Electron clipboard:", err);
    }
  }
  await clipboard.writeText(text);
}
