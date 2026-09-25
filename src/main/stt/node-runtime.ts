// Locate a plain Node.js runtime to host the STT worker outside Electron.
// Electron's allocator (PartitionAlloc) can't hold the biggest CPU model in
// one allocation; a real node binary can. A Node.js >= 22 child process is
// therefore preferred wherever one can be found.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** Minimum Node.js major version the STT worker needs. */
const MIN_MAJOR = 22;

/** Injectable environment for findNodeRuntime; defaultNodeRuntime() is the real one. */
export interface NodeRuntimeDeps {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  /** Runs `<path> --version`; null when that can't be executed. */
  version(path: string): string | null;
  /** Optional sink for fallback warnings; defaultNodeRuntime uses console.warn. */
  warn?(message: string): void;
}

/**
 * Returns the Node.js executable to host the STT worker with, or null when no
 * usable Node.js >= 22 is available (the caller keeps the Electron
 * utilityProcess fallback). Resolution order, first match wins:
 *
 * 1. CHIRP_NODE — an explicit path; unusable paths return null without
 *    falling through, and "0" disables the Node runtime entirely.
 * 2. Packaged app — the bundled binary at `<resourcesPath>/node/<node>`.
 * 3. Dev — `node` resolved from PATH (falling back to the bare command name).
 */
export function findNodeRuntime(opts: NodeRuntimeDeps): string | null {
  const override = (opts.env.CHIRP_NODE ?? "").trim();
  if (override !== "") {
    if (override === "0") return null;
    return usable(opts, override, `CHIRP_NODE=${override}`);
  }

  if (opts.isPackaged) {
    const bundled = bundledPath(opts);
    return usable(opts, bundled, bundled);
  }

  const bin = opts.platform === "win32" ? "node.exe" : "node";
  const found = which(opts, bin);
  if (found && usable(opts, found)) return found;
  return usable(opts, bin);
}

/** A candidate counts only if `<path> --version` reports a stable >= MIN_MAJOR. */
function usable(opts: NodeRuntimeDeps, path: string, complain?: string): string | null {
  // Exact "vX.Y.Z" only, so prerelease builds ("v22.0.0-rc.1") and odd
  // version-like strings are rejected too.
  const major = /^v?(\d+)\.\d+\.\d+$/.exec(opts.version(path) ?? "")?.[1];
  if (major !== undefined && Number(major) >= MIN_MAJOR) return path;
  // Only a pinned candidate (explicit CHIRP_NODE, the packaged binary) warns;
  // a dev box without a usable Node.js is normal and stays quiet.
  if (complain !== undefined)
    opts.warn?.(`${complain} is not a usable Node.js >= ${MIN_MAJOR}; falling back to the Electron runtime`);
  return null;
}

/** `<resourcesPath>/node/node(.exe)` as the packaging side ships it. */
function bundledPath(opts: NodeRuntimeDeps): string {
  const dirSep = opts.platform === "win32" ? "\\" : "/";
  const exe = opts.platform === "win32" ? "node.exe" : "node";
  const root = opts.resourcesPath.replace(/[\\/]+$/, "");
  return `${root}${dirSep}node${dirSep}${exe}`;
}

/** Which-like PATH lookup; the match check goes through opts.exists. */
function which(opts: NodeRuntimeDeps, bin: string): string | null {
  const listSep = opts.platform === "win32" ? ";" : ":";
  const dirSep = opts.platform === "win32" ? "\\" : "/";
  for (const dir of (opts.env.PATH ?? "").split(listSep)) {
    const clean = dir.replace(/[\\/]+$/, "");
    if (clean === "") continue;
    const full = `${clean}${dirSep}${bin}`;
    if (opts.exists(full)) return full;
  }
  return null;
}

/**
 * The default environment: the real fs, `--version` probes through
 * child_process, and Electron's app for the packaged/dev distinction.
 */
export function defaultNodeRuntime(): NodeRuntimeDeps {
  const { app } = requireElectron();
  return {
    env: process.env,
    isPackaged: app?.isPackaged ?? false,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    warn: console.warn,
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    version: (path) => {
      try {
        return execFileSync(path, ["--version"], { timeout: 5000, windowsHide: true }).toString().trim();
      } catch {
        return null;
      }
    },
  };
}

// Lazy: this module is also imported by tests that run outside Electron,
// where importing the electron API for real would fail.
function requireElectron(): typeof import("electron") {
  return createRequire(import.meta.url)("electron") as typeof import("electron");
}
