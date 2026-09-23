import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProcDevices,
  parseKeyBitmap,
  decodeEvents,
  keyBitSet,
  HotkeyStateMachine,
} from "../src/main/input/evdev.ts";
import { EVDEV_KEYS, labelForEvdevKey } from "../src/main/input/keycodes.ts";

const SAMPLE = `
I: Bus=0011 Vendor=0001 Product=0001 Version=0441
N: Name="AT Translated Set 2 keyboard"
P: Phys=isa0060/serio0/input0
S: Sysfs=/devices/platform/i8042/serio0/input/input4
U: Uniq=
H: Handlers=sysrq kbd event4 leds
B: EV=120013
B: KEY=2000000000000000 5007d4002000 83067bfc900 ffe57df f ffebefffdffdfffe fffffffffffffffe
B: MSC=10
B: LED=7

I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech USB Receiver Mouse"
P: Phys=usb-0000:00:14.0-3/input0
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb3/3-3/3-3:1.0/0003:046D:C52B.0001/input/input6
U: Uniq=
H: Handlers=sysrq mouse0 event6
B: EV=1b
B: KEY=70000 0 0 0 0 0 0 0 0
B: BUTTON=740
B: REL=143
B: MSC=10

I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=PNP0C0C/button/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXSYBUS:00/PNP0C0C:00/input/input0
U: Uniq=
H: Handlers=kbd event0 powerkbd
B: EV=3
B: KEY=10000000000000 0
B: SW=0

I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech USB Receiver Consumer Control"
P: Phys=usb-0000:00:14.0-3/input1
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb3/3-3/3-3:1.1/0003:046D:C52B.0002/input/input7
U: Uniq=
H: Handlers=sysrq kbd event7
B: EV=12001f
B: KEY=3f0003007f 0 0 483ffff00 aff20df ffe1bfff fffffffe fffffffffffffffe
B: REL=100
B: ABS=100000000
B: MSC=10
`;

test("parseProcDevices keeps keyboards (kbd handler) and drops mice/power button", () => {
  const devices = parseProcDevices(SAMPLE);
  const names = devices.map((d) => d.name);
  assert.ok(names.includes("AT Translated Set 2 keyboard"));
  assert.ok(names.includes("Logitech USB Receiver Consumer Control"));
  assert.ok(!names.some((n) => n.includes("Mouse")));
  assert.ok(!names.includes("Power Button"));
  const kbd = devices.find((d) => d.name === "AT Translated Set 2 keyboard")!;
  assert.equal(kbd.event, "event4");
});

test("parseKeyBitmap + keyBitSet find target codes", () => {
  const kbd = parseProcDevices(SAMPLE).find((d) => d.name === "AT Translated Set 2 keyboard")!;
  assert.ok(kbd.keyBits.size > 0);
  const ralt = EVDEV_KEYS["KEY_RIGHTALT"];
  assert.ok(typeof ralt === "number");
  // Synthetic check: build bitmap words with KEY_RIGHTALT (code 100) = word 1, bit 36.
  const words = [0n, 1n << 36n];
  assert.equal(keyBitSet(words, ralt), true);
  assert.equal(keyBitSet(words, 99), false); // KEY_F17
});

test("keyBitSet: lowest word holds the lowest bits", () => {
  // KEY_A = 30 → lowest word, bit 30; KEY_F14 (code 92) = word 1, bit 28.
  const words = [1n << 30n, 1n << 28n, 0n];
  assert.equal(keyBitSet(words, 30), true);
  assert.equal(keyBitSet(words, 92), true);
  assert.equal(keyBitSet(words, 62), false);
});

test("bitmap string parses with rightmost word low", () => {
  const words = parseKeyBitmap("40 80000000");
  // rightmost word 80000000 = bit 31; left word 40 = bit 74.
  assert.equal(keyBitSet(words, 31), true);
  assert.equal(keyBitSet(words, 70), true);
  assert.equal(keyBitSet(words, 32), false);
});

