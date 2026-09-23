// Linux virtual keyboard through /dev/uinput, driven via libc ioctls with koffi.
// This module never touches Electron so it can be unit-tested under node --test.

import koffi from "koffi";
import { accessSync, constants as fsConstants } from "node:fs";
import type { PasteCombo } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// evdev constants (linux/input-event-codes.h)
// ---------------------------------------------------------------------------

export const EV_SYN = 0;
export const EV_KEY = 1;
export const SYN_REPORT = 0;
export const BUS_USB = 0x03;

export const KEY_LEFTCTRL = 29;
export const KEY_LEFTSHIFT = 42;
export const KEY_V = 47;
export const KEY_I = 23;
export const KEY_H = 35;
export const KEY_INSERT = 110;

/** Modifier + key codes enabled on the device so every paste combo can tap. */
export const UINPUT_KEYS = [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V, KEY_INSERT];

export function pasteComboKeys(combo: PasteCombo): number[] {
  switch (combo) {
    case "ctrl+v":
      return [KEY_LEFTCTRL, KEY_V];
    case "ctrl+shift+v":
      return [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V];
    case "shift+insert":
      return [KEY_LEFTSHIFT, KEY_INSERT];
  }
}

// ---------------------------------------------------------------------------
// ioctl request numbers (asm-generic/ioctl.h): bits 30..31 dir, 16..29 size,
// 8..15 type, 0..7 nr. Same layout on x86_64 and arm64.
// ---------------------------------------------------------------------------

const IOC_NRSHIFT = 0;
const IOC_TYPESHIFT = 8;
const IOC_SIZESHIFT = 16;
const IOC_DIRSHIFT = 30;
export const IOC_NONE = 0;
export const IOC_WRITE = 1;
export const IOC_READ = 2;

export function ioc(dir: number, type: number, nr: number, size: number): number {
  return (dir << IOC_DIRSHIFT) | (size << IOC_SIZESHIFT) | (type << IOC_TYPESHIFT) | (nr << IOC_NRSHIFT);
}
export const _IOW = (type: number, nr: number, size: number): number => ioc(IOC_WRITE, type, nr, size);
export const _IOR = (type: number, nr: number, size: number): number => ioc(IOC_READ, type, nr, size);
export const _IO = (type: number, nr: number): number => ioc(IOC_NONE, type, nr, 0);

const _U = "U".charCodeAt(0);
export const UI_SET_EVBIT = _IOW(_U, 100, 4);
export const UI_SET_KEYBIT = _IOW(_U, 101, 4);
export const UI_DEV_CREATE = _IO(_U, 1);
export const UI_DEV_DESTROY = _IO(_U, 2);

/** struct uinput_setup: input_id (8) + char name[80] + ff_effects_max (4). */
export const UI_DEV_SETUP_SIZE = 92;
export const UI_DEV_SETUP = _IOW(_U, 3, UI_DEV_SETUP_SIZE);

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

/** struct input_event: 64-bit timeval (zeroed) + u16 type + u16 code + s32 value. */
export const INPUT_EVENT_SIZE = 24;

export function encodeInputEvent(type: number, code: number, value: number): Buffer {
  const buf = Buffer.alloc(INPUT_EVENT_SIZE);
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  return buf;
}

export function encodeUinputSetup(
  name: string,
  vendor: number,
  product: number,
  version: number,
  ffEffectsMax = 0,
): Buffer {
  const buf = Buffer.alloc(UI_DEV_SETUP_SIZE);
  buf.writeUInt16LE(BUS_USB, 0); // input_id.bustype
  buf.writeUInt16LE(vendor, 2);
  buf.writeUInt16LE(product, 4);
  buf.writeUInt16LE(version, 6);
  buf.write(name.slice(0, 79), 8, 79, "utf8"); // name[80], nul-padded by alloc
  buf.writeUInt32LE(ffEffectsMax, 88);
  return buf;
}

// ---------------------------------------------------------------------------
// libc bindings (lazily loaded so importing this module stays cheap)
// ---------------------------------------------------------------------------

const UINPUT_PATH = "/dev/uinput";
const O_WRONLY = 1;
const O_NONBLOCK = 0x800;
const O_CLOEXEC = 0x80000;

