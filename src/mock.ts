// In-memory implementation of `IRoomClient` for unit tests. Multiple
// `MockRoomClient` instances connecting to the same `(apiKey, roomId)` share
// state and observe each other's changes — making it possible to test
// multi-client flows without booting a real server. Mirrors v3 surface:
// per-key rev, schemas, transact, count, subscribeWithSnapshot, etc.

import { MemoryStore } from "./persistence.js";
import { resolveSchema, validate } from "./validator.js";
import {
  RoomError,
  type BroadcastHandler,
  type ChangeEvent,
  type ChangeHandler,
  type ClientSchemaMap,
  type CountResult,
  type DeletePrefixResult,
  type GetResult,
  type IRoomClient,
  type IncrementResult,
  type InitialKeySnapshot,
  type InitialPrefixSnapshot,
  type ResolveKey,
  type RoomClientEvents,
  type RoomSchemaMap,
  type RoomSchemasConfig,
  type SetIfOptions,
  type SetIfResult,
  type SetOptions,
  type SetResult,
  type SnapshotRequest,
  type Status,
  type SubscribeOptions,
  type SubscribeWithSnapshotKeyResult,
  type SubscribeWithSnapshotPrefixResult,
  type TransactResult,
  type TypedChangeEvent,
  type UnsubscribeFn,
} from "./client.js";
import type {
  AlarmAction,
  ConnectConfig,
  JsonSchema,
  ListResult,
  SnapshotResult,
  TransactOp,
  TransactOpResult,
} from "./types.js";

const META = "__rs/";
const LIST_HARD_CAP = 10_000;
const COUNT_HARD_CAP = 100_000;

interface MockHandler {
  handler: ChangeHandler;
  includeSelf: boolean;
  batchMs?: number;
}

interface MockSubGroup {
  kind: "key" | "prefix";
  target: string;
  handlers: Set<MockHandler>;
}

interface MockConn {
  id: string;
  userId?: string;
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
  revs = new Map<string, number>();
  schemas: Record<string, JsonSchema> = {};
  schemaVersion = 0;
  connections = new Set<MockConn>();
  ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  alarm: OneShotAlarm | null = null;
  recurring: RecurringJob | null = null;

  getRev(key: string): number {
    return this.revs.get(key) ?? 0;
  }

  bumpRev(key: string): number {
    const next = this.getRev(key) + 1;
    this.revs.set(key, next);
    return next;
  }

  validate(key: string, value: unknown):
    | { key: string; schemaPattern: string; errors: { path: string; message: string }[] }
    | null
  {
    if (Object.keys(this.schemas).length === 0) return null;
    const match = resolveSchema(key, this.schemas);
    if (!match) return null;
    const errors = validate(value, match.schema);
    if (errors.length === 0) return null;
    return { key, schemaPattern: match.pattern, errors };
  }

