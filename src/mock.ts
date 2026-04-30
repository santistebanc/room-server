// In-memory implementation of `IRoomClient` for unit tests. Multiple
// `MockRoomClient` instances connecting to the same `(apiKey, roomId)` share
// state and observe each other's changes — making it possible to test
// multi-client flows without booting a real server.
//
// Limitations vs the real server:
//  - No rate limiting.
//  - Alarms run via setTimeout/setInterval, not Durable Object alarms.
//  - No HTTP REST surface.
//  - `status` only ever moves "connecting" → "ready" → "closed" (no reconnect).

import { MemoryStore } from "./persistence.js";
import {
  RoomError,
  type BroadcastHandler,
  type ChangeEvent,
  type ChangeHandler,
  type DeletePrefixResult,
  type IRoomClient,
  type RoomClientEvents,
  type SetIfResult,
  type SetOptions,
  type SnapshotRequest,
  type Status,
  type SubscribeOptions,
  type UnsubscribeFn,
} from "./client.js";
import type {
  AlarmAction,
  ConnectConfig,
  ListResult,
  SnapshotResult,
} from "./types.js";

const META = "__rs/";

interface MockHandler {
  handler: ChangeHandler;
  includeSelf: boolean;
}

interface MockSubGroup {
  kind: "key" | "prefix";
  target: string;
  handlers: Set<MockHandler>;
}

interface MockConn {
  id: string;
  subs: Map<string, MockSubGroup>;
  broadcastHandlers: Map<string, Set<BroadcastHandler>>;
}

interface RecurringJob {
  interval: number;
  action: AlarmAction;
  timer: ReturnType<typeof setInterval>;
}

interface OneShotAlarm {
  action: AlarmAction | undefined;
  timer: ReturnType<typeof setTimeout>;
}

class MockRoom {
  store = new MemoryStore();
  connections = new Set<MockConn>();
  ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  alarm: OneShotAlarm | null = null;
  recurring: RecurringJob | null = null;

  async notifyChange(
    type: "set" | "delete",
    key: string,
    value: unknown,
    originConnId: string | null
  ) {
    const event: ChangeEvent =
      type === "set"
        ? { type: "set", key, value, originConnId }
        : { type: "delete", key, originConnId };

    for (const conn of this.connections) {
      const isSource = originConnId !== null && conn.id === originConnId;

      let matched = false;
      let includeSelf = false;

      for (const group of conn.subs.values()) {
        const groupMatches =
          group.kind === "key"
            ? key === group.target
            : key.startsWith(group.target);
        if (!groupMatches) continue;
        matched = true;
        for (const h of group.handlers) {
          if (h.includeSelf) includeSelf = true;
        }
      }

      if (!matched) continue;
      if (isSource && !includeSelf) continue;

      for (const group of conn.subs.values()) {
        const groupMatches =
          group.kind === "key"
            ? key === group.target
            : key.startsWith(group.target);
        if (!groupMatches) continue;
        for (const h of group.handlers) {
          if (isSource && !h.includeSelf) continue;
          try {
            h.handler(event);
          } catch (err) {
            console.error("[mock] change handler threw", err);
          }
        }
      }
    }
  }

  notifyBroadcast(channel: string, data: unknown, originConnId: string) {
    for (const conn of this.connections) {
      if (conn.id === originConnId) continue;
      const handlers = conn.broadcastHandlers.get(channel);
      if (!handlers) continue;
      for (const h of handlers) {
        try { h(data); } catch (err) {
          console.error("[mock] broadcast handler threw", err);
        }
      }
    }
  }

  async executeAction(action: AlarmAction) {
    switch (action.op) {
      case "set":
        await this.store.set(action.key, action.value);
        await this.notifyChange("set", action.key, action.value, null);
        break;
      case "delete":
        await this.store.delete(action.key);
        await this.notifyChange("delete", action.key, null, null);
        break;
      case "increment": {
        const current = await this.store.get(action.key);
        const next =
          (typeof current === "number" ? current : 0) + (action.delta ?? 1);
        await this.store.set(action.key, next);
        await this.notifyChange("set", action.key, next, null);
        break;
      }
      case "broadcast":
        for (const conn of this.connections) {
          const handlers = conn.broadcastHandlers.get(action.channel);
          if (!handlers) continue;
          for (const h of handlers) {
            try { h(action.data); } catch {}
          }
        }
        break;
    }
  }

