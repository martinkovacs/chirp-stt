// Try the Linux virtual keyboard: opens /dev/uinput, waits 3 s, then types "hi".

import { KEY_H, KEY_I, VirtualKeyboard } from "../src/main/output/uinput.ts";

if (!VirtualKeyboard.available()) {
  console.error("/dev/uinput is not writable on this system");
  process.exit(1);
}

const keyboard = new VirtualKeyboard();
keyboard.open([KEY_H, KEY_I]);
console.log("device created, waiting 3 s ...");
await new Promise((resolve) => setTimeout(resolve, 3_000));
await keyboard.tap([KEY_H]);
await keyboard.tap([KEY_I]);
keyboard.close();
console.log("done");
process.exit(0);
