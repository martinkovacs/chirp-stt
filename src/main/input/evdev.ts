import fs from "node:fs";
import { closeSync, openSync, readSync } from "node:fs";
import EventEmitter from "node:events";
import type { HotkeySource } from "./types.ts";
import { EVDEV_KEYS, labelForEvdevKey } from "./keycodes.ts";

/** Size of struct input_event on 64-bit Linux: timeval(2×i64) + type u16 + code u16 + value i32. */
export const EVENT_SIZE = 24;
const EV_KEY = 1;
const RESCAN_INTERVAL_MS = 3000;
// Devices are opened O_NONBLOCK and drained on a short timer: blocking reads
// would each pin a libuv threadpool thread for the lifetime of the app.
const POLL_INTERVAL_MS = 8;

export interface ProcDevice {
  name: string;
  /** "eventN" handler name. */
  event: string;
  /** Key codes this device reports capability for (from B: KEY=). */
  keyBits: Set<number>;
}

export interface EvdevEvent {
  type: number;
  code: number;
  value: number;
}

/** Parse the B: KEY= hex bitmap. Words are 64-bit hex, left word = highest bits. */
export function parseKeyBitmap(bkey: string): bigint[] {
  const body = bkey.includes("=") ? bkey.slice(bkey.indexOf("=") + 1) : bkey;
  const words = body.trim().split(/\s+/).filter(Boolean);
  // Reverse so index i = bits i*64..i*64+63 (lowest bits first).
  return words.map((w) => BigInt("0x" + w)).reverse();
}

export function keyBitSet(keyBits: bigint[], code: number): boolean {
  const wi = code >>> 6;
  if (wi >= keyBits.length) return false;
  return (keyBits[wi]! & (1n << BigInt(code & 63))) !== 0n;
}

/**
 * Parse /proc/bus/input/devices. Returns devices that have an eventN handler and a
 * 'kbd' handler entry (keyboards and keyboard-ish "Consumer Control" devices).
 * Power buttons and mice (no 'kbd') are excluded.
 */
export function parseProcDevices(text: string): ProcDevice[] {
  const devices: ProcDevice[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const name = lines.find((l) => l.startsWith("N: "))?.split("=")[1]?.trim() ?? "";
    const handlers = lines.find((l) => l.startsWith("H: Handlers="));
    const bkey = lines.find((l) => l.startsWith("B: KEY="));
    if (!handlers || !bkey) continue;
    const eventMatch = handlers.match(/event(\d+)/);
    if (!eventMatch) continue;
    if (!/\bkbd\b/.test(handlers)) continue;
    const keyBits = parseKeyBitmap(bkey);
    const set = new Set<number>();
    keyBits.forEach((w, wi) => {
      for (let bi = 0; w >> BigInt(bi) !== 0n && bi < 64; bi++) {
        if ((w & (1n << BigInt(bi))) !== 0n) set.add(wi * 64 + bi);
      }
    });
    // Power buttons and similar single-key devices have only a few key bits;
    // real keyboards (incl. Consumer Control) report many.
    if (set.size < 4) continue;
    devices.push({ name: name.replace(/^"|"$/g, ""), event: `event${eventMatch[1]}`, keyBits: set });
  }
  return devices;
}

/**
 * Decode a buffer of struct input_event (24 bytes each, little endian).
 * Returns decoded events and the trailing partial event to prepend to the next chunk.
 */
export function decodeEvents(buf: Buffer): { events: EvdevEvent[]; rest: Buffer } {
  const events: EvdevEvent[] = [];
  const whole = Math.floor(buf.length / EVENT_SIZE);
  for (let i = 0; i < whole; i++) {
    const off = i * EVENT_SIZE;
    events.push({
      type: buf.readUInt16LE(off + 16),
      code: buf.readUInt16LE(off + 18),
      value: buf.readInt32LE(off + 20),
    });
  }
  return { events, rest: Buffer.from(buf.subarray(whole * EVENT_SIZE)) };
}

export type HotkeyTransition = "down" | "up" | "chord" | null;

/**
 * Pure state machine for hold/chord tracking across multiple devices.
 * - "down" on first press of the target key (repeats never re-emit)
 * - "up" on final release
 * - "chord" (once per hold) when any other key is pressed while held
 */
export class HotkeyStateMachine {
  private count = 0;
  private chordEmitted = false;

  private targetCode: number;

  constructor(targetCode: number) {
    this.targetCode = targetCode;
  }

  /** Feed one event. Returns the transition to emit, if any. */
  feed(type: number, code: number, value: number): HotkeyTransition {
    if (type !== EV_KEY) return null;
    if (code >= 0x100) return null; // BTN_* and other high codes are not chords
    if (code === this.targetCode) {
      if (value === 1) {
        this.count++;
        return this.count === 1 && !this.chordEmitted ? "down" : null;
      }
      if (value === 0) {
        if (this.count === 0) return null;
        this.count--;
        if (this.count === 0) {
          this.chordEmitted = false;
          return "up";
        }
      }
      return null; // value 2 = auto-repeat
    }
    if (this.count > 0 && value === 1 && !this.chordEmitted) {
      this.chordEmitted = true;
      return "chord";
    }
    return null;
  }

  /** A device vanished while holding the key: treat it as released. */
  forceRelease(): HotkeyTransition {
    if (this.count > 0) {
      this.count = 0;
      this.chordEmitted = false;
      return "up";
    }
    return null;
  }