  scheduleTTL(key: string, ttlSeconds: number) {
    this.clearTTL(key);
    const timer = setTimeout(async () => {
      this.ttlTimers.delete(key);
      await this.store.delete(key);
      await this.notifyChange("delete", key, null, null);
    }, ttlSeconds * 1000);
    this.ttlTimers.set(key, timer);
  }

  clearTTL(key: string) {
    const t = this.ttlTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.ttlTimers.delete(key);
    }
  }

  hasTTL(key: string): boolean {
    return this.ttlTimers.has(key);
  }

  destroy() {
    for (const t of this.ttlTimers.values()) clearTimeout(t);
    this.ttlTimers.clear();
    if (this.alarm) clearTimeout(this.alarm.timer);
    this.alarm = null;
    if (this.recurring) clearInterval(this.recurring.timer);
    this.recurring = null;
    this.connections.clear();
  }
}

const rooms = new Map<string, MockRoom>();

function getRoom(apiKey: string, roomId: string): MockRoom {
  const key = `${apiKey}:${roomId}`;
  let room = rooms.get(key);
  if (!room) {
    room = new MockRoom();
    rooms.set(key, room);
  }
  return room;
}

/** Tear down all mock rooms. Call between tests for isolation. */
export function resetMockRooms() {
  for (const room of rooms.values()) room.destroy();
  rooms.clear();
}

let connCounter = 0;

export interface MockRoomClientOptions {
  roomId: string;
  config: ConnectConfig;
  /** Ignored — accepted so the constructor signature mirrors `RoomClient`. */
  host?: string;
}

export class MockRoomClient implements IRoomClient {
  private room: MockRoom;
  private conn: MockConn;
  private listeners: { [E in keyof RoomClientEvents]: Set<(p: RoomClientEvents[E]) => void> } = {
    status: new Set(),
    rateLimit: new Set(),
  };

  private _status: Status = "connecting";
  private _connectionId: string;
  private closed = false;

  debug = false;

  constructor(opts: MockRoomClientOptions) {
    const { roomId, config } = opts;
    this.room = getRoom(config.apiKey, roomId);
    this._connectionId = `mock-${++connCounter}`;
    this.conn = {
      id: this._connectionId,
      subs: new Map(),
      broadcastHandlers: new Map(),
    };
    this.room.connections.add(this.conn);

    const presenceKey = `presence/${this._connectionId}`;
    const presenceValue = { connectedAt: Date.now() };
    queueMicrotask(async () => {
      await this.room.store.set(presenceKey, presenceValue);
      await this.room.notifyChange("set", presenceKey, presenceValue, this._connectionId);
      this.setStatus("ready");
    });
  }

  // ── Status / events ─────────────────────────────────────────────────────────

  get status(): Status {
    return this._status;
  }

  get connectionId(): string | null {
    return this.closed ? null : this._connectionId;
  }

  on<E extends keyof RoomClientEvents>(
    event: E,
    handler: (payload: RoomClientEvents[E]) => void
  ): UnsubscribeFn {
    this.listeners[event].add(handler as (p: RoomClientEvents[E]) => void);
    return () => {
      this.listeners[event].delete(handler as (p: RoomClientEvents[E]) => void);
    };
  }

  private emit<E extends keyof RoomClientEvents>(event: E, payload: RoomClientEvents[E]) {
    for (const h of this.listeners[event]) {
      try { h(payload); } catch (err) {
        console.error("[mock] listener threw", err);
      }
    }
  }

  private setStatus(s: Status) {
    if (this._status === s) return;
    this._status = s;
    this.emit("status", s);
  }

  // ── Handshake ───────────────────────────────────────────────────────────────

