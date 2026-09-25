import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findNodeRuntime, type NodeRuntimeDeps } from "../src/main/stt/node-runtime.ts";

interface Fake {
  /** Finds of version(): path -> --version output, undefined = never asked. */
  versions: Map<string, string | undefined>;
  /** Paths reported to exist(). */
  files: Set<string>;
  /** Order of version() calls. */
  calls: string[];
}

function deps(fake: Fake, over: Partial<NodeRuntimeDeps> = {}): NodeRuntimeDeps {
  return {
    env: {},
    isPackaged: false,
    resourcesPath: "/app/resources",
    platform: "linux",
    exists: (p) => fake.files.has(p),
    version: (p) => {
      fake.calls.push(p);
      const out = fake.versions.get(p);
      return out === undefined || out === null ? null : out;
    },
    ...over,
  };
}

const GOOD = "v24.21.0";
const OLD = "v21.7.3";
const PATH_NODE = "/usr/local/bin/node";

describe("findNodeRuntime", () => {
  it("resolves node from PATH in dev, first dir wins", () => {
    const fake: Fake = { versions: new Map(Object.entries({ [PATH_NODE]: GOOD })), files: new Set([PATH_NODE, "/usr/bin/node"]), calls: [] };
    fake.versions.set("/usr/bin/node", GOOD);
    const r = findNodeRuntime(deps(fake, { env: { PATH: "/usr/bin:/usr/local/bin" } }));
    assert.equal(r, "/usr/bin/node");
  });

  it("returns the bare command when the PATH scan misses but node exists", () => {
    const fake: Fake = { versions: new Map([["node", GOOD]]), files: new Set(), calls: [] };
    const r = findNodeRuntime(deps(fake, { env: { PATH: "/usr/bin" } }));
    assert.equal(r, "node");
  });

  it("rejects Node.js older than 22", () => {
    for (const bad of [OLD, "v22.0.0-beta.1", "16.0.0", "garbage"]) {
      const fake: Fake = { versions: new Map([[PATH_NODE, bad]]), files: new Set([PATH_NODE]), calls: [] };
      assert.equal(findNodeRuntime(deps(fake, { env: { PATH: "/usr/local/bin" } })), null, `rejects: ${bad}`);
    }
    const good: Fake = { versions: new Map([[PATH_NODE, "v22.0.0"]]), files: new Set([PATH_NODE]), calls: [] };
    assert.equal(findNodeRuntime(deps(good, { env: { PATH: "/usr/local/bin" } })), PATH_NODE, "v22.0.0 is fine");
  });

  it("picks the packaged bundled binary per platform", () => {
    const win: Fake = { versions: new Map([["C:\\app\\resources\\node\\node.exe", GOOD]]), files: new Set(), calls: [] };
    assert.equal(
      findNodeRuntime(deps(win, { isPackaged: true, resourcesPath: "C:\\app\\resources", platform: "win32" })),
      "C:\\app\\resources\\node\\node.exe",
    );
    const linux: Fake = { versions: new Map([["/app/resources/node/node", GOOD]]), files: new Set(), calls: [] };
    assert.equal(
      findNodeRuntime(deps(linux, { isPackaged: true, resourcesPath: "/app/resources", platform: "linux" })),
      "/app/resources/node/node",
    );
  });

  it("returns null when the packaged binary is unusable (no dev fallback)", () => {
    const fake: Fake = { versions: new Map([[PATH_NODE, GOOD]]), files: new Set([PATH_NODE]), calls: [] };
    const r = findNodeRuntime(deps(fake, {
      env: { PATH: "/usr/local/bin" },
      isPackaged: true,
      platform: "linux",
    }));
    assert.equal(r, null);
    assert.deepEqual(fake.calls, ["/app/resources/node/node"], "only the bundled path was probed");
  });

  it("CHIRP_NODE overrides everything", () => {
    const explicit = "/opt/node/bin/node";
    const fake: Fake = { versions: new Map(Object.entries({ [explicit]: GOOD, [PATH_NODE]: GOOD })), files: new Set([PATH_NODE]), calls: [] };
    const r = findNodeRuntime(deps(fake, {
      env: { PATH: "/usr/local/bin", CHIRP_NODE: explicit },
      isPackaged: true,
      platform: "linux",
    }));
    assert.equal(r, explicit);
    assert.deepEqual(fake.calls, [explicit], "nothing else was probed");
  });

  it("CHIRP_NODE that is set but unusable returns null without falling through", () => {
    const broken = "/usr/bin/nodejs-old";
    const fake: Fake = { versions: new Map([[PATH_NODE, GOOD]]), files: new Set([PATH_NODE]), calls: [] };
    fake.versions.set(broken, OLD);
    const r = findNodeRuntime(deps(fake, {
      env: { PATH: "/usr/local/bin", CHIRP_NODE: broken },
      isPackaged: true,
      platform: "linux",
    }));
    assert.equal(r, null);
    assert.deepEqual(fake.calls, [broken]);
  });

  it("CHIRP_NODE=0 disables the Node runtime entirely", () => {
    for (const value of ["0", " 0 "]) {
      const fake: Fake = { versions: new Map([[PATH_NODE, GOOD]]), files: new Set([PATH_NODE]), calls: [] };
      const r = findNodeRuntime(deps(fake, {
        env: { PATH: "/usr/local/bin", CHIRP_NODE: value },
        isPackaged: true,
        platform: "linux",
      }));
      assert.equal(r, null, `CHIRP_NODE=${JSON.stringify(value)}`);
      assert.deepEqual(fake.calls, [], "no version probe ran");
    }
  });

  it("an empty CHIRP_NODE behaves like unset", () => {
    const fake: Fake = { versions: new Map([[PATH_NODE, GOOD]]), files: new Set([PATH_NODE]), calls: [] };
    const r = findNodeRuntime(deps(fake, { env: { PATH: "/usr/local/bin", CHIRP_NODE: "" } }));
    assert.equal(r, PATH_NODE);
  });
});
