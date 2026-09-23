// Model discovery & download for the Canary GGUF. Pure node, global fetch.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Settings } from "../shared/types.ts";

export const DEFAULT_MODEL = {
  file: "canary-1b-v2-Q8_0.gguf",
  url: "https://huggingface.co/handy-computer/canary-1b-v2-gguf/resolve/main/canary-1b-v2-Q8_0.gguf",
  size: 1_144_290_016,
} as const;

export function defaultModelPath(userDataDir: string): string {
  return path.join(userDataDir, "models", DEFAULT_MODEL.file);
}

export function resolveModelPath(settings: Settings, userDataDir: string): string {
  return settings.modelPath !== "" ? settings.modelPath : defaultModelPath(userDataDir);
}

export function modelExists(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 1_048_576;
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  url?: string;
  dest: string;
  expectedSize?: number;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Download a model to `dest`, resuming from dest + ".part" via HTTP Range.
 * Streams to disk; verifies the final size; atomic rename on success.
 * Keeps the .part file on abort/error so a later call can resume.
 */
export async function downloadModel(opts: DownloadOptions): Promise<void> {
  const url = opts.url ?? DEFAULT_MODEL.url;
  const partPath = opts.dest + ".part";
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });

  let received = 0;
  try {
    received = fs.statSync(partPath).size;
  } catch {
    /* no .part yet */
  }

  // Warm up the file handle mode before the first response.
  await run(opts, url, partPath, received);
}

async function run(
  opts: DownloadOptions,
  url: string,
  partPath: string,
  partSize: number,
): Promise<void> {
  const resuming = partSize > 0;
  const res = await fetchWithAbort(url, resuming ? { Range: `bytes=${partSize}-` } : {}, opts);

  if (res.status === 416 && resuming) {
    // Range not satisfiable: .part might already be complete.
    const { full } = parseContentRange(res.headers.get("content-range"));
    const done = opts.expectedSize !== undefined
      ? opts.expectedSize === partSize && (full === 0 || full === partSize)
      : full === partSize;
    if (done && (full !== 0 || opts.expectedSize !== undefined)) {
      renamePart(partPath, opts.dest, opts.expectedSize ?? full);
      return;
    }
    // Bad leftover part: discard and start over.
    await fsp.rm(partPath, { force: true });
    return run(opts, url, partPath, 0);
  }

  if (!res.ok) {
    throw new Error(`Model download failed: HTTP ${res.status} for ${url}`);
  }

  let writeFrom = 0;
  let total = 0;
  if (res.status === 206) {
    if (!resuming) {
      // Server answered a range we never asked for; be safe and restart.
      return run(opts, url, partPath, 0);
    }
    const { full, start } = parseContentRange(res.headers.get("content-range"));
    if (start !== partSize || full <= 0) {
      // Server is out of sync with the .part file; discard it and restart.
      await fsp.rm(partPath, { force: true });
      return run(opts, url, partPath, 0);
    }
    if (opts.expectedSize !== undefined && full !== opts.expectedSize) {
      throw new Error(
        `Model download failed: server reports ${full} bytes, expected ${opts.expectedSize}`,
      );
    }
    writeFrom = partSize;
    total = full;
  } else {
    // Plain 200 (either fresh start or server ignored Range).
    total = opts.expectedSize ?? Number(res.headers.get("content-length") ?? 0);
    if (total === 0) {
      throw new Error("Model download failed: missing Content-Length and no expectedSize");
    }
    if (opts.expectedSize !== undefined && total !== opts.expectedSize) {
      throw new Error(
        `Model download failed: Content-Length ${total} does not match expected ${opts.expectedSize}`,
      );
    }
    // writeFrom stays 0: a 200 means a fresh (full) body, overwriting any .part.
  }

  if (writeFrom >= total && total > 0) {
    // .part already covers everything.
    renamePart(partPath, opts.dest, total);
    return;
  }

  if (!res.body) throw new Error("Model download failed: empty response body");

  const expectedTotal = opts.expectedSize ?? total;
  let downloaded = writeFrom;
  let lastProgress = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.byteLength;
      if (opts.onProgress && Date.now() - lastProgress >= 200) {
        lastProgress = Date.now();
        opts.onProgress(downloaded, expectedTotal);
      }
      cb(null, chunk);
    },
  });
  // On abort/network error pipeline() destroys every stream and rejects; the
  // .part file is kept so a later call can resume.
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
    progress,
    fs.createWriteStream(partPath, { flags: writeFrom > 0 ? "a" : "w" }),
    { signal: opts.signal },
  );

  const finalSize = fs.statSync(partPath).size;
  if (finalSize !== expectedTotal) {
    throw new Error(
      `Model download failed: size mismatch (got ${finalSize}, expected ${expectedTotal})`,
    );
  }
  opts.onProgress?.(finalSize, expectedTotal);
  renamePart(partPath, opts.dest, expectedTotal);
}

/** Atomic rename of a verified .part onto its final name. */
function renamePart(partPath: string, dest: string, total: number): void {
  const size = fs.statSync(partPath).size;
  if (size !== total) {
    throw new Error(
      `Model download failed: size mismatch (got ${size}, expected ${total})`,
    );
  }
  fs.renameSync(partPath, dest);
}

/** Parse a Content-Range header like "bytes 123-456/1000". */
function parseContentRange(
  header: string | null,
): { start: number; full: number } {
  if (header) {
    const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(header);
    if (m) {
      return { start: Number(m[1]), full: Number(m[2]) };
    }
  }
  return { start: -1, full: 0 };
}

/** Remove a leftover partial download (e.g. user picks a different model). */
export async function removePart(dest: string): Promise<void> {
  await fsp.rm(dest + ".part", { force: true });
}

function fetchWithAbort(
  url: string,
  headers: Record<string, string>,
  opts: DownloadOptions,
): Promise<Response> {
  return fetch(url, { headers, redirect: "follow", signal: opts.signal });
}