  async notifyChange(
    type: "set" | "delete",
    key: string,
    value: unknown,
    rev: number,
    originConnId: string | null
  ) {
    // For "delete" the third arg is the prior value; for "set" it's the new value.
    const event: ChangeEvent =
      type === "set"
        ? { type: "set", key, value, rev, originConnId }
        : { type: "delete", key, priorValue: value ?? null, rev, originConnId };

    for (const conn of this.connections) {
      const isSource = originConnId !== null && conn.id === originConnId;

      // Determine match + min batchMs across all matching subs.
      let matched = false;
      let includeSelf = false;
      let immediateMatch = false;
      let minBatchMs: number | null = null;

      for (const group of conn.subs.values()) {
        const ok =
          group.kind === "key"
            ? key === group.target
            : key.startsWith(group.target);
        if (!ok) continue;
        matched = true;
        for (const h of group.handlers) {
          if (h.includeSelf) includeSelf = true;
          if (h.batchMs === undefined) immediateMatch = true;
          else if (minBatchMs === null || h.batchMs < minBatchMs) minBatchMs = h.batchMs;
        }
      }

      if (!matched) continue;
      if (isSource && !includeSelf) continue;

      const dispatchToHandlers = () => {
        for (const group of conn.subs.values()) {
          const ok =
            group.kind === "key"
              ? key === group.target
              : key.startsWith(group.target);
          if (!ok) continue;
          for (const h of group.handlers) {
            if (isSource && !h.includeSelf) continue;
            try { h.handler(event); } catch (err) {
              console.error("[mock] change handler threw", err);
            }
          }
        }
      };

      if (immediateMatch || minBatchMs === null) {
        dispatchToHandlers();
      } else {
        setTimeout(dispatchToHandlers, minBatchMs);
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
      case "set": {
        await this.store.set(action.key, action.value);
        const rev = this.bumpRev(action.key);
        await this.notifyChange("set", action.key, action.value, rev, null);
        break;
      }
      case "delete": {
        const priorValue = await this.store.get(action.key);
        await this.store.delete(action.key);
        const rev = this.bumpRev(action.key);
        await this.notifyChange("delete", action.key, priorValue, rev, null);
        break;
      }
      case "increment": {
        const current = await this.store.get(action.key);
        const next = (typeof current === "number" ? current : 0) + (action.delta ?? 1);
        await this.store.set(action.key, next);
        const rev = this.bumpRev(action.key);
        await this.notifyChange("set", action.key, next, rev, null);
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
      const priorValue = await this.store.get(key);
      await this.store.delete(key);
      const rev = this.bumpRev(key);
      await this.notifyChange("delete", key, priorValue, rev, null);
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
  schemas?: RoomSchemasConfig;
  /** Ignored — accepted so the constructor signature mirrors `RoomClient`. */
  host?: string;
}

export class MockRoomClient<S extends RoomSchemaMap = RoomSchemaMap>
  implements IRoomClient<S> {
  private room: MockRoom;
  private conn: MockConn;
  private clientSchemas?: ClientSchemaMap;
  private serverSchemas?: Record<string, JsonSchema>;
  private localSchemaVersion?: number;

  private listeners: { [E in keyof RoomClientEvents]: Set<(p: RoomClientEvents[E]) => void> } = {
    status: new Set(),
    rateLimit: new Set(),
  };

  private _status: Status = "connecting";
  private _connectionId: string;
  private closed = false;

  debug = false;

  constructor(opts: MockRoomClientOptions) {
    const { roomId, config, schemas } = opts;
    this.room = getRoom(config.apiKey, roomId);
    if (schemas) {
      this.clientSchemas = schemas.client;
      this.serverSchemas = schemas.server;
      this.localSchemaVersion = schemas.version;
    }
    this._connectionId = `mock-${++connCounter}`;
    this.conn = {
      id: this._connectionId,
      ...(config.userId !== undefined ? { userId: config.userId } : {}),
      subs: new Map(),
      broadcastHandlers: new Map(),
    };
    this.room.connections.add(this.conn);

    const presenceKey = `presence/${this._connectionId}`;
    const presenceValue: Record<string, unknown> = { connectedAt: Date.now() };
    if (config.userId) presenceValue["userId"] = config.userId;
    queueMicrotask(async () => {
      await this.room.store.set(presenceKey, presenceValue);
      const rev = this.room.bumpRev(presenceKey);
      await this.room.notifyChange("set", presenceKey, presenceValue, rev, this._connectionId);
      // Auto-register schemas before flipping to "ready", so consumers awaiting
      // ready() see the post-upload `schemaVersion` rather than the pre-upload one.
      await this.maybeRegisterServerSchemas();
      this.setStatus("ready");
    });
  }

  private async maybeRegisterServerSchemas() {
    if (!this.serverSchemas) return;
    if (this.localSchemaVersion === undefined) return;
    if (this.localSchemaVersion <= this.room.schemaVersion) return;
    try {
      await this.registerSchemas(this.serverSchemas, {
        replace: true,
        version: this.localSchemaVersion,
      });
    } catch (err) {
      if (err instanceof RoomError && err.kind === "schemaConflict") return;
      console.error("[mock] auto-register schemas failed:", err);
    }
  }

  get status(): Status { return this._status; }
  get connectionId(): string | null { return this.closed ? null : this._connectionId; }
  get schemaVersion(): number | null { return this.closed ? null : this.room.schemaVersion; }

  on<E extends keyof RoomClientEvents>(
    event: E,
    handler: (payload: RoomClientEvents[E]) => void
  ): UnsubscribeFn {
    this.listeners[event].add(handler as (p: RoomClientEvents[E]) => void);
    return () => {
      this.listeners[event].delete(handler as (p: RoomClientEvents[E]) => void);
    };
  }

  private setStatus(s: Status) {
    if (this._status === s) return;
    this._status = s;
    for (const h of this.listeners.status) {
      try { h(s); } catch (err) { console.error("[mock] listener threw", err); }
    }
  }

  async ready(): Promise<void> {
    if (this._status === "ready") return;
    if (this._status === "closed") throw new RoomError("Disconnected", { kind: "transient" });
    return new Promise<void>((resolve, reject) => {
      const off = this.on("status", (s) => {
        if (s === "ready") { off(); resolve(); }
        else if (s === "closed") { off(); reject(new RoomError("Disconnected", { kind: "transient" })); }
      });
    });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async set<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts?: SetOptions
  ): Promise<SetResult> {
    this.assertOpen();
    this.assertWritable(key);
    await this.maybeValidateLocal(key, value);
    const errs = this.room.validate(key, value);
    if (errs) {
      throw new RoomError(`Validation failed for "${key}"`, {
        kind: "validation",
        validationError: { key, schemaPattern: errs.schemaPattern, errors: errs.errors },
      });
    }
    await this.room.store.set(key, value);
    if (opts?.ttl) this.room.scheduleTTL(key, opts.ttl);
    else this.room.clearTTL(key);
    const rev = this.room.bumpRev(key);
    await this.room.notifyChange("set", key, value, rev, this._connectionId);
    return { rev };
  }

  async get<K extends string>(
    key: K
  ): Promise<{ value: ResolveKey<S, K> | null; rev: number }> {
    this.assertOpen();
    if (key.startsWith(META)) return { value: null, rev: 0 };
    const value = (await this.room.store.get(key)) as ResolveKey<S, K> | null;
    return { value, rev: this.room.getRev(key) };
  }

  async delete(key: string): Promise<SetResult> {
    this.assertOpen();
    this.assertWritable(key);
    const priorValue = await this.room.store.get(key);
    await this.room.store.delete(key);
    this.room.clearTTL(key);
    const rev = this.room.bumpRev(key);
    await this.room.notifyChange("delete", key, priorValue, rev, this._connectionId);
    return { rev };
  }

  async list(
    prefix: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<ListResult> {
    this.assertOpen();
    return listUserKeys(this.room, prefix, opts?.limit, opts?.cursor);
  }

  async count(prefix: string): Promise<CountResult> {
    this.assertOpen();
    let count = 0;
    let cursor: string | undefined;
    while (true) {
      const page = await this.room.store.list(prefix, 128, cursor);
      for (const k of Object.keys(page.entries)) {
        if (k.startsWith(META)) continue;
        count++;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (count >= COUNT_HARD_CAP) return { count, truncated: true };
    }
    return { count };
  }

  // ── Atomic ops ──────────────────────────────────────────────────────────────

  async increment(key: string, delta = 1): Promise<IncrementResult> {
    this.assertOpen();
    this.assertWritable(key);
    const current = await this.room.store.get(key);
    const next = (typeof current === "number" ? current : 0) + delta;
    await this.room.store.set(key, next);
    const rev = this.room.bumpRev(key);
    await this.room.notifyChange("set", key, next, rev, this._connectionId);
    return { value: next, rev };
  }

  async setIf<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts: SetIfOptions & SetOptions
  ): Promise<SetIfResult> {
    this.assertOpen();
    this.assertWritable(key);
    if (opts.ifValue !== undefined && opts.ifRev !== undefined) {
      throw new RoomError("Pass either ifValue or ifRev, not both", { kind: "invalid" });
    }
    const current = await this.room.store.get(key);
    const currentRev = this.room.getRev(key);
    let match: boolean;
    if (opts.ifRev !== undefined) match = currentRev === opts.ifRev;
    else                          match = deepEqual(current, opts.ifValue);

    if (match) {
      await this.maybeValidateLocal(key, value);
      const errs = this.room.validate(key, value);
      if (errs) {
        throw new RoomError(`Validation failed for "${key}"`, {
          kind: "validation",
          validationError: { key, schemaPattern: errs.schemaPattern, errors: errs.errors },
        });
      }
      await this.room.store.set(key, value);
      if (opts.ttl) this.room.scheduleTTL(key, opts.ttl);
      else          this.room.clearTTL(key);
      const rev = this.room.bumpRev(key);
      await this.room.notifyChange("set", key, value, rev, this._connectionId);
      return { success: true, current, rev };
    }
    return { success: false, current, rev: currentRev };
  }

  async update<K extends string>(
    key: K,
    fn: (current: ResolveKey<S, K> | null) => ResolveKey<S, K>
  ): Promise<{ value: ResolveKey<S, K>; rev: number }> {
    for (let i = 0; i < 5; i++) {
      const { value, rev } = await this.get(key);
      const next = fn(value);
      const result = await this.setIf(key, next, { ifRev: rev });
      if (result.success) return { value: next, rev: result.rev };
    }
    throw new RoomError(`update("${key}") failed after 5 retries`, { kind: "transient" });
  }

  async reserve<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts?: SetOptions
  ): Promise<boolean> {
    const result = await this.setIf(
      key,
      value,
      opts?.ttl !== undefined ? { ifRev: 0, ttl: opts.ttl } : { ifRev: 0 }
    );
    return result.success;
  }

  async touch(key: string, opts: { ttl: number }): Promise<void> {
    this.assertOpen();
    this.assertWritable(key);
    if (opts.ttl <= 0) throw new RoomError("ttl must be > 0", { kind: "invalid" });
    const current = await this.room.store.get(key);
    if (current === null || current === undefined) {
      throw new RoomError("Cannot touch key (does not exist or is null)", { kind: "invalid" });
    }
    this.room.scheduleTTL(key, opts.ttl);
  }

  async deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    this.assertOpen();
    if (prefix === "" || prefix.startsWith(META) || prefix.startsWith("presence/")) {
      throw new RoomError(
        prefix === "" ? "delete_prefix requires a non-empty prefix" : "Reserved key prefix",
        { kind: "invalid" }
      );
    }
    let deleted = 0;
    let cursor: string | undefined;
    while (true) {
      const page = await this.room.store.list(prefix, 128, cursor);
      const keys = Object.keys(page.entries);
      for (const k of keys) {
        if (k.startsWith(META)) continue;
        const priorValue = page.entries[k];
        await this.room.store.delete(k);
        this.room.clearTTL(k);
        const rev = this.room.bumpRev(k);
        await this.room.notifyChange("delete", k, priorValue, rev, this._connectionId);
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
    let truncated = false;

    if (req.keys) {
      for (const k of req.keys) {
        if (k.startsWith(META)) continue;
        keysOut[k] = await this.room.store.get(k);
      }
    }
    if (req.prefixes) {
      for (const p of req.prefixes) {
        if (p !== "" && !p.endsWith("/")) {
          throw new RoomError("Prefix must end with '/' or be empty string", { kind: "invalid" });
        }
        const out: Record<string, unknown> = {};
        let cursor: string | undefined;
        while (true) {
          const page = await listUserKeys(this.room, p, 128, cursor);
          Object.assign(out, page.entries);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
          if (Object.keys(out).length >= LIST_HARD_CAP) {
            truncated = true;
            break;
          }
        }
        prefixesOut[p] = out;
      }
    }

    if (truncated) return { keys: keysOut, prefixes: prefixesOut, truncated: true };
    return { keys: keysOut, prefixes: prefixesOut };
  }

  async transact(ops: TransactOp[]): Promise<TransactResult> {
    this.assertOpen();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.key.startsWith(META) || op.key.startsWith("presence/")) {
        return { success: false, results: [], error: `op ${i}: reserved key prefix` };
      }
    }

    // Phase 1: precondition check (with projection across same-key writes).
    const projected = new Map<string, { value: unknown; rev: number; deleted: boolean }>();
    const readCurrent = async (key: string): Promise<{ value: unknown; rev: number }> => {
      const p = projected.get(key);
      if (p) return { value: p.deleted ? null : p.value, rev: p.rev };
      const value = await this.room.store.get(key);
      return { value, rev: this.room.getRev(key) };
    };

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.op === "set_if") {
        const cur = await readCurrent(op.key);
        const ok = op.ifRev !== undefined
          ? cur.rev === op.ifRev
          : deepEqual(cur.value, op.ifValue);
        if (!ok) {
          return {
            success: false,
            results: [],
            error: `op ${i}: set_if precondition failed for "${op.key}"`,
          };
        }
      }
      const cur = await readCurrent(op.key);
      const nextRev = cur.rev + 1;
      if (op.op === "set" || op.op === "set_if") {
        projected.set(op.key, { value: op.value, rev: nextRev, deleted: false });
      } else if (op.op === "delete") {
        projected.set(op.key, { value: null, rev: nextRev, deleted: true });
      } else if (op.op === "increment") {
        const num = typeof cur.value === "number" ? cur.value : 0;
        projected.set(op.key, { value: num + (op.delta ?? 1), rev: nextRev, deleted: false });
      }
    }

    // Phase 2: validate.
    for (const [key, p] of projected) {
      if (p.deleted) continue;
      await this.maybeValidateLocal(key, p.value);
      const errs = this.room.validate(key, p.value);
      if (errs) {
        throw new RoomError(`Validation failed for "${key}"`, {
          kind: "validation",
          validationError: { key, schemaPattern: errs.schemaPattern, errors: errs.errors },
        });
      }
    }

    // Phase 3: apply.
    const results: TransactOpResult[] = [];
    const changes: { type: "set" | "delete"; key: string; value: unknown; rev: number }[] = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      switch (op.op) {
        case "set": {
          await this.room.store.set(op.key, op.value);
          this.room.clearTTL(op.key);
          if (op.ttl) this.room.scheduleTTL(op.key, op.ttl);
          const rev = this.room.bumpRev(op.key);
          results.push({ op: "set", key: op.key, rev });
          changes.push({ type: "set", key: op.key, value: op.value, rev });
          break;
        }
        case "delete": {
          const priorValue = await this.room.store.get(op.key);
          await this.room.store.delete(op.key);
          this.room.clearTTL(op.key);
          const rev = this.room.bumpRev(op.key);
          results.push({ op: "delete", key: op.key, rev });
          changes.push({ type: "delete", key: op.key, value: priorValue, rev });
          break;
        }
        case "increment": {
          const current = await this.room.store.get(op.key);
          const num = typeof current === "number" ? current : 0;
          const next = num + (op.delta ?? 1);
          await this.room.store.set(op.key, next);
          const rev = this.room.bumpRev(op.key);
          results.push({ op: "increment", key: op.key, rev, value: next });
          changes.push({ type: "set", key: op.key, value: next, rev });
          break;
        }
        case "set_if": {
          const current = await this.room.store.get(op.key);
          await this.room.store.set(op.key, op.value);
          this.room.clearTTL(op.key);
          if (op.ttl) this.room.scheduleTTL(op.key, op.ttl);
          const rev = this.room.bumpRev(op.key);
          results.push({ op: "set_if", key: op.key, success: true, current, rev });
          changes.push({ type: "set", key: op.key, value: op.value, rev });
          break;
        }
      }
    }

    for (const c of changes) {
      await this.room.notifyChange(c.type, c.key, c.value, c.rev, this._connectionId);
    }

    return { success: true, results };
  }

