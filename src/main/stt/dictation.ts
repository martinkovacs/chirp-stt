// Pseudo-streaming on top of a non-streaming model (Canary): the uncommitted
// tail of the audio is re-decoded every `partialIntervalMs` for a live
// preview, and pauses split it into segments that are decoded once and frozen.
// Pure logic: the actual model call is injected as `decode`.

export interface DictationOptions {
  decode: (pcm: Float32Array) => Promise<string>;
  onPartial: (committed: string, tentative: string) => void;
  sampleRate?: number;
  partialIntervalMs?: number;
  minSegmentMs?: number;
  silenceMs?: number;
  maxSegmentMs?: number;
  /** Frame RMS below this counts as silence. */
  silenceThreshold?: number;
}

export interface DictationResult {
  text: string;
  audioMs: number;
  decodeMs: number;
}

const FRAME_MS = 30;

export function joinText(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

export class Dictation {
  private readonly decode: DictationOptions["decode"];
  private readonly onPartial: DictationOptions["onPartial"];
  private readonly sr: number;
  private readonly frame: number;
  private readonly partialEvery: number;
  private readonly minSegment: number;
  private readonly silenceFrames: number;
  private readonly maxSegment: number;
  private readonly threshold: number;

  private buf = new Float32Array(16000 * 30);
  private len = 0;
  /** RMS per complete frame, indexed from sample 0. */
  private frames: number[] = [];
  private segStart = 0;
  private lastPartialAt = 0;
  private committed: string[] = [];
  private tentative = "";
  private busy: Promise<void> | null = null;
  private cancelled = false;
  private finishing = false;
  private decodeMs = 0;

  constructor(opts: DictationOptions) {
    this.decode = opts.decode;
    this.onPartial = opts.onPartial;
    this.sr = opts.sampleRate ?? 16000;
    this.frame = Math.round((this.sr * FRAME_MS) / 1000);
    this.partialEvery = Math.round(((opts.partialIntervalMs ?? 800) * this.sr) / 1000);
    this.minSegment = Math.round(((opts.minSegmentMs ?? 8000) * this.sr) / 1000);
    this.silenceFrames = Math.ceil((opts.silenceMs ?? 500) / FRAME_MS);
    this.maxSegment = Math.round(((opts.maxSegmentMs ?? 25000) * this.sr) / 1000);
    this.threshold = opts.silenceThreshold ?? 0.012;
  }

  get audioMs(): number {
    return Math.round((this.len / this.sr) * 1000);
  }

  push(pcm: Float32Array): void {
    if (this.cancelled || this.finishing) return;
    if (this.len + pcm.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + pcm.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(pcm, this.len);
    this.len += pcm.length;
    while ((this.frames.length + 1) * this.frame <= this.len) {
      const s = this.frames.length * this.frame;
      let sum = 0;
      for (let i = s; i < s + this.frame; i++) sum += this.buf[i] * this.buf[i];
      this.frames.push(Math.sqrt(sum / this.frame));
    }
    this.pump();
  }

  cancel(): void {
    this.cancelled = true;
  }

  async finish(): Promise<DictationResult> {
    this.finishing = true;
    while (this.busy) await this.busy;
    if (this.cancelled) return { text: "", audioMs: this.audioMs, decodeMs: this.decodeMs };
    const tail = this.buf.subarray(this.segStart, this.len);
    let last = "";
    if (tail.length >= 0.3 * this.sr && this.hasSpeech(this.segStart, this.len)) {
      last = await this.timedDecode(tail);
    }
    return { text: joinText([...this.committed, last]), audioMs: this.audioMs, decodeMs: this.decodeMs };
  }

  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.busy || this.cancelled || this.finishing) return;
    const cut = this.findCut();
    if (cut !== null) {
      this.run(async () => {
        const text = this.hasSpeech(this.segStart, cut)
          ? await this.timedDecode(this.buf.slice(this.segStart, cut))
          : "";
        if (this.cancelled) return;
        if (text.trim()) this.committed.push(text);
        this.segStart = cut;
        this.tentative = "";
        this.lastPartialAt = this.len;
        this.emit();
      });
      return;
    }
    if (this.len - this.lastPartialAt < this.partialEvery) return;
    if (!this.hasSpeech(this.segStart, this.len)) return;
    const end = this.len;
    this.lastPartialAt = end;
    const start = this.segStart;
    this.run(async () => {
      const text = await this.timedDecode(this.buf.slice(start, end));
      // A commit may have moved the segment start while we were decoding.
      if (this.cancelled || start !== this.segStart) return;
      this.tentative = text.trim();
      this.emit();
    });
  }

  /** Sample index where the current segment should be committed, or null. */
  private findCut(): number | null {
    const segLen = this.len - this.segStart;
    if (segLen >= this.minSegment) {
      // trailing silence run
      let run = 0;
      for (let f = this.frames.length - 1; f >= 0 && f * this.frame >= this.segStart; f--) {
        if (this.frames[f] >= this.threshold) break;
        run++;
      }
      if (run >= this.silenceFrames) {
        const firstSilent = this.frames.length - run;
        return (firstSilent + Math.floor(run / 2)) * this.frame;
      }
    }
    if (segLen >= this.maxSegment) {
      // quietest frame in the last 3 s
      const lo = Math.max(Math.ceil(this.segStart / this.frame), this.frames.length - Math.round(3000 / FRAME_MS));
      let best = this.frames.length - 1;
      for (let f = lo; f < this.frames.length; f++) if (this.frames[f] < this.frames[best]) best = f;
      return Math.max(this.segStart + this.frame, best * this.frame + Math.floor(this.frame / 2));
    }
    return null;
  }

  private hasSpeech(from: number, to: number): boolean {
    const a = Math.floor(from / this.frame);
    const b = Math.min(this.frames.length, Math.ceil(to / this.frame));
    for (let f = a; f < b; f++) if (this.frames[f] >= this.threshold) return true;
    // frames are only computed for complete 30 ms blocks; check the raw tail too
    for (let i = Math.max(from, this.frames.length * this.frame); i < to; i++) {
      if (Math.abs(this.buf[i]) >= this.threshold * 1.4) return true;
    }
    return false;
  }

  private run(task: () => Promise<void>): void {
    const p = task()
      .catch((err: unknown) => {
        console.error("[dictation] partial decode failed:", err);
      })
      .finally(() => {
        if (this.busy === p) this.busy = null;
        this.pump();
      });
    this.busy = p;
  }

  private async timedDecode(pcm: Float32Array): Promise<string> {
    const t = performance.now();
    try {
      return await this.decode(pcm);
    } finally {
      this.decodeMs += performance.now() - t;
    }
  }

  private emit(): void {
    try {
      this.onPartial(joinText(this.committed), this.tentative);
    } catch (err) {
      console.error("[dictation] onPartial threw:", err);
    }
  }
}