test("decodeEvents handles split buffers", () => {
  const ev = (type: number, code: number, value: number): Buffer => {
    const b = Buffer.alloc(24);
    b.writeBigInt64LE(0n, 0);
    b.writeBigInt64LE(1n, 8);
    b.writeUInt16LE(type, 16);
    b.writeUInt16LE(code, 18);
    b.writeInt32LE(value, 20);
    return b;
  };
  const buf = Buffer.concat([ev(1, 100, 1), ev(1, 47, 1), ev(0, 0, 0), ev(1, 100, 0).subarray(0, 10)]);
  const first = decodeEvents(buf);
  assert.deepEqual(
    first.events.map((e) => [e.type, e.code, e.value]),
    [[1, 100, 1], [1, 47, 1], [0, 0, 0]],
  );
  assert.equal(first.rest.length, 10);
  const second = decodeEvents(Buffer.concat([first.rest, ev(1, 100, 0).subarray(10)]));
  assert.deepEqual(
    second.events.map((e) => [e.type, e.code, e.value]),
    [[1, 100, 0]],
  );
});

test("hold/chord/repeat/multi-keyboard state machine", () => {
  const RALT = EVDEV_KEYS["KEY_RIGHTALT"];
  const V = EVDEV_KEYS["KEY_V"];
  const sm = new HotkeyStateMachine(RALT);

  assert.equal(sm.feed(1, RALT, 1), "down");
  // auto-repeat of target: nothing
  assert.equal(sm.feed(1, RALT, 2), null);
  assert.equal(sm.feed(1, RALT, 2), null);
  // AltGr+V for @: chord fires exactly once
  assert.equal(sm.feed(1, V, 1), "chord");
  assert.equal(sm.feed(1, V, 2), null);
  assert.equal(sm.feed(1, V, 0), null);
  assert.equal(sm.feed(1, EVDEV_KEYS["KEY_A"], 1), null); // second chord suppressed
  assert.equal(sm.feed(1, RALT, 0), "up");
  // after release, another hold works and chords again
  assert.equal(sm.feed(1, RALT, 1), "down");
  assert.equal(sm.feed(1, EVDEV_KEYS["KEY_C"], 1), "chord");
  assert.equal(sm.feed(1, RALT, 0), "up");
});

test("state machine handles two keyboards holding simultaneously", () => {
  const RALT = EVDEV_KEYS["KEY_RIGHTALT"];
  const sm = new HotkeyStateMachine(RALT);
  assert.equal(sm.feed(1, RALT, 1), "down"); // keyboard 1
  assert.equal(sm.feed(1, RALT, 1), null); // keyboard 2 press: no second down
  assert.equal(sm.feed(1, RALT, 0), null); // keyboard 1 release: still held
  assert.equal(sm.feed(1, EVDEV_KEYS["KEY_A"], 1), "chord"); // still counts as held
  assert.equal(sm.feed(1, RALT, 0), "up"); // final release
});

test("mouse buttons are not chords", () => {
  const RALT = EVDEV_KEYS["KEY_RIGHTALT"];
  const sm = new HotkeyStateMachine(RALT);
  assert.equal(sm.feed(1, RALT, 1), "down");
  assert.equal(sm.feed(1, 0x110, 1), null); // BTN_LEFT press while held
  assert.equal(sm.feed(1, 0x111, 1), null); // BTN_RIGHT
  assert.equal(sm.feed(1, 0x110, 0), null);
  assert.equal(sm.feed(1, RALT, 0), "up");
});

test("forceRelease emits up when held", () => {
  const RALT = EVDEV_KEYS["KEY_RIGHTALT"];
  const sm = new HotkeyStateMachine(RALT);
  sm.feed(1, RALT, 1);
  assert.equal(sm.forceRelease(), "up");
  assert.equal(sm.forceRelease(), null);
  assert.equal(sm.feed(1, RALT, 1), "down"); // usable again afterwards
});

test("friendly labels", () => {
  assert.equal(labelForEvdevKey("KEY_RIGHTALT"), "Right Alt");
  assert.equal(labelForEvdevKey("KEY_F13"), "F13");
  assert.equal(labelForEvdevKey("KEY_A"), "A");
  assert.equal(labelForEvdevKey("KEY_1"), "1");
  assert.equal(labelForEvdevKey("KEY_SPACE"), "Space");
  assert.equal(labelForEvdevKey("KEY_PAGE_DOWN"), "Page Down");
});