  async registerSchemas(
    schemas: Record<string, JsonSchema>,
    opts?: { replace?: boolean; version?: number }
  ): Promise<{ count: number; schemaVersion: number }> {
    this.assertOpen();
    if (opts?.version !== undefined && opts.version <= this.room.schemaVersion) {
      throw new RoomError(
        `Schema version ${opts.version} <= current ${this.room.schemaVersion}`,
        {
          kind: "schemaConflict",
          schemaConflict: {
            incomingVersion: opts.version,
            currentVersion: this.room.schemaVersion,
          },
        }
      );
    }
    if (opts?.replace) this.room.schemas = { ...schemas };
    else                this.room.schemas = { ...this.room.schemas, ...schemas };
    if (opts?.version !== undefined) this.room.schemaVersion = opts.version;
    return {
      count: Object.keys(this.room.schemas).length,
      schemaVersion: this.room.schemaVersion,
    };
  }

  // ── Scheduled alarms ────────────────────────────────────────────────────────

  async scheduleAlarm(delay: number, action?: AlarmAction): Promise<void> {
    this.assertOpen();
    if (delay < 0) throw new RoomError("delay must be >= 0", { kind: "invalid" });
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
    if (interval <= 0) throw new RoomError("interval must be > 0", { kind: "invalid" });
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

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribeKey<K extends string>(
    key: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    if (key.startsWith(META)) throw new RoomError("Reserved key prefix", { kind: "invalid" });
    return this.addSubscription("key", key, handler as ChangeHandler, opts);
  }

  subscribePrefix<K extends string>(
    prefix: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    if (prefix !== "" && !prefix.endsWith("/")) {
      throw new Error(
        `room-server: subscribePrefix("${prefix}") requires a trailing "/" or empty string. Use subscribeKey for exact matches.`
      );
    }
    if (prefix.startsWith(META)) throw new RoomError("Reserved key prefix", { kind: "invalid" });
    return this.addSubscription("prefix", prefix, handler as ChangeHandler, opts);
  }

  async subscribeWithSnapshotKey<K extends string>(
    key: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): Promise<{
    initial: { value: ResolveKey<S, K> | null; rev: number };
    unsubscribe: UnsubscribeFn;
  }> {
    const unsubscribe = this.subscribeKey(key, handler, opts);
    const value = (await this.room.store.get(key)) as ResolveKey<S, K> | null;
    return { initial: { value, rev: this.room.getRev(key) }, unsubscribe };
  }

  async subscribeWithSnapshotPrefix<K extends string>(
    prefix: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): Promise<SubscribeWithSnapshotPrefixResult> {
    const unsubscribe = this.subscribePrefix(prefix, handler, opts);
    const out: Record<string, unknown> = {};
    let cursor: string | undefined;
    let truncated = false;
    while (true) {
      const page = await listUserKeys(this.room, prefix, 128, cursor);
      Object.assign(out, page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (Object.keys(out).length >= LIST_HARD_CAP) {
        truncated = true;
        break;
      }
    }
    const initial: InitialPrefixSnapshot = truncated
      ? { entries: out, truncated: true }
      : { entries: out };
    return { initial, unsubscribe };
  }

  private addSubscription(
    kind: "key" | "prefix",
    target: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    const subKey = `${kind}:${target}`;
    let group = this.conn.subs.get(subKey);
    if (!group) {
      group = { kind, target, handlers: new Set() };
      this.conn.subs.set(subKey, group);
    }
    const entry: MockHandler = {
      handler,
      includeSelf: opts?.includeSelf === true,
      ...(opts?.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
    };
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
    const connId = this._connectionId;
    void (async () => {
      const priorValue = await this.room.store.get(presenceKey);
      await this.room.store.delete(presenceKey);
      const rev = this.room.bumpRev(presenceKey);
      await this.room.notifyChange("delete", presenceKey, priorValue, rev, connId);
    })();
    this.setStatus("closed");
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private assertOpen() {
    if (this.closed) throw new RoomError("Disconnected", { kind: "transient" });
  }

  private assertWritable(key: string) {
    if (key.startsWith(META) || key.startsWith("presence/")) {
      throw new RoomError("Reserved key prefix", { kind: "invalid" });
    }
  }

  private async maybeValidateLocal(key: string, value: unknown): Promise<void> {
    if (!this.clientSchemas) return;
    const schema = resolveClientSchema(key, this.clientSchemas);
    if (!schema) return;
    const result = await schema["~standard"].validate(value);
    if ("issues" in result) {
      throw new RoomError(`Validation failed for "${key}"`, {
        kind: "validation",
        validationError: {
          key,
          schemaPattern: "<client-side>",
          errors: result.issues.map((i) => ({ path: "", message: i.message })),
        },
      });
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
    for (const [k, v] of Object.entries(page.entries)) {
      if (!k.startsWith(META)) entries[k] = v;
    }
    nextCursor = page.nextCursor;
    const userCount = Object.keys(entries).length;
    if (!nextCursor || (limit !== undefined && userCount >= limit)) break;
    fetchCursor = nextCursor;
  }

  if (limit) {
    const keys = Object.keys(entries);
    if (keys.length > limit) {
      const trimmed: Record<string, unknown> = {};
      for (const k of keys.slice(0, limit)) trimmed[k] = entries[k];
      return { entries: trimmed, nextCursor: keys[limit - 1] };
    }
  }

  return nextCursor ? { entries, nextCursor } : { entries };
}

function resolveClientSchema(
  key: string,
  schemas: ClientSchemaMap
): import("./client.js").StandardSchemaLike | null {
  if (key in schemas) return schemas[key]!;
  let bestPrefix = "";
  for (const pattern of Object.keys(schemas)) {
    if (pattern.endsWith("/") && key.startsWith(pattern) && pattern.length > bestPrefix.length) {
      bestPrefix = pattern;
    }
  }
  if (bestPrefix !== "") return schemas[bestPrefix]!;
  if ("*" in schemas) return schemas["*"]!;
  return null;
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