  async ready(): Promise<void> {
    if (this._status === "ready") return;
    if (this._status === "closed") throw new RoomError("Disconnected");
    return new Promise<void>((resolve, reject) => {
      const off = this.on("status", (s) => {
        if (s === "ready") {
          off();
          resolve();
        } else if (s === "closed") {
          off();
          reject(new RoomError("Disconnected"));
        }
      });
    });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async set(key: string, value: unknown, opts?: SetOptions): Promise<void> {
    this.assertOpen();
    this.assertWritable(key);
    await this.room.store.set(key, value);
    if (opts?.ttl) this.room.scheduleTTL(key, opts.ttl);
    else this.room.clearTTL(key);
    await this.room.notifyChange("set", key, value, this._connectionId);
  }

  async get(key: string): Promise<unknown> {
    this.assertOpen();
    if (key.startsWith(META)) return null;
    return this.room.store.get(key);
  }

  async delete(key: string): Promise<void> {
    this.assertOpen();
    this.assertWritable(key);
    await this.room.store.delete(key);
    this.room.clearTTL(key);
    await this.room.notifyChange("delete", key, null, this._connectionId);
  }

  async list(
    prefix: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<ListResult> {
    this.assertOpen();
    return listUserKeys(this.room, prefix, opts?.limit, opts?.cursor);
  }

  // ── Atomic ops ──────────────────────────────────────────────────────────────

  async increment(key: string, delta = 1): Promise<number> {
    this.assertOpen();
    this.assertWritable(key);
    const current = await this.room.store.get(key);
    const next = (typeof current === "number" ? current : 0) + delta;
    await this.room.store.set(key, next);
    await this.room.notifyChange("set", key, next, this._connectionId);
    return next;
  }

  async setIf(key: string, value: unknown, ifValue: unknown): Promise<SetIfResult> {
    this.assertOpen();
    this.assertWritable(key);
    const current = await this.room.store.get(key);
    const match = deepEqual(current, ifValue);
    if (match) {
      await this.room.store.set(key, value);
      await this.room.notifyChange("set", key, value, this._connectionId);
    }
    return { success: match, current };
  }

  async touch(key: string, opts: { ttl: number }): Promise<void> {
    this.assertOpen();
    this.assertWritable(key);
    if (opts.ttl <= 0) throw new RoomError("ttl must be > 0");
    const current = await this.room.store.get(key);
    if (current === null || current === undefined) {
      throw new RoomError("Cannot touch key (does not exist or is null)");
    }
    this.room.scheduleTTL(key, opts.ttl);
  }

  async deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    this.assertOpen();
    if (prefix === "" || prefix.startsWith(META) || prefix.startsWith("presence/")) {
      throw new RoomError(
        prefix === "" ? "delete_prefix requires a non-empty prefix" : "Reserved key prefix"
      );
    }
    let deleted = 0;
    let cursor: string | undefined;
    while (true) {
      const page = await this.room.store.list(prefix, 128, cursor);
      const keys = Object.keys(page.entries);
      for (const k of keys) {
        if (k.startsWith(META)) continue;
        await this.room.store.delete(k);
        this.room.clearTTL(k);
        await this.room.notifyChange("delete", k, null, this._connectionId);
        deleted++;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { deleted };
  }

  async snapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    this.assertOpen();
    const keysOut: Record<string, unknown> = {};
    const prefixesOut: Record<string, Record<string, unknown>> = {};

    if (req.keys) {
      for (const k of req.keys) {
        if (k.startsWith(META)) continue;
        keysOut[k] = await this.room.store.get(k);
      }
    }
    if (req.prefixes) {
      for (const p of req.prefixes) {
        if (p !== "" && !p.endsWith("/")) {
          throw new RoomError("Prefix must end with '/' or be empty string");
        }
        const out: Record<string, unknown> = {};
        let cursor: string | undefined;
        while (true) {
          const page = await listUserKeys(this.room, p, 128, cursor);
          Object.assign(out, page.entries);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
          if (Object.keys(out).length >= 10_000) break;
        }
        prefixesOut[p] = out;
      }
    }

    return { keys: keysOut, prefixes: prefixesOut };
  }

  // ── Scheduled alarms ────────────────────────────────────────────────────────

  async scheduleAlarm(delay: number, action?: AlarmAction): Promise<void> {
    this.assertOpen();
    if (delay < 0) throw new RoomError("delay must be >= 0");
    if (this.room.alarm) clearTimeout(this.room.alarm.timer);
    const timer = setTimeout(async () => {
      this.room.alarm = null;
      if (action) {
        try { await this.room.executeAction(action); } catch {}
      }
    }, delay * 1000);
    this.room.alarm = { action, timer };
  }

  async cancelAlarm(): Promise<void> {
    this.assertOpen();
    if (this.room.alarm) {
      clearTimeout(this.room.alarm.timer);
      this.room.alarm = null;
    }
  }

  async scheduleRecurring(interval: number, action: AlarmAction): Promise<void> {
    this.assertOpen();
    if (interval <= 0) throw new RoomError("interval must be > 0");
    if (this.room.recurring) clearInterval(this.room.recurring.timer);
    const timer = setInterval(async () => {
      try { await this.room.executeAction(action); } catch {}
    }, interval * 1000);
    this.room.recurring = { interval, action, timer };
  }

  async cancelRecurring(): Promise<void> {
    this.assertOpen();
    if (this.room.recurring) {
      clearInterval(this.room.recurring.timer);
      this.room.recurring = null;
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  subscribeKey(
    key: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    if (key.startsWith(META)) {
      throw new RoomError("Reserved key prefix");
    }
    return this.addSubscription("key", key, handler, opts?.includeSelf === true);
  }

  subscribePrefix(
    prefix: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    if (prefix !== "" && !prefix.endsWith("/")) {
      throw new Error(
        `room-server: subscribePrefix("${prefix}") requires a trailing "/" or empty string. Use subscribeKey for exact matches.`
      );
    }
    if (prefix.startsWith(META)) {
      throw new RoomError("Reserved key prefix");
    }
    return this.addSubscription("prefix", prefix, handler, opts?.includeSelf === true);
  }

  private addSubscription(
    kind: "key" | "prefix",
    target: string,
    handler: ChangeHandler,
    includeSelf: boolean
  ): UnsubscribeFn {
    const subKey = `${kind}:${target}`;
    let group = this.conn.subs.get(subKey);
    if (!group) {
      group = { kind, target, handlers: new Set() };
      this.conn.subs.set(subKey, group);
    }
    const entry: MockHandler = { handler, includeSelf };
    group.handlers.add(entry);
    return () => {
      const g = this.conn.subs.get(subKey);
      if (!g) return;
      g.handlers.delete(entry);
      if (g.handlers.size === 0) this.conn.subs.delete(subKey);
    };
  }

  // ── Broadcast ───────────────────────────────────────────────────────────────

  broadcast(channel: string, data: unknown): void {
    this.assertOpen();
    this.room.notifyBroadcast(channel, data, this._connectionId);
  }

  onBroadcast(channel: string, handler: BroadcastHandler): UnsubscribeFn {
    let handlers = this.conn.broadcastHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.conn.broadcastHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      this.conn.broadcastHandlers.get(channel)?.delete(handler);
    };
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  async flushAndDisconnect(): Promise<void> {
    this.disconnect();
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.room.connections.delete(this.conn);
    const presenceKey = `presence/${this._connectionId}`;
    void this.room.store.delete(presenceKey).then(() =>
      this.room.notifyChange("delete", presenceKey, null, this._connectionId)
    );
    this.setStatus("closed");
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private assertOpen() {
    if (this.closed) throw new RoomError("Disconnected");
  }

  private assertWritable(key: string) {
    if (key.startsWith(META) || key.startsWith("presence/")) {
      throw new RoomError("Reserved key prefix");
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function listUserKeys(
  room: MockRoom,
  prefix: string,
  limit?: number,
  cursor?: string
): Promise<ListResult> {
  const entries: Record<string, unknown> = {};
  let nextCursor: string | undefined;
  let fetchCursor = cursor;

  for (let i = 0; i < 20; i++) {
    const page = await room.store.list(prefix, limit, fetchCursor);
    let pageHadUserKeys = false;
    for (const [k, v] of Object.entries(page.entries)) {
      if (!k.startsWith(META)) {
        entries[k] = v;
        pageHadUserKeys = true;
      }
    }
    nextCursor = page.nextCursor;
    const userCount = Object.keys(entries).length;
    if (!nextCursor || (limit !== undefined && userCount >= limit)) break;
    fetchCursor = !pageHadUserKeys ? nextCursor : nextCursor;
  }

  if (limit) {
    const keys = Object.keys(entries);
    if (keys.length > limit) {
      const trimmed: Record<string, unknown> = {};
      for (const k of keys.slice(0, limit)) trimmed[k] = entries[k];
      return { entries: trimmed, nextCursor: keys[limit - 1] };
    }
  }

  return { entries, nextCursor };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[], ba = b as unknown[];
    return aa.length === ba.length && aa.every((v, i) => deepEqual(v, ba[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort(), bk = Object.keys(bo).sort();
  return ak.length === bk.length && ak.every((k, i) => bk[i] === k && deepEqual(ao[k], bo[k]));
}
