import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { ListResult, PersistenceLevel } from "./types.js";

export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number, cursor?: string): Promise<ListResult>;
  hydrate(): Promise<void>;
}

// ── Memory store ──────────────────────────────────────────────────────────────

export class MemoryStore implements Store {
  private data = new Map<string, unknown>();

  async hydrate() {}

  async get(key: string) {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: unknown) {
    this.data.set(key, value);
  }

  async delete(key: string) {
    this.data.delete(key);
  }

  async list(prefix: string, limit?: number, cursor?: string): Promise<ListResult> {
    // Sort keys for stable cursor-based pagination.
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();

    const startIdx = cursor ? keys.findIndex((k) => k > cursor) : 0;
    // cursor is past all keys — no more results
    if (startIdx === -1) return { entries: {}, nextCursor: undefined };

    const slice = limit ? keys.slice(startIdx, startIdx + limit) : keys.slice(startIdx);

    const entries: Record<string, unknown> = {};
    for (const k of slice) entries[k] = this.data.get(k);

    const nextCursor =
      limit && startIdx + limit < keys.length
        ? slice[slice.length - 1]
        : undefined;

    return { entries, nextCursor };
  }
}

// ── Durable Object storage store ─────────────────────────────────────────────

export class DOStore implements Store {
  constructor(private storage: DurableObjectStorage) {}

  async hydrate() {}

  async get(key: string) {
    return (await this.storage.get<unknown>(key)) ?? null;
  }

  async set(key: string, value: unknown) {
    await this.storage.put(key, value);
  }

  async delete(key: string) {
    await this.storage.delete(key);
  }

  async list(prefix: string, limit?: number, cursor?: string): Promise<ListResult> {
    const opts: { prefix: string; limit?: number; startAfter?: string } = { prefix };
    if (limit) opts.limit = limit;
    if (cursor) opts.startAfter = cursor;

    const map = await this.storage.list<unknown>(opts);
    const entries: Record<string, unknown> = {};
    let lastKey: string | undefined;

    for (const [k, v] of map) {
      entries[k] = v;
      lastKey = k;
    }

    const nextCursor =
      limit && map.size === limit ? lastKey : undefined;

    return { entries, nextCursor };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createStore(
  level: PersistenceLevel,
  storage: DurableObjectStorage
): Store {
  if (level === "storage") return new DOStore(storage);
  return new MemoryStore();
}
