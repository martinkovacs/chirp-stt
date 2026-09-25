// STT worker entry: owns the transcribe.cpp model so inference never blocks
// the main process. Runs either as an Electron utilityProcess (the fallback)
// or, preferably, as a child_process fork under a plain Node.js binary.
import { TranscribeModel, artifactDir, getAvailableBackends, backendAvailable } from "transcribe-cpp";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Dictation } from "./dictation.ts";
import { decodePcm } from "./pcm.ts";
import type { BackendChoice, ComputeBackend, DecodeOptions, FromWorker, ToWorker } from "../../shared/types.ts";

// Transport: inside Electron the utilityProcess exposes parentPort, whose
// messages arrive wrapped ({ data }) and go out via postMessage. Under a
// Node.js child_process fork (serialization "json") messages come over
// the process IPC channel and go out via process.send; audio PCM arrives
// base64-encoded there (see decodePcm).
interface ParentPort {
  on(event: "message", listener: (e: { data: ToWorker }) => void): void;
  postMessage(message: FromWorker): void;
}
const electronPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
// PartitionAlloc and its Electron-only quirks (see MAX_CPU_MODEL_BYTES below).
const inElectron = Boolean((process.versions as { electron?: string }).electron);

function send(msg: FromWorker) {
  if (electronPort) electronPort.postMessage(msg);
  else void process.send?.(msg);
}

// Packaged builds unpack the native libraries to app.asar.unpacked, but
// transcribe-cpp resolves them inside app.asar, which dlopen can't read.
// The library loads lazily, so pointing TRANSCRIBE_LIBRARY there in time works.
if (!process.env.TRANSCRIBE_LIBRARY) {
  try {
    const dir = artifactDir();
    const unpacked = dir.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    if (unpacked !== dir) {
      const file =
        process.platform === "win32" ? "transcribe.dll" : process.platform === "darwin" ? "libtranscribe.dylib" : "libtranscribe.so";
      process.env.TRANSCRIBE_LIBRARY = join(unpacked, file);
    }
  } catch {
    /* no native package: loading reports the error */
  }
}

let model: TranscribeModel | null = null;
let active: { id: number; dictation: Dictation } | null = null;
// transcribe.cpp allows one compute in flight per model.
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
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
// one aligned block, so bigger models can't run on the CPU backend there.
// Under a plain Node.js runtime (glibc malloc) there is no such limit.
const MAX_CPU_MODEL_BYTES = 1024 ** 3;

async function load(loadId: number, path: string, backend: ComputeBackend) {
  const t = performance.now();
  active?.dictation.cancel();
  active = null;
  const choices = listBackends();
  // A saved backend that is no longer available falls back to the best one.
  const resolved = choices.some((c) => c.backend === backend) ? backend : "auto";
  const effective = resolved === "auto" ? choices[0]?.backend ?? "cpu" : resolved;
  const size = statSync(path).size;
  if (inElectron && effective === "cpu" && size > MAX_CPU_MODEL_BYTES) {
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
  send({ type: "loaded", loadId, backend: model!.backend, loadMs: Math.round(performance.now() - t), backends: choices });
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

// Message inlets: parentPort inside Electron, the IPC channel under Node.
function onMessage(handler: (msg: ToWorker) => void) {
  if (electronPort) {
    electronPort.on("message", ({ data: msg }) => handler(msg));
  } else {
    process.on("message", (msg: ToWorker) =>
      handler(msg.type === "audio" ? { ...msg, pcm: decodePcm(msg.pcm as unknown as string) } : msg),
    );
    // Node child (child_process fork): exit when the IPC channel drops so
    // the worker never outlives the app.
    process.on("disconnect", () => process.exit(0));
  }
}

onMessage((msg) => {
  switch (msg.type) {
    case "load":
      load(msg.loadId, msg.modelPath, msg.backend).catch((err) => send({ type: "load-error", loadId: msg.loadId, message: errMsg(err) }));
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
