// Try the xdg-desktop-portal GlobalShortcuts hotkey source.

// Usage: npx tsx scripts/try-portal.ts
// (KDE shows a confirmation dialog the first time.)

import { PortalHotkeySource } from "../src/main/input/portal.ts";

const source = new PortalHotkeySource({
  preferredTrigger: "CTRL+space",
  description: "Chirp: hold to dictate",
});

source.on("down", () => console.log("hotkey DOWN"));
source.on("up", () => console.log("hotkey UP"));
source.on("error", (err: unknown) => console.error("error event:", err));

try {
  await source.start();
  console.log("portal started, binding:", source.describe());
} catch (err) {
  console.error("start failed:", err);
  process.exit(1);
}

setTimeout(() => {
  console.log("60 s elapsed, stopping");
  source.stop();
  process.exit(0);
}, 60_000);
