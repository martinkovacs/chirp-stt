import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EV_SYN,
  EV_KEY,
  INPUT_EVENT_SIZE,
  UI_DEV_CREATE,
  UI_DEV_DESTROY,
  UI_DEV_SETUP,
  UI_DEV_SETUP_SIZE,
  UI_SET_EVBIT,
  UI_SET_KEYBIT,
  VirtualKeyboard,
  encodeInputEvent,
  encodeUinputSetup,
  pasteComboKeys,
} from "../src/main/output/uinput.ts";
import { Paster, pasteComboUiohook } from "../src/main/output/paster.ts";
import type { PasteCombo } from "../src/shared/types.ts";

test("ioctl request numbers match the known uinput values", () => {
  assert.equal(UI_SET_EVBIT, 0x40045564);
  assert.equal(UI_SET_KEYBIT, 0x40045565);
  assert.equal(UI_DEV_CREATE, 0x5501);
  assert.equal(UI_DEV_DESTROY, 0x5502);
  assert.equal(UI_DEV_SETUP, 0x405c5503);
});

test("input_event encoding: 24 bytes, zeroed timeval, LE type/code/value", () => {
  const buf = encodeInputEvent(EV_KEY, 47, 1);
  assert.equal(buf.length, INPUT_EVENT_SIZE);
  for (let i = 0; i < 16; i++) assert.equal(buf[i], 0, "timeval must be zeroed");
  assert.equal(buf.readUInt16LE(16), EV_KEY);
  assert.equal(buf.readUInt16LE(18), 47);
  assert.equal(buf.readInt32LE(20), 1);
});

test("uinput_setup encoding: 92 bytes, USB id, padded name", () => {
  const buf = encodeUinputSetup("Chirp virtual keyboard", 0x1234, 0x0043, 1);
  assert.equal(buf.length, UI_DEV_SETUP_SIZE);
  assert.equal(buf.readUInt16LE(0), 0x03); // bustype BUS_USB
  assert.equal(buf.readUInt16LE(2), 0x1234); // vendor
  assert.equal(buf.readUInt16LE(4), 0x0043); // product
  assert.equal(buf.readUInt16LE(6), 1); // version
  assert.equal(buf.subarray(8, 8 + "Chirp virtual keyboard".length).toString("utf8"), "Chirp virtual keyboard");
  for (let i = 8 + "Chirp virtual keyboard".length; i < 88; i++) assert.equal(buf[i], 0, "name padding");
  assert.equal(buf.readUInt32LE(88), 0); // ff_effects_max
});

test("names longer than 80 bytes are truncated, not spilled", () => {
  const buf = encodeUinputSetup("x".repeat(120), 0, 0, 0);
  assert.equal(buf.length, UI_DEV_SETUP_SIZE);
  // 79 chars + terminating NUL within the 80-byte name field
  assert.equal(buf.subarray(8, 87).toString("utf8").length, 79);
  assert.equal(buf[87], 0);
});

test("paste combos map to evdev codes", () => {
  assert.deepEqual(pasteComboKeys("ctrl+v" as PasteCombo), [29, 47]);
  assert.deepEqual(pasteComboKeys("ctrl+shift+v" as PasteCombo), [29, 42, 47]);
  assert.deepEqual(pasteComboKeys("shift+insert" as PasteCombo), [42, 110]);
});

test("paste combos map to uiohook keys", () => {
  assert.deepEqual(pasteComboUiohook("ctrl+v", "linux"), { key: 47, modifiers: [29] });
  assert.deepEqual(pasteComboUiohook("ctrl+v", "darwin"), { key: 47, modifiers: [3675] }); // Meta
  assert.deepEqual(pasteComboUiohook("ctrl+shift+v", "linux"), { key: 47, modifiers: [29, 42] });
  assert.deepEqual(pasteComboUiohook("shift+insert", "win32"), { key: 3666, modifiers: [42] });
});

test("Paster always writes the clipboard and reports the method", async () => {
  const written: string[] = [];
  const paster = new Paster({ writeClipboard: (text) => written.push(text) });
  const result = await paster.paste("hü", { mode: "clipboard", combo: "ctrl+v" });
  assert.deepEqual(written, ["hü"]);
  assert.deepEqual(result, { method: "clipboard" });
  paster.dispose();
});

test("VirtualKeyboard.reopen guard and close idempotence (real /dev/uinput)", () => {
  if (!VirtualKeyboard.available()) return; // skip outside a writable Linux box
  const kb = new VirtualKeyboard();
  kb.open([29, 47, 42, 110]);
  assert.equal(kb.isOpen, true);
  assert.throws(() => kb.open([29]), /already open/);
  kb.close();
  assert.equal(kb.isOpen, false);
  kb.close(); // second close is a no-op
});