  get held(): boolean {
    return this.count > 0;
  }
}

export class EvdevPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvdevPermissionError";
  }
}

interface OpenKeyboard {
  event: string;
  name: string;
  fd: number;
  remainder: Buffer;
}

export class EvdevHotkeySource extends EventEmitter implements HotkeySource {
  readonly kind = "evdev" as const;
  private readonly keyName: string;
  private readonly keyCode: number;
  private state: HotkeyStateMachine;
  private devices: OpenKeyboard[] = [];
  private rescanTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly readBuf = Buffer.alloc(EVENT_SIZE * 64);
  private stopped = true;

  constructor(opts: { key: string }) {
    super();
    const code = EVDEV_KEYS[opts.key];
    if (code === undefined) {
      throw new Error(`Unknown evdev key name: ${opts.key}`);
    }
    this.keyName = opts.key;
    this.keyCode = code;
    this.state = new HotkeyStateMachine(code);
  }

  describe(): string {
    return labelForEvdevKey(this.keyName);
  }

  async start(): Promise<void> {
    const devices = this.scan();
    if (devices.length === 0) {
      throw new Error(
        `No keyboard device reporting "${this.describe()}" was found in /proc/bus/input/devices`,
      );
    }
    const opened: OpenKeyboard[] = [];
    let permissionFailure = false;
    for (const dev of devices) {
      const result = this.openDevice(dev);
      if (result === "eacces") {
        permissionFailure = true;
      } else if (result) {
        opened.push(result);
      }
    }
    if (opened.length === 0) {
      if (permissionFailure) {
        throw new EvdevPermissionError(
          `Cannot read /dev/input event devices (EACCES). Add your user to the 'input' group: ` +
            `\`sudo usermod -aG input $USER\`, then log out and back in.`,
        );
      }
      throw new Error(`No keyboard device reporting "${this.describe()}" could be opened`);
    }
    this.devices = opened;
    this.state = new HotkeyStateMachine(this.keyCode);
    this.stopped = false;
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const dev of this.devices) {
      try {
        closeSync(dev.fd);
      } catch {
        // already gone
      }
    }
    this.devices = [];
  }

  /** Rescan /proc/bus/input/devices, returns matching devices. Exported for tests. */
  scan(): { name: string; event: string; keyBits: Set<number> }[] {
    let text: string;
    try {
      text = fs.readFileSync("/proc/bus/input/devices", "utf8");
    } catch {
      return [];
    }
    const target = this.keyCode;
    return parseProcDevices(text).filter((d) => keyBitSet(parseKeyBitmapBits(d), target));
  }

  private openDevice(dev: ProcDevice): OpenKeyboard | "eacces" | null {
    const path = `/dev/input/${dev.event}`;
    let fd: number;
    try {
      fd = openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EACCES") return "eacces";
      return null;
    }
    return { event: dev.event, name: dev.name, fd, remainder: Buffer.alloc(0) };
  }

  private poll(): void {
    if (this.stopped) return;
    for (const kb of [...this.devices]) {
      for (;;) {
        let n: number;
        try {
          n = readSync(kb.fd, this.readBuf, 0, this.readBuf.length, null);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EAGAIN") this.dropDevice(kb);
          break;
        }
        if (n <= 0) break;
        this.onData(kb, this.readBuf.subarray(0, n));
        if (n < this.readBuf.length) break;
      }
    }
  }

  private onData(kb: OpenKeyboard, chunk: Buffer): void {
    const buf = kb.remainder.length ? Buffer.concat([kb.remainder, chunk]) : chunk;
    const { events, rest } = decodeEvents(buf);
    kb.remainder = Buffer.from(rest);
    for (const ev of events) {
      const t = this.state.feed(ev.type, ev.code, ev.value);
      if (t) this.emit(t);
    }
  }

  /**
   * Drop a device whose read failed (e.g. unplugged).
   * We do not track per-device hold counts, so force-release only when
   * no other device remains that could still be holding the key.
   */
  private dropDevice(kb: OpenKeyboard): void {
    const idx = this.devices.indexOf(kb);
    if (idx === -1) return;
    this.devices.splice(idx, 1);
    try {
      closeSync(kb.fd);
    } catch {
      // already gone
    }
    if (this.devices.length === 0 && this.state.held) {
      const t = this.state.forceRelease();
      if (t) this.emit(t);
    }
  }

  private rescan(): void {
    if (this.stopped) return;
    const known = new Set(this.devices.map((d) => d.event));
    for (const dev of this.scan()) {
      if (known.has(dev.event)) continue;
      const result = this.openDevice(dev);
      if (result && result !== "eacces") this.devices.push(result);
    }
  }
}

export function evdevAccessible(): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync("/dev/input");
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!/^event\d+$/.test(e)) continue;
    try {
      fs.accessSync(`/dev/input/${e}`, fs.constants.R_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// helper: convert {keyBits:Set<number>} device rows back into bigint words for keyBitSet
function parseKeyBitmapBits(d: { keyBits: Set<number> }): bigint[] {
  const words: bigint[] = [];
  for (const bit of d.keyBits) {
    const wi = bit >>> 6;
    while (words.length <= wi) words.push(0n);
    words[wi]! |= 1n << BigInt(bit & 63);
  }
  return words;
}
