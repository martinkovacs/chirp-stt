// KDE Plasma (Wayland) ignores Electron's focusable:false, alwaysOnTop and
// setBounds for the overlay: KWin activates it on show, so the simulated
// Ctrl+V lands in the overlay instead of the user's app. A KWin window rule
// is the supported way to fix that: never accept focus, keep above, fixed
// position at the bottom centre. Written once to ~/.config/kwinrulesrc.

import { spawnSync } from "node:child_process";

const RULE_ID = "chirp-stt-overlay";
const FILE = "kwinrulesrc";

export function isKdeWayland(): boolean {
  return (
    process.platform === "linux" &&
    Boolean(process.env.WAYLAND_DISPLAY) &&
    (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("KDE")
  );
}

function read(group: string, key: string): string {
  const r = spawnSync("kreadconfig6", ["--file", FILE, "--group", group, "--key", key], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function write(group: string, key: string, value: string, type?: "bool" | "int"): void {
  const args = ["--file", FILE, "--group", group, "--key", key];
  if (type) args.push("--type", type);
  args.push(value);
  const r = spawnSync("kwriteconfig6", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`kwriteconfig6 ${group}/${key} failed: ${r.stderr || r.error}`);
}

/**
 * Installs or updates the overlay rule. `x`/`y` are the overlay's top-left in
 * global logical coordinates. Returns true if KWin was told to reload.
 */
export function ensureOverlayRule(opts: { title: string; x: number; y: number }): boolean {
  if (!isKdeWayland()) return false;
  try {
    const position = `${opts.x},${opts.y}`;
    const rules = read("General", "rules").split(",").filter(Boolean);
    const upToDate =
      rules.includes(RULE_ID) &&
      read(RULE_ID, "position") === position &&
      read(RULE_ID, "acceptfocus") === "false" &&
      read(RULE_ID, "title") === opts.title;
    if (upToDate) return false;

    const values: [string, string, ("bool" | "int")?][] = [
      ["Description", "Chirp dictation overlay"],
      // Match on the title only: the Wayland app id differs between dev
      // (electron) and packaged builds.
      ["wmclassmatch", "0", "int"], // unimportant
      ["title", opts.title],
      ["titlematch", "1", "int"], // exact
      ["acceptfocus", "false", "bool"],
      ["acceptfocusrule", "2", "int"], // force
      ["above", "true", "bool"],
      ["aboverule", "2", "int"],
      ["position", position],
      ["positionrule", "2", "int"],
      ["skiptaskbar", "true", "bool"],
      ["skiptaskbarrule", "2", "int"],
      ["skipswitcher", "true", "bool"],
      ["skipswitcherrule", "2", "int"],
      ["skippager", "true", "bool"],
      ["skippagerrule", "2", "int"],
    ];
    for (const [key, value, type] of values) write(RULE_ID, key, value, type);
    if (!rules.includes(RULE_ID)) {
      rules.push(RULE_ID);
      write("General", "rules", rules.join(","));
      write("General", "count", String(rules.length), "int");
    }
    spawnSync("qdbus6", ["org.kde.KWin", "/KWin", "reconfigure"], { stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn("[kwin] could not install overlay window rule:", err);
    return false;
  }
}
