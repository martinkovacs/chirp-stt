import { fork } from "node:child_process";
import { utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { BackendChoice, ComputeBackend, DecodeOptions, FromWorker, ToWorker } from "../../shared/types.ts";

export interface FinalResult {
  text: string;
  audioMs: number;
  decodeMs: number;
}

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

const STOP_TIMEOUT_MS = 30_000;
const BACKENDS_TIMEOUT_MS = 10_000;

/** Rejects a load() that a newer load() replaced. */
export class SupersededError extends Error {
  constructor() {
    super("Superseded by another load");
  }
}

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL("./stt-worker.js", import.meta.url));
}

/**
 * The worker transport, hiding Electron's utilityProcess vs a Node.js
 * child_process fork behind one tiny surface.
 */
interface WorkerProc {
  post(msg: ToWorker): void;
  kill(): void;
  onMessage(cb: (msg: FromWorker) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

function electronProc(workerPath: string): WorkerProc {
  const proc = utilityProcess.fork(workerPath, [], { serviceName: "chirp-stt", stdio: "inherit" });
  return {
    post: (msg) => proc.postMessage(msg),
    kill: () => proc.kill(),
    onMessage: (cb) => proc.on("message", (msg: FromWorker) => cb(msg)),
    onExit: (cb) => proc.on("exit", (code) => cb(code, null)),
  };
}

function nodeProc(workerPath: string, nodePath: string): WorkerProc {
  // A plain Node.js child must not inherit Electron flag variables, and must
  // not read the script from inside app.asar (the caller already unpacked it).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(workerPath, [], {
    execPath: nodePath,
    // "advanced" keeps Float32Array audio intact across the channel.
    serialization: "advanced",
    stdio: "inherit",
    env,
    execArgv: [],
    // node.exe is a console program; don't flash a window on Windows.
    windowsHide: true,
  });
  let ended = false;
  let onMessage: (msg: FromWorker) => void = () => {};
  let onEnd: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  child.on("message", (msg: FromWorker) => onMessage(msg));
  child.on(
    "exit",
    (code, signal) => {
      if (ended) return;
      ended = true;
      onEnd(code, signal ?? null);
    },
  );
  // "error" fires for a failed spawn (no "exit" will follow) and for IPC/kill
  // errors on a live child ("exit" still follows); only end early for the former.
  // A failed kill() emits "error" synchronously; `stopping` stops the recursion.
  let stopping = false;
  child.on("error", () => {
    if (ended) return;
    if (child.pid === undefined) {
      ended = true;
      onEnd(null, null);
    } else if (!stopping) {
      stopping = true;
      child.kill();
    }
  });
  return {
    post: (msg) => {
      try {
        child.send(msg);
      } catch {
        /* channel already closed; the crash handling respawns */
      }
    },
    kill: () => child.kill(),
    onMessage: (cb) => (onMessage = cb),
    onExit: (cb) => (onEnd = cb),
  };
}

/** Plain Node.js cannot read inside the asar archive; packaging unpacks it. */
function workerPathForNode(workerPath: string): string {
  return workerPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

/** Readable "crashed" reason for an exit code or a fatal signal. */
function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  return signal ? `signal ${signal}` : "unexpected end";
}

/**
 * Main-process handle to the STT worker: a Node.js >= 22 child process when a
 * runtime was found, else an Electron utilityProcess. Emits
 * "partial" (id, committed, tentative) and "crashed" (reason).
 */
export class SttClient extends EventEmitter {
  private readonly workerPath: string;
  private readonly nodePath: string | null;
  private proc: WorkerProc | null = null;
  private nextId = 1;
  private modelPath: string | null = null;
  private modelBackend: ComputeBackend = "auto";
  private backendChoices: BackendChoice[] = [];
  private loading: (Pending<{ backend: string; loadMs: number }> & { id: number }) | null = null;
  private nextLoadId = 1;
  private stops = new Map<number, Pending<FinalResult>>();
  private disposed = false;

  constructor(workerPath: string, nodePath: string | null = null) {
    super();
    this.workerPath = workerPath;
    this.nodePath = nodePath;
  }

  /** Which runtime hosts the worker. */
  get runtime(): "node" | "electron" {
    return this.nodePath ? "node" : "electron";
  }

  get backends(): BackendChoice[] {
    return this.backendChoices;
  }

