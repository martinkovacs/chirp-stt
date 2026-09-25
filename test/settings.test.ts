import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types.ts";
import { SettingsStore } from "../src/main/settings.ts";

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chirp-settings-test-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSettingsFile(obj: unknown): void {
  fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify(obj), "utf8");
}

describe("SettingsStore", () => {
  it("returns defaults when no file exists, creating the dir", () => {
    const dir = path.join(tmp, "deep", "nested", "dir");
    const store = new SettingsStore(dir);
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    assert.ok(fs.existsSync(path.join(dir, "settings.json")) === false, "no file until first write");
  });

  it("loads and merges a valid file over defaults", () => {
    const file = path.join(tmp, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ targetLanguage: "hu", appendSpace: false }), "utf8");
    const store = new SettingsStore(tmp);
    assert.equal(store.get().targetLanguage, "hu");
    assert.equal(store.get().appendSpace, false);
    assert.equal(store.get().sourceLanguage, DEFAULT_SETTINGS.sourceLanguage);
  });

  it("ignores unknown keys and wrong-typed values", () => {
    writeSettingsFile({
      evil: "删除",
      hotkeyBackend: "not-a-backend",
      outputMode: 42,
      pasteCombo: "meta+z",
      sinkFilter: { deep: true },
      appendSpace: "yes",
    });
    const store = new SettingsStore(tmp);
    const s = store.get();
    assert.equal("evil" in s, false);
    assert.equal(s.hotkeyBackend, "auto");
    assert.equal(s.outputMode, "paste");
    assert.equal(s.pasteCombo, "ctrl+v");
    assert.equal(s.appendSpace, true);
  });

  it("sanitizes languages not present in LANGUAGES", () => {
    writeSettingsFile({ sourceLanguage: "zz", targetLanguage: "xx" });
    const store = new SettingsStore(tmp);
    assert.equal(store.get().sourceLanguage, DEFAULT_SETTINGS.sourceLanguage);
    assert.equal(store.get().targetLanguage, DEFAULT_SETTINGS.targetLanguage);
  });

  it("resets a non-English translation pair to English output", () => {
    writeSettingsFile({ sourceLanguage: "hu", targetLanguage: "de" });
    assert.equal(new SettingsStore(tmp).get().targetLanguage, "en");
    const store = new SettingsStore(path.join(tmp, "pair-case"));
    store.update({ sourceLanguage: "en", targetLanguage: "de" });
    assert.equal(store.get().targetLanguage, "de", "en→X is supported");
    assert.equal(store.update({ sourceLanguage: "fr" }).targetLanguage, "en");
  });

  it("survives corrupt JSON: defaults + .bak of the corrupt file", () => {
    const file = path.join(tmp, "settings.json");
    fs.writeFileSync(file, "{not json]]", "utf8");
    const store = new SettingsStore(tmp);
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    assert.ok(fs.existsSync(file + ".bak"), "corrupt file backed up");
    assert.equal(fs.readFileSync(file + ".bak", "utf8"), "{not json]]");
  });

  it("writes atomically and round-trips", () => {
    const dir = path.join(tmp, "atomic-case");
    const store = new SettingsStore(dir);
    const next = store.update({ sourceLanguage: "de", evdevKey: "KEY_LEFTCTRL" });
    assert.equal(next.sourceLanguage, "de");
    const file = path.join(dir, "settings.json");
    assert.ok(fs.existsSync(file), "settings.json written");
    assert.ok(!fs.existsSync(file + ".tmp"), "no leftover tmp after rename");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.sourceLanguage, "de");
    assert.equal(parsed.evdevKey, "KEY_LEFTCTRL");
    // Reload sees persisted state.
    const store2 = new SettingsStore(dir);
    assert.equal(store2.get().evdevKey, "KEY_LEFTCTRL");
  });

  it("update() sanitizes out-of-range patch values", () => {
    const store = new SettingsStore(path.join(tmp, "patch-case"));
    const next = store.update({ sourceLanguage: "qq", hotkeyBackend: "evdev", appendSpace: false });
    assert.equal(next.sourceLanguage, DEFAULT_SETTINGS.sourceLanguage);
    assert.equal(next.hotkeyBackend, "evdev");
    assert.equal(next.appendSpace, false);
  });

  it("emits 'change' (next, prev) only when something actually changed", () => {
    const store = new SettingsStore(path.join(tmp, "event-case"));
    const storeCopy = store.get();
    let fired = 0;
    const events: Array<[object, object]> = [];
    store.on("change", (nxt: object, prev: object) => {
      fired++;
      events.push([nxt, prev]);
    });
    // No-op update: unchanged values do not emit or write.
    assert.equal(store.update(storeCopy).appendSpace, storeCopy.appendSpace);
    assert.equal(fired, 0);
    void events;
    store.update({ outputMode: "clipboard" });
    assert.equal(fired, 1);
    assert.equal(events[0]![1] !== undefined, true);
    const changed = store.get();
    assert.equal(changed.outputMode, "clipboard");
  });

  it("get() returns a copy: mutations never persist", () => {
    const dir = path.join(tmp, "copy-case");
    const store = new SettingsStore(dir);
    store.get().sourceLanguage = "cs";
    assert.equal(new SettingsStore(dir).get().sourceLanguage, DEFAULT_SETTINGS.sourceLanguage);
  });
});
