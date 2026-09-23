import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Dictation, joinText } from "../src/main/stt/dictation.ts";
import type { DictationOptions } from "../src/main/stt/dictation.ts";

const SR = 16000;
const CHUNK = 1600; // 100 ms of audio
const FRAME = 480; // 30 ms frame at 16 kHz

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

function speech(ms: number): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return pcm;
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((SR * ms) / 1000));
}

function pushChunks(d: Dictation, pcm: Float32Array): void {
  for (let i = 0; i < pcm.length; i += CHUNK) {
    d.push(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
  }
}

/** Push chunk-wise like a live mic, letting pending decodes drain periodically. */
async function stream(d: Dictation, pcm: Float32Array, flushEvery = 10): Promise<void> {
  let chunk = 0;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    d.push(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
    if (++chunk % flushEvery === 0) await flush(4);
  }
  await flush();
}

interface DecodeCall {
  length: number;
  /** RMS of the first frame of the decoded slice: ~0.07 for speech, 0 for silence. */
  headRms: number;
}

function makeDecode() {
  const calls: DecodeCall[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const decode = async (pcm: Float32Array): Promise<string> => {
    concurrent++;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    const head = Math.min(FRAME, pcm.length);
    let sum = 0;
    for (let i = 0; i < head; i++) sum += pcm[i] * pcm[i];
    calls.push({ length: pcm.length, headRms: Math.sqrt(sum / head) });
    await tick();
    concurrent--;
    return `w${pcm.length}`;
  };
  return { decode, calls, maxConcurrent: () => maxConcurrent };
}

interface PartialEvent {
  committed: string;
  tentative: string;
}

function makeDictation(
  decode: (pcm: Float32Array) => Promise<string>,
  opts: Omit<DictationOptions, "decode" | "onPartial"> = {},
): { d: Dictation; events: PartialEvent[] } {
  const events: PartialEvent[] = [];
  const d = new Dictation({
    decode,
    onPartial: (committed, tentative) => events.push({ committed, tentative }),
    ...opts,
  });
  return { d, events };
}

describe("Dictation", () => {
  it("emits partials while speaking and never overlaps decodes", async () => {
    const { decode, calls, maxConcurrent } = makeDecode();
    const { d, events } = makeDictation(decode, { partialIntervalMs: 200 });
    await stream(d, speech(3000));

    assert.ok(calls.length >= 5, `expected several partial decodes, got ${calls.length}`);
    for (const e of events) {
      assert.equal(e.committed, "", "nothing committed without a pause");
      assert.notEqual(e.tentative, "", "partial preview text present");
    }
    assert.equal(events.length, calls.length, "each decode produces one partial event");
    for (let i = 1; i < calls.length; i++) {
      assert.ok(calls[i]!.length > calls[i - 1]!.length, "tail re-decode grows");
    }
    assert.equal(maxConcurrent(), 1, "decodes must never overlap");
  });

  it("commits after >= 6 s of audio plus >= 500 ms silence and never re-decodes it", async () => {
    const { decode, calls } = makeDecode();
    const { d, events } = makeDictation(decode, { partialIntervalMs: 500 });

    await stream(d, speech(6500));
    await stream(d, silence(1000));
    assert.ok(d.audioMs >= 7500);

    // Silence never triggers partials, so the last decode so far is the commit.
    const commitIdx = calls.length - 1;
    assert.ok(calls[commitIdx]!.headRms > 0.05 && calls[commitIdx]!.length >= 6 * SR,
      "a decode covering >= 6 s of speech was committed");
    assert.ok(events.some((e) => e.committed !== ""), "committed text surfaced via onPartial");
    assert.ok(
      events.some((e) => e.committed !== "" && e.tentative === ""),
      "tentative reset once committed",
    );

    // More audio after the commit: new decodes must start at/after the cut,
    // i.e. never touch the committed (speech) region again.
    await stream(d, silence(1000));
    await stream(d, speech(1000));
    const later = calls.slice(commitIdx + 1);
    assert.ok(later.length >= 1, "audio continued after the commit was decoded");
    for (const c of later) {
      assert.ok(c.headRms < 0.05, "post-commit decode starts outside the committed segment");
    }
  });

  it("force-cuts a segment at 25 s of continuous speech", async () => {
    const { decode, calls } = makeDecode();
    // No partials (interval > total length) so the only decode is the forced commit.
    const { d, events } = makeDictation(decode, { partialIntervalMs: 60000 });

    await stream(d, speech(25500));

    assert.equal(calls.length, 1, "exactly one forced-cut decode");
    assert.ok(
      calls[0]!.length >= 350000,
      `committed segment covers ~25 s of speech, got ${calls[0]!.length} samples`,
    );
    assert.ok(calls[0]!.length <= 25.5 * SR, "cut happens within the pushed audio");
    assert.ok(events.some((e) => e.committed !== ""), "forced cut surfaced as committed text");
  });

  it("finish() joins committed text with the decoded tail", async () => {
    const { decode, calls } = makeDecode();
    const { d } = makeDictation(decode, { partialIntervalMs: 60000, minSegmentMs: 1000 });

    await stream(d, speech(1500));
    await stream(d, silence(1000)); // pause long enough to commit
    await stream(d, speech(1000)); // uncommitted tail

    const result = await d.finish();
    assert.equal(calls.length, 2, "one commit decode + one tail decode");
    assert.equal(result.text, `w${calls[0]!.length} w${calls[1]!.length}`);
    assert.equal(result.audioMs, 3500);
    assert.ok(result.decodeMs >= 0);
  });

  it("finish() skips decode entirely for pure silence", async () => {
    const { decode, calls } = makeDecode();
    const { d } = makeDictation(decode, { partialIntervalMs: 200, minSegmentMs: 1000 });

    await stream(d, silence(2000));
    const result = await d.finish();

    assert.equal(calls.length, 0, "silence is never decoded");
    assert.equal(result.text, "");
    assert.equal(result.audioMs, 2000);
  });

  it("cancel() makes finish() return empty text", async () => {
    const { decode, calls } = makeDecode();
    const { d } = makeDictation(decode, { partialIntervalMs: 200 });

    await stream(d, speech(1000), 1);
    assert.ok(calls.length >= 3, "partials ran before cancel");
    d.cancel();
    const result = await d.finish();

    assert.equal(result.text, "");
    assert.equal(result.audioMs, 1000);
  });

  it("joinText trims parts and drops empties", () => {
    assert.equal(joinText(["  hi ", "", " yo\t", "   "]), "hi yo");
    assert.equal(joinText([]), "");
    assert.equal(joinText(["", "   "]), "");
  });
});