  /** Cached backend list, or the one the worker sends at startup. */
  backendList(): Promise<BackendChoice[]> {
    if (this.backendChoices.length) return Promise.resolve(this.backendChoices);
    // Spawning the worker (without a load) makes it emit "backends" once.
    this.ensure();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.backendChoices), BACKENDS_TIMEOUT_MS);
      this.once("backends", (list: BackendChoice[]) => {
        clearTimeout(timer);
        resolve(list);
      });
    });
  }

  load(modelPath: string, backend: ComputeBackend): Promise<{ backend: string; loadMs: number }> {
    this.modelPath = modelPath;
    this.modelBackend = backend;
    this.loading?.reject(new SupersededError());
    return new Promise((resolve, reject) => {
      const id = this.nextLoadId++;
      this.loading = { resolve, reject, id };
      this.send({ type: "load", loadId: id, modelPath, backend });
    });
  }

  start(options: DecodeOptions): number {
    const id = this.nextId++;
    this.send({ type: "start", id, options });
    return id;
  }

  push(id: number, pcm: Float32Array): void {
    this.proc?.post({ type: "audio", id, pcm });
  }

  stop(id: number): Promise<FinalResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stops.delete(id);
        reject(new Error("Transcription timed out"));
      }, STOP_TIMEOUT_MS);
      this.stops.set(id, { resolve, reject, timer });
      this.send({ type: "stop", id });
    });
  }

  cancel(id: number): void {
    this.proc?.post({ type: "cancel", id });
    const p = this.stops.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.stops.delete(id);
      p.resolve({ text: "", audioMs: 0, decodeMs: 0 });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.kill();
    this.proc = null;
  }

  private send(msg: ToWorker) {
    this.ensure().post(msg);
  }

  private ensure(): WorkerProc {
    if (this.proc) return this.proc;
    const proc = this.nodePath ? nodeProc(workerPathForNode(this.workerPath), this.nodePath) : electronProc(this.workerPath);
    proc.onMessage((msg) => this.onMessage(msg));
    proc.onExit((code, signal) => this.onExit(proc, code, signal));
    this.proc = proc;
    // A respawned worker has no model; reload the last one first so queued
    // messages (start/audio) find it.
    if (this.modelPath && !this.loading) {
      const path = this.modelPath;
      const backend = this.modelBackend;
      const id = this.nextLoadId++;
      this.loading = { resolve: () => {}, reject: () => {}, id };
      proc.post({ type: "load", loadId: id, modelPath: path, backend });
    }
    return proc;
  }

  private onMessage(msg: FromWorker) {
    switch (msg.type) {
      case "backends":
        this.setBackends(msg.backends);
        break;
      case "loaded":
        this.setBackends(msg.backends);
        // A superseded load still finishes in the worker; only the latest counts.
        if (this.loading?.id !== msg.loadId) break;
        this.loading.resolve({ backend: msg.backend, loadMs: msg.loadMs });
        this.loading = null;
        break;
      case "load-error":
        if (this.loading?.id !== msg.loadId) break;
        this.loading.reject(new Error(msg.message));
        this.loading = null;
        break;
      case "partial":
        this.emit("partial", msg.id, msg.committed, msg.tentative);
        break;
      case "final":
      case "error": {
        const p = msg.id !== undefined ? this.stops.get(msg.id) : undefined;
        if (!p) {
          if (msg.type === "error") console.error("[stt]", msg.message);
          break;
        }
        clearTimeout(p.timer);
        this.stops.delete(msg.id!);
        if (msg.type === "final") p.resolve({ text: msg.text, audioMs: msg.audioMs, decodeMs: msg.decodeMs });
        else p.reject(new Error(msg.message));
        break;
      }
    }
  }

  private setBackends(backends: BackendChoice[]) {
    if (JSON.stringify(backends) === JSON.stringify(this.backendChoices)) return;
    this.backendChoices = backends;
    this.emit("backends", backends);
  }

  private onExit(proc: WorkerProc, code: number | null, signal: NodeJS.Signals | null) {
    if (this.proc !== proc) return;
    this.proc = null;
    const reason = exitReason(code, signal);
    const err = new Error(`Speech engine exited (${reason})`);
    this.loading?.reject(err);
    this.loading = null;
    for (const p of this.stops.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.stops.clear();
    if (!this.disposed) this.emit("crashed", reason);
  }
}
