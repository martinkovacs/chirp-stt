// Electron utilityProcess entry: owns the transcribe.cpp model so inference
// never blocks the main process.
import { TranscribeModel, getAvailableBackends, backendAvailable } from "transcribe-cpp";
import type { Backend } from "transcribe-cpp";
import { Dictation } from "./dictation.ts";
import type { BackendChoice, ComputeBackend, DecodeOptions, FromWorker, ToWorker } from "../../shared/types.ts";

interface ParentPort {
  on(event: "message", listener: (e: { data: ToWorker }) => void): void;
  postMessage(message: FromWorker): void;
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort;

let model: TranscribeModel | null = null;
let active: { id: number; dictation: Dictation } | null = null;
// transcribe.cpp allows one compute in flight per model.
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function send(msg: FromWorker) {
  port.postMessage(msg);
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

// Which compute backends the UI can offer. kind strings observed from
// getAvailableBackends(): "vulkan", "cuda", "rocm", "metal", "cpu".
const BACKENDS: { backend: ComputeBackend; label: string; kind: string }[] = [
  { backend: "auto", label: "Auto", kind: "" },
  { backend: "vulkan", label: "Vulkan", kind: "vulkan" },
  { backend: "cuda", label: "CUDA", kind: "cuda" },
  { backend: "rocm", label: "ROCm", kind: "rocm" },
  { backend: "metal", label: "Metal", kind: "metal" },
  { backend: "cpu", label: "CPU", kind: "cpu" },
];

function listBackends(): BackendChoice[] {
  try {
    const devices = getAvailableBackends();
    // The first non-CPU device is what "auto" would likely pick.
    const autoDevice = devices.find((d) => d.kind !== "cpu") ?? devices.find((d) => d.kind === "cpu");
    return BACKENDS.map(({ backend, label, kind }) => {
      const available = backend === "auto" || safeAvailable(backend);
      const device = (kind ? devices.find((d) => d.kind === kind) : autoDevice)?.description ?? "";
      return { backend, label, available, device };
    });
  } catch {
    return BACKENDS.map(({ backend, label }) => ({ backend, label, available: backend === "auto", device: "" }));
  }
}

function safeAvailable(backend: Backend): boolean {
  try {
    return backendAvailable(backend);
  } catch {
    return false;
  }
}

async function load(path: string, backend: ComputeBackend) {
  const t = performance.now();
  active?.dictation.cancel();
  active = null;
  await serial(async () => {
    model?.dispose();
    model = null;
    const m = await TranscribeModel.load(path, { backend });
    // First decode compiles GPU pipelines (can take seconds); do it now.
    await m.transcribe(new Float32Array(16000), { language: "en" });
    model = m;
  });
  send({ type: "loaded", backend: model!.backend, loadMs: Math.round(performance.now() - t), backends: listBackends() });
}

function start(id: number, options: DecodeOptions) {
  active?.dictation.cancel();
  const opts =
    options.task === "translate"
      ? { task: "translate" as const, language: options.language, targetLanguage: options.targetLanguage }
      : { language: options.language };
  const dictation = new Dictation({
    decode: (pcm) =>
      serial(async () => {
        if (!model) throw new Error("Model not loaded");
        return (await model.transcribe(pcm, opts)).text;
      }),
    onPartial: (committed, tentative) => {
      if (active?.id === id) send({ type: "partial", id, committed, tentative });
    },
  });
  active = { id, dictation };
}

async function stop(id: number) {
  if (active?.id !== id) {
    send({ type: "final", id, text: "", audioMs: 0, decodeMs: 0 });
    return;
  }
  const { dictation } = active;
  try {
    const r = await dictation.finish();
    send({ type: "final", id, text: r.text, audioMs: r.audioMs, decodeMs: Math.round(r.decodeMs) });
  } catch (err) {
    send({ type: "error", id, message: errMsg(err) });
  } finally {
    if (active?.id === id) active = null;
  }
}

port.on("message", ({ data: msg }) => {
  switch (msg.type) {
    case "load":
      load(msg.modelPath, msg.backend).catch((err) => send({ type: "load-error", message: errMsg(err) }));
      break;
    case "start":
      start(msg.id, msg.options);
      break;
    case "audio":
      if (active?.id === msg.id) active.dictation.push(msg.pcm);
      break;
    case "stop":
      void stop(msg.id);
      break;
    case "cancel":
      if (active?.id === msg.id) {
        active.dictation.cancel();
        active = null;
      }
      break;
  }
});

// Device list is static for the process lifetime; send it once at startup.
send({ type: "backends", backends: listBackends() });
