#!/usr/bin/env node
// Downloads the pinned official Node.js binary that runs the STT worker as a
// child process, verifies it against the official SHASUMS256.txt, and unpacks
// only the executable and its LICENSE into vendor/node/<platform>-<arch>/.
// electron-builder then ships it as an extraResource (see package.json "build").
//
// Usage: node scripts/fetch-node.mjs [--platform linux|win32|darwin] [--arch x64|arm64]
// Defaults follow the running platform/arch, so release builds just work.
// Cross-fetching other platforms (e.g. from Linux) is best-effort.
//
// Node >= 22 built-ins only: fetch, crypto, fs, zlib/tar via child_process.

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

// Promisified so `await execFile(...)` yields { stdout, stderr } strings.
const execFile = promisify(execFileCallback);

const NODE_VERSION = "v24.21.0";
const DIST_URL = `https://nodejs.org/dist/${NODE_VERSION}`;
// The ~30 MB archive is cached here across runs; only scratch dirs get cleaned.
const CACHE_DIR = path.join(os.tmpdir(), "chirp-node-fetch");

const PLATFORMS = new Set(["linux", "win32", "darwin"]);
const ARCHES = new Set(["x64", "arm64"]);

function parseArgs(argv) {
  let platform;
  let arch;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg !== "--platform" && arg !== "--arch") {
      throw new Error(`unexpected argument ${JSON.stringify(arg)} (use --platform/--arch)`);
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (arg === "--platform") {
      if (!PLATFORMS.has(value)) throw new Error(`unsupported --platform ${value}`);
      platform = value;
    } else {
      if (!ARCHES.has(value)) throw new Error(`unsupported --arch ${value} (Node ships x64/arm64 releases)`);
      arch = value;
    }
  }
  return { platform: platform ?? process.platform, arch: arch ?? process.arch };
}

function archiveInfo(platform, arch) {
  // Windows archive URLs use "win-<arch>" while the vendor dir stays "win32-<arch>".
  const base = `node-${NODE_VERSION}-${platform === "win32" ? "win" : platform}-${arch}`;
  const file =
    platform === "win32" ? `${base}.zip` : platform === "linux" ? `${base}.tar.xz` : `${base}.tar.gz`;
  return { base, file };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadToFileHash(url, destination) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination),
  );
  return hash.digest("hex");
}

