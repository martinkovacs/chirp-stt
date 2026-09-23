import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { HistoryStore } from "../src/main/history.ts";
import type { HistoryEntry } from "../src/shared/types.ts";

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chirp-history-test-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function entry(at: number, text = `t${at}`): HistoryEntry {
  return { at, text, sourceLanguage: "hu", targetLanguage: "en", audioMs: 1000 };
}

describe("HistoryStore", () => {
  it("remove() deletes the matching entry, emits change and persists", async () => {
    const dir = path.join(tmp, "remove-case");
    const store = new HistoryStore(dir);
    store.add(entry(2000));
    store.add(entry(1000));

    let changed = 0;
    store.on("change", () => changed++);

    assert.equal(store.remove(1000), true);
    assert.equal(changed, 1);
    assert.deepEqual(store.list().map((e) => e.at), [2000]);

    store.flush();
    const reloaded = new HistoryStore(dir);
    assert.deepEqual(reloaded.list().map((e) => e.at), [2000]);
    store.flush();
  });

  it("remove() with unknown timestamp returns false and emits nothing", () => {
    const dir = path.join(tmp, "remove-miss-case");
    const store = new HistoryStore(dir);
    store.add(entry(3000));

    let changed = 0;
    store.on("change", () => changed++);

    assert.equal(store.remove(9999), false);
    assert.equal(changed, 0);
    assert.deepEqual(store.list().map((e) => e.at), [3000]);

    store.flush();
  });
});
