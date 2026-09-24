// Electron utilityProcess entry: owns the transcribe.cpp model so inference
// never blocks the main process.
import { TranscribeModel, getAvailableBackends, backendAvailable } from "transcribe-cpp";
import { statSync } from "node:fs";
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

// Compute backends in order of preference; only available ones are offered.
const BACKENDS: { backend: Exclude<ComputeBackend, "auto">; label: string }[] = [
  { backend: "cuda", label: "CUDA" },
  { backend: "rocm", label: "ROCm" },
  { backend: "metal", label: "Metal" },
  { backend: "vulkan", label: "Vulkan" },
  { backend: "cpu", label: "CPU" },
];

function listBackends(): BackendChoice[] {
  try {
    const devices = getAvailableBackends();
    return BACKENDS.filter(({ backend }) => backendAvailable(backend)).map(({ backend, label }) => ({
      backend,
      label,
      device: devices.find((d) => d.kind === backend)?.description ?? "",
    }));
  } catch {
    return [];
  }
}

// Electron replaces malloc with PartitionAlloc, which traps (SIGTRAP, exit
// code 133) on aligned allocations over 1 GiB. ggml allocates CPU weights as
// one aligned block, so bigger models can't run on the CPU backend.
const MAX_CPU_MODEL_BYTES = 1024 ** 3;

async function load(path: string, backend: ComputeBackend) {
  const t = performance.now();
  active?.dictation.cancel();
  active = null;
  const choices = listBackends();
  // A saved backend that is no longer available falls back to the best one.
  const resolved = choices.some((c) => c.backend === backend) ? backend : "auto";
  const effective = resolved === "auto" ? choices[0]?.backend ?? "cpu" : resolved;
  const size = statSync(path).size;
  if (effective === "cpu" && size > MAX_CPU_MODEL_BYTES) {
    throw new Error(
      `The CPU backend can't load models over 1 GiB (this one is ${(size / 1e9).toFixed(2)} GB). ` +
        "Use a GPU backend or a smaller quantization such as Q6_K.",
    );
  }
  await serial(async () => {
    model?.dispose();
    model = null;
    const m = await TranscribeModel.load(path, { backend: resolved });
    // First decode compiles GPU pipelines (can take seconds); do it now.
    await m.transcribe(new Float32Array(16000), { language: "en" });
    model = m;
  });
  send({ type: "loaded", backend: model!.backend, loadMs: Math.round(performance.now() - t), backends: choices });
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
