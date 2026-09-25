// PCM over the Node child's JSON IPC channel: a Float32Array travels as
// base64 of its raw bytes. Shared by client.ts, worker.ts and the tests.

export function encodePcm(pcm: Float32Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function decodePcm(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  // Copy into a fresh, 4-byte-aligned buffer; Buffer's pool offset may not be.
  const pcm = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(pcm.buffer).set(bytes);
  return pcm;
}