const DEVICE_SETTLE_MS = 300;
const KEY_GAP_MS = 8;

interface LibcFunctions {
  open(path: string, flags: number, mode: number): number;
  ioctlInt(fd: number, request: number, arg: number): number;
  ioctlPtr(fd: number, request: number, buf: Buffer): number;
  write(fd: number, buf: Buffer, count: number): number;
  close(fd: number): number;
}

let libc: LibcFunctions | null = null;

function loadLibc(): LibcFunctions {
  if (libc) return libc;
  const lib = koffi.load(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6");
  libc = {
    open: lib.func("int open(const char *path, int flags, int mode)"),
    ioctlInt: lib.func("int ioctl(int fd, unsigned long request, int arg)"),
    ioctlPtr: lib.func("int ioctl(int fd, unsigned long request, const void *arg)"),
    write: lib.func("long write(int fd, const void *buf, unsigned long count)"),
    close: lib.func("int close(int fd)"),
  };
  return libc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// VirtualKeyboard
// ---------------------------------------------------------------------------

export class VirtualKeyboard {
  private fd = -1;
  private createdAt = 0;

  get isOpen(): boolean {
    return this.fd >= 0;
  }

  static available(): boolean {
    if (process.platform !== "linux") return false;
    try {
      accessSync(UINPUT_PATH, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Creates the /dev/uinput device with the given keys enabled. Throws on failure. */
  open(keys: number[]): void {
    if (this.isOpen) throw new Error("VirtualKeyboard is already open");
    const lib = loadLibc();
    const fd = lib.open(UINPUT_PATH, O_WRONLY | O_NONBLOCK | O_CLOEXEC, 0);
    if (fd < 0) throw new Error(`open(${UINPUT_PATH}) failed (missing write permission?)`);
    this.doIoctl(fd, UI_SET_EVBIT, EV_KEY);
    this.doIoctl(fd, UI_SET_EVBIT, EV_SYN);
    for (const key of keys) this.doIoctl(fd, UI_SET_KEYBIT, key);
    this.doBufferIoctl(fd, UI_DEV_SETUP, encodeUinputSetup("Chirp virtual keyboard", 0x1234, 0x0043, 1));
    this.doBufferIoctl(fd, UI_DEV_CREATE, Buffer.alloc(0));
    this.fd = fd;
    this.createdAt = Date.now();
  }

  private doIoctl(fd: number, request: number, arg: number): void {
    const ret = loadLibc().ioctlInt(fd, request, arg);
    if (ret < 0) throw new Error(`ioctl(0x${request.toString(16)}, arg ${arg}) failed (ret ${ret})`);
  }

  private doBufferIoctl(fd: number, request: number, buf: Buffer): void {
    const ret = loadLibc().ioctlPtr(fd, request, buf);
    if (ret < 0) throw new Error(`ioctl(0x${request.toString(16)}) failed (ret ${ret})`);
  }

  /** Press+release, waiting for the compositor to register a freshly created device. */
  async tap(combo: number[]): Promise<void> {
    if (!this.isOpen) throw new Error("VirtualKeyboard is not open");
    const settle = DEVICE_SETTLE_MS - (Date.now() - this.createdAt);
    if (settle > 0) await sleep(settle);
    for (const code of combo) {
      this.emit(EV_KEY, code, 1);
      await sleep(KEY_GAP_MS);
    }
    for (const code of [...combo].reverse()) {
      this.emit(EV_KEY, code, 0);
      await sleep(KEY_GAP_MS);
    }
  }

  /** Writes a KEY event followed by the SYN_REPORT synchroniser. */
  private emit(type: number, code: number, value: number): void {
    const buf = Buffer.concat([encodeInputEvent(type, code, value), encodeInputEvent(EV_SYN, SYN_REPORT, 0)]);
    const n = loadLibc().write(this.fd, buf, buf.length);
    if (n !== buf.length) throw new Error(`write to /dev/uinput failed (wrote ${n})`);
  }

  close(): void {
    if (!this.isOpen) return;
    const lib = loadLibc();
    try {
      lib.ioctlInt(this.fd, UI_DEV_DESTROY, 0);
    } catch {
      // ignore — device use-after-close is harmless here
    }
    lib.close(this.fd);
    this.fd = -1;
    this.createdAt = 0;
  }
}
