import { utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { DecodeOptions, FromWorker, ToWorker } from "../../shared/types.ts";

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

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL("./stt-worker.js", import.meta.url));
}

/**
 * Main-process handle to the STT utility process. Emits
 * "partial" (id, committed, tentative) and "crashed" (reason).
 */
export class SttClient extends EventEmitter {
  private readonly workerPath: string;
  private proc: UtilityProcess | null = null;
  private nextId = 1;
  private modelPath: string | null = null;
  private loading: Pending<{ backend: string; loadMs: number }> | null = null;
  private stops = new Map<number, Pending<FinalResult>>();
  private disposed = false;

  constructor(workerPath: string) {
    super();
    this.workerPath = workerPath;
  }

  load(modelPath: string): Promise<{ backend: string; loadMs: number }> {
    this.modelPath = modelPath;
    this.loading?.reject(new Error("Superseded by another load"));
    return new Promise((resolve, reject) => {
      this.loading = { resolve, reject };
      this.send({ type: "load", modelPath });
    });
  }

  start(options: DecodeOptions): number {
    const id = this.nextId++;
    this.send({ type: "start", id, options });
    return id;
  }

  push(id: number, pcm: Float32Array): void {
    this.proc?.postMessage({ type: "audio", id, pcm } satisfies ToWorker);
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
    this.proc?.postMessage({ type: "cancel", id } satisfies ToWorker);
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
    this.ensure().postMessage(msg);
  }

  private ensure(): UtilityProcess {
    if (this.proc) return this.proc;
    const proc = utilityProcess.fork(this.workerPath, [], { serviceName: "chirp-stt", stdio: "inherit" });
    proc.on("message", (msg: FromWorker) => this.onMessage(msg));
    proc.on("exit", (code) => this.onExit(proc, code));
    this.proc = proc;
    // A respawned worker has no model; reload the last one first so queued
    // messages (start/audio) find it.
    if (this.modelPath && !this.loading) {
      const path = this.modelPath;
      this.loading = { resolve: () => {}, reject: () => {} };
      proc.postMessage({ type: "load", modelPath: path } satisfies ToWorker);
    }
    return proc;
  }

  private onMessage(msg: FromWorker) {
    switch (msg.type) {
      case "loaded":
        this.loading?.resolve({ backend: msg.backend, loadMs: msg.loadMs });
        this.loading = null;
        break;
      case "load-error":
        this.loading?.reject(new Error(msg.message));
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

  private onExit(proc: UtilityProcess, code: number) {
    if (this.proc !== proc) return;
    this.proc = null;
    const err = new Error(`Speech engine exited (code ${code})`);
    this.loading?.reject(err);
    this.loading = null;
    for (const p of this.stops.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.stops.clear();
    if (!this.disposed) this.emit("crashed", `exit code ${code}`);
  }
}
