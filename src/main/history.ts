// History of transcriptions: history.json, newest first, capped at 200. Pure node.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryEntry } from "../shared/types.ts";

const MAX_ENTRIES = 200;
const FLUSH_MS = 500;

export class HistoryStore extends EventEmitter {
  readonly #file: string;
  #entries: HistoryEntry[] = [];
  #timer: NodeJS.Timeout | undefined;
  #writing = false;

  constructor(dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, "history.json");
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      if (Array.isArray(parsed)) {
        this.#entries = parsed.filter(isEntry).slice(0, MAX_ENTRIES);
      }
    } catch {
      /* missing or corrupt starts empty */
    }
  }

  list(): HistoryEntry[] {
    return this.#entries
      .map((e) => ({ ...e }))
      .sort((a, b) => b.at - a.at);
  }

  add(e: HistoryEntry): void {
    this.#entries.push({ ...e });
    this.#entries.sort((a, b) => b.at - a.at);
    this.#entries = this.#entries.slice(0, MAX_ENTRIES);
    this.#scheduleWrite();
    this.emit("change");
  }

  remove(at: number): boolean {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.at !== at);
    if (this.#entries.length === before) return false;
    this.#scheduleWrite();
    this.emit("change");
    return true;
  }

  clear(): void {
    this.#entries = [];
    this.flush();
    this.emit("change");
  }

  /** Cancel the pending debounce and write synchronously (app quit). */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#write();
  }

  #scheduleWrite(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#write();
    }, FLUSH_MS);
  }

  #write(): void {
    if (this.#writing) return; // at most one write in flight; a fresh timer re-runs
    this.#writing = true;
    const tmp = this.#file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.#entries), "utf8");
      fs.renameSync(tmp, this.#file);
    } finally {
      this.#writing = false;
    }
  }
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.at === "number" &&
    typeof o.text === "string" &&
    typeof o.sourceLanguage === "string" &&
    typeof o.targetLanguage === "string" &&
    typeof o.audioMs === "number" &&
    (o.finalMs === undefined || typeof o.finalMs === "number")
  );
}