async function expectedSha256(file) {
  const res = await fetch(`${DIST_URL}/SHASUMS256.txt`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${DIST_URL}/SHASUMS256.txt`);
  const text = await res.text();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match && match[2] === file) return match[1];
  }
  throw new Error(`${file} is not listed in ${DIST_URL}/SHASUMS256.txt`);
}

function exists(file) {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function binaryReportsTargetVersion(binary) {
  try {
    const { stdout } = await execFile(binary, ["--version"], { timeout: 15_000, windowsHide: true });
    return stdout.trim() === NODE_VERSION;
  } catch {
    return false;
  }
}

async function listArchiveMembers(archive) {
  const { stdout } = await execFile("tar", ["-tf", archive], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean);
}

// Extracts just the node binary and the LICENSE file using the system tar,
// which handles .tar.xz/.tar.gz everywhere and .zip on Windows 10+.
async function extractExecutableAndLicense(platform, archive, stageDir) {
  const binSuffix = platform === "win32" ? "/node.exe" : "/bin/node";

  if (platform === "win32" && process.platform !== "win32") {
    // Cross-fetching a Windows binary from Linux/macOS: tar -xf may not read
    // zip here, so fall back to unzip and a full (small-dir) extraction.
    let unzip;
    try {
      await execFile("unzip", ["-v"], { stdio: "ignore" });
      unzip = true;
    } catch {
      unzip = false;
    }
    if (!unzip) throw new Error("cross-fetching win32 needs the `unzip` command, which is not installed");
    console.log(`[fetch-node] unzip ${path.basename(archive)}`);
    await execFile("unzip", ["-q", "-o", archive, "-d", stageDir], { maxBuffer: 16 * 1024 * 1024 });
    const [top] = await fs.readdir(stageDir);
    const binary = path.join(stageDir, top, "node.exe");
    const license = path.join(stageDir, top, "LICENSE");
    if (!(await exists(binary)) || !(await exists(license))) {
      throw new Error("unexpected archive layout: node.exe/LICENSE not found after unzip");
    }
    return { binary, license };
  }

  const members = await listArchiveMembers(archive);
  const binaryMember = members.find((m) => m.endsWith(binSuffix));
  if (!binaryMember) throw new Error(`no ${binSuffix} entry in archive (unexpected layout?)`);
  const root = binaryMember.slice(0, -binSuffix.length);
  const licenseMember = `${root}/LICENSE`;
  if (!members.includes(licenseMember)) throw new Error(`no ${licenseMember} entry in archive`);
  console.log(`[fetch-node] extracting ${path.basename(archive)} -> node binary + LICENSE only`);
  await execFile("tar", ["-xf", archive, "-C", stageDir, binaryMember, licenseMember], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return { binary: path.join(stageDir, binaryMember), license: path.join(stageDir, licenseMember) };
}

async function fetchNodeBinary(platform, arch) {
  const info = archiveInfo(platform, arch);
  const archive = path.join(CACHE_DIR, info.file);
  const stageDir = path.join(CACHE_DIR, `stage-${platform}-${arch}-${randomUUID()}`);
  const vendorDir = path.join(PROJECT_ROOT, "vendor", "node", `${platform}-${arch}`);
  const exeName = platform === "win32" ? "node.exe" : "node";
  const vendorBinary = path.join(vendorDir, exeName);

  try {
    const expected = await expectedSha256(info.file);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    let actual = (await exists(archive)) ? await sha256File(archive) : null;
    if (actual !== expected) {
      console.log(`[fetch-node] downloading ${DIST_URL}/${info.file}`);
      actual = await downloadToFileHash(`${DIST_URL}/${info.file}`, archive);
    }
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${info.file}: expected ${expected}, got ${actual}`);
    }
    console.log(`[fetch-node] SHA-256 verified (${info.file})`);

    await fs.mkdir(stageDir, { recursive: true });
    const { binary, license } = await extractExecutableAndLicense(platform, archive, stageDir);
    await fs.mkdir(vendorDir, { recursive: true });
    await fs.copyFile(binary, vendorBinary);
    if (platform !== "win32") await fs.chmod(vendorBinary, 0o755);
    await fs.copyFile(license, path.join(vendorDir, "LICENSE"));
    console.log(`[fetch-node] ${NODE_VERSION} (${platform}-${arch}) -> ${path.relative(PROJECT_ROOT, vendorBinary)} + LICENSE`);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

// vendor/node lives at the project root so electron-builder's extraResources
// paths (relative to the project dir) resolve regardless of where this runs.
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

async function main() {
  const { help, platform, arch } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`usage: node ${path.basename(process.argv[1])} [--platform linux|win32|darwin] [--arch x64|arm64]`);
    return;
  }

  const vendorDir = path.join(PROJECT_ROOT, "vendor", "node", `${platform}-${arch}`);
  const vendorBinary = path.join(vendorDir, platform === "win32" ? "node.exe" : "node");

  // History check only works when the fetched binary can execute on this host.
  if (platform === process.platform && arch === process.arch && (await exists(vendorBinary))) {
    if (await binaryReportsTargetVersion(vendorBinary)) {
      console.log(`[fetch-node] ${path.relative(PROJECT_ROOT, vendorBinary)} already reports ${NODE_VERSION}, nothing to do`);
      return;
    }
    console.log(`[fetch-node] ${path.relative(PROJECT_ROOT, vendorBinary)} exists but is not ${NODE_VERSION}, re-fetching`);
  }

  await fetchNodeBinary(platform, arch);
}

main().catch((err) => {
  console.error(`[fetch-node] ${err.message}`);
  process.exitCode = 1;
});
