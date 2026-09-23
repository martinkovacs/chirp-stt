import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_MODEL,
  defaultModelPath,
  downloadModel,
  modelExists,
  removePart,
  resolveModelPath,
} from "../src/main/model-manager.ts";
import { DEFAULT_SETTINGS } from "../src/shared/types.ts";

let tmp = "";
let server: http.Server | undefined;
let base = "";
const DATA = Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chirp-model-test-"));
  server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url ?? "";
      if (u.startsWith("/missing/404")) {
        res.writeHead(404, { "content-length": 0 });
        res.end();
        return;
      }
      if (u.startsWith("/slow")) {
        res.writeHead(200, { "content-length": String(DATA.length) });
        let i = 0;
        const timer = setInterval(() => {
          if (req.aborted || req.destroyed) {
            clearInterval(timer);
            res.destroy();
            return;
          }
          if (i >= DATA.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          const next = Math.min(DATA.length, i + 8192);
          res.write(DATA.subarray(i, next));
          i = next;
        }, 5);
        req.on("close", () => {
          clearInterval(timer);
          res.destroy();
        });
        return;
      }
      const range = req.headers["range"];
      if (range) {
        const m = /^bytes=(\d+)-$/.exec(String(range));
        const start = m ? Number(m[1]) : 0;
        if (start >= DATA.length) {
          res.writeHead(416, { "content-range": `bytes */${DATA.length}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "content-range": `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
          "content-length": String(DATA.length - start),
        });
        res.end(DATA.subarray(start));
        return;
      }
      res.writeHead(200, { "content-length": String(DATA.length) });
      res.end(DATA);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function url(): string {
  const addr = server!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/model.gguf`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("model-manager helpers", () => {
  it("defaultModelPath joins userData/models with the default file", () => {
    assert.equal(defaultModelPath("/u"), path.join("/u", "models", DEFAULT_MODEL.file));
  });

  it("resolveModelPath honors settings.modelPath or the default", () => {
    assert.equal(resolveModelPath({ ...DEFAULT_SETTINGS, modelPath: "" }, "/u"), defaultModelPath("/u"));
    assert.equal(resolveModelPath({ ...DEFAULT_SETTINGS, modelPath: "/custom/m.gguf" }, "/u"), "/custom/m.gguf");
  });

  it("modelExists checks file, existence and size > 1 MB", () => {
    const small = path.join(tmp, "small.gguf");
    fs.writeFileSync(small, Buffer.alloc(1024 * 1024));
    const big = path.join(tmp, "big.gguf");
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(modelExists(path.join(tmp, "missing.gguf")), false);
    assert.equal(modelExists(tmp), false, "directory is not a model file");
    assert.equal(modelExists(small), false, "too small");
    assert.equal(modelExists(big), true);
  });
});

describe("downloadModel", () => {
  it("downloads a full file to dest, with progress and atomic rename", async () => {
    const dest = path.join(tmp, "full.gguf");
    const progress: Array<[number, number]> = [];
    await downloadModel({ url: url(), dest, expectedSize: DATA.length, onProgress: (r, t) => progress.push([r, t]) });
    assert.ok(fs.readFileSync(dest).equals(DATA), "dest contents match");
    assert.ok(fs.existsSync(dest + ".part") === false, ".part renamed away");
    assert.equal(progress.length > 0, true);
    assert.equal(progress.at(-1)![0], DATA.length);
    assert.equal(progress.at(-1)![1], DATA.length);
  });

  it("resumes from an existing partial .part file", async () => {
    const dest = path.join(tmp, "resume.gguf");
    fs.writeFileSync(dest + ".part", DATA.subarray(0, Math.floor(DATA.length / 3)));
    await downloadModel({ url: url(), dest, expectedSize: DATA.length });
    assert.ok(fs.readFileSync(dest).equals(DATA), "dest contents match");
  });

  it("restarts cleanly when the server ignores Range (200 instead of 206)", async () => {
    const dest = path.join(tmp, "norestart.gguf");
    fs.writeFileSync(dest + ".part", DATA.subarray(0, 1000));
    await downloadModel({ url: url().replace("/model.gguf", "/no-range"), dest });
    assert.ok(fs.readFileSync(dest).equals(DATA), "dest contents match");
  });

  it("rejects on a size mismatch and keeps the .part file", async () => {
    const dest = path.join(tmp, "mismatch.gguf");
    await assert.rejects(
      () => downloadModel({ url: url(), dest, expectedSize: DATA.length + 100 }),
      /size mismatch/,
    );
    assert.ok(fs.existsSync(dest) === false, "dest not created on failure");
    assert.ok(fs.existsSync(dest + ".part"), ".part kept for resume");
    await removePart(dest);
  });

  it("throws a clear error for HTTP failures", async () => {
    const dest = path.join(tmp, "http404.gguf");
    await assert.rejects(
      () => downloadModel({ url: url().replace("/model.gguf", "/missing/404"), dest }),
      /HTTP 404/,
    );
  });

  it("abort keeps the .part so the download can resume later", async () => {
    const dest = path.join(tmp, "abort.gguf");
    const ac = new AbortController();
    const progress: Array<[number, number]> = [];
    const p = downloadModel({ url: url().replace("/model.gguf", "/slow"), dest, onProgress: (r, t) => progress.push([r, t]), signal: ac.signal });
    await sleep(120);
    await sleep(120);
    ac.abort();
    await assert.rejects(() => p);
    const part = dest + ".part";
    assert.ok(fs.existsSync(part), ".part kept after abort");
    const soFar = fs.statSync(part).size;
    assert.ok(soFar > 0 && soFar <= DATA.length, "some bytes checkpointed");
    await downloadModel({ url: url(), dest, expectedSize: DATA.length });
    assert.ok(fs.readFileSync(dest).equals(DATA), "dest contents match");
  });

  it("completes when .part already equals the total size (416 -> rename)", async () => {
    const dest = path.join(tmp, "precomplete.gguf");
    fs.writeFileSync(dest + ".part", DATA);
    await downloadModel({ url: url(), dest, expectedSize: DATA.length });
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.existsSync(dest + ".part") === false);
  });
});
