import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SAMPLE_RATE } from "../src/shared/types.ts";
import type { FromWorker, ToWorker } from "../src/shared/types.ts";

// Forks the worker SOURCE, untranspiled, the way client.ts runs it under a
// plain Node.js binary: advanced serialization so Float32Array audio survives
// the channel. No model is needed; silence is never decoded.
const WORKER = fileURLToPath(new URL("../src/main/stt/worker.ts", import.meta.url));
const MESSAGE_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

/** Worker stderr so far, appended to the wait failures below for diagnosis. */
let stderr = "";

function spawnWorker(): ChildProcess {
  const child = fork(WORKER, [], {
    execArgv: ["--experimental-strip-types"],
    serialization: "advanced",
    // fork needs an explicit "ipc" fd once stdio is given at all.
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  return child;
}

function hint(): string {
  const out = stderr.trim();
  return out ? `; worker stderr:\n${out}` : "";
}

function send(child: ChildProcess, msg: ToWorker): void {
  child.send(msg);
}

/** First message of `type`, or a rejection on timeout / crash / early exit. */
function waitFor<T extends FromWorker["type"]>(
  child: ChildProcess,
  type: T,
  ms: number,
): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (msg: FromWorker) => {
      if (msg.type !== type) return;
      cleanup();
      resolve(msg as Extract<FromWorker, { type: T }>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`worker exited (code ${code}, signal ${signal}) before ${type}${hint()}`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no ${type} within ${ms}ms${hint()}`));
    }, ms);
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function exitWithin(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${ms}ms${hint()}`)), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("worker transport (node fork)", () => {
  it("announces backends, round-trips silence, and exits cleanly on disconnect", async (t) => {
    stderr = "";
    const child = spawnWorker();
    t.after(() => child.kill());

    // Startup: one backend list, an array whether or not a backend is usable here.
    const backends = await waitFor(child, "backends", MESSAGE_TIMEOUT_MS);
    assert.ok(Array.isArray(backends.backends));

    // audioMs is derived from the samples received, so 1 s of silence ending in
    // audioMs 1000 proves the Float32Array survived the channel intact.
    send(child, { type: "start", id: 1, options: { task: "transcribe", language: "en" } });
    send(child, { type: "audio", id: 1, pcm: new Float32Array(SAMPLE_RATE) });
    send(child, { type: "stop", id: 1 });
    const final = await waitFor(child, "final", MESSAGE_TIMEOUT_MS);
    assert.equal(final.id, 1);
    assert.equal(final.text, "");
    assert.equal(final.audioMs, 1000);

    // Dropping the channel makes the worker exit on its own, with code 0.
    child.disconnect();
    const { code, signal } = await exitWithin(child, EXIT_TIMEOUT_MS);
    assert.equal(code, 0);
    assert.equal(signal, null);
  });
});
