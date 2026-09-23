// Microphone capture: 16 kHz mono float32 chunks (~100 ms) pushed to main.

const CHUNK = 1600;

// Inlined so the worklet needs no separate bundle entry.
const WORKLET = `
class ChirpCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take; i += take;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(${CHUNK}); this.n = 0;
      }
    }
    return true;
  }
  flush() {}
}
registerProcessor("chirp-capture", ChirpCapture);
`;

export interface Capture {
  stop(): void;
}

export async function startCapture(
  deviceId: string,
  onChunk: (pcm: Float32Array, level: number) => void,
): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "chirp-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const pcm = e.data;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    onChunk(pcm, Math.sqrt(sum / pcm.length));
  };
  source.connect(node);

  return {
    stop() {
      source.disconnect();
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
