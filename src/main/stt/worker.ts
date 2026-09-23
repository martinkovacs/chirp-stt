// Electron utilityProcess entry: owns the transcribe.cpp model so inference
// never blocks the main process.
import { TranscribeModel } from "transcribe-cpp";
import { Dictation } from "./dictation.ts";
import type { DecodeOptions, FromWorker, ToWorker } from "../../shared/types.ts";

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

async function load(path: string) {
  const t = performance.now();
  active?.dictation.cancel();
  active = null;
  await serial(async () => {
    model?.dispose();
    model = null;
    const m = await TranscribeModel.load(path);
    // First decode compiles GPU pipelines (can take seconds); do it now.
    await m.transcribe(new Float32Array(16000), { language: "en" });
    model = m;
  });
  send({ type: "loaded", backend: model!.backend, loadMs: Math.round(performance.now() - t) });
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
      load(msg.modelPath).catch((err) => send({ type: "load-error", message: errMsg(err) }));
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
