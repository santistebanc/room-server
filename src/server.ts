import type * as Party from "partykit/server";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createStore, type Store } from "./persistence.js";
import { resolveSchema, validate } from "./validator.js";
import type {
  AlarmAction,
  ChangeMsg,
  ClientMsg,
  Env,
  JsonSchema,
  PersistenceLevel,
  RateLimitInfo,
  ServerMsg,
  TransactOp,
  TransactOpResult,
  ValidationErrorDetail,
} from "./types.js";

// Internal storage key prefix — never exposed to clients via list().
const META = "__rs/";
const META_REV = `${META}rev/`;
const META_TTL = `${META}ttl/`;                     // key -> expiresAt
const META_TTL_BY_EXPIRY = `${META}ttlByExpiry/`;   // padded(expiresAt)-key -> key
const META_SCHEMAS = `${META}schemas`;
const META_PERSISTENCE = `${META}persistence`;
const META_APP_ID = `${META}appId`;
const META_ROOM_ID = `${META}roomId`;
const META_ALARM_FIRE_AT = `${META}alarm/fireAt`;
const META_ALARM_ACTION = `${META}alarm/action`;
const META_ALARM_RECURRING = `${META}alarm/recurring`;

// Soft cap for unbounded list/snapshot operations. Beyond this we set
// `truncated: true` and stop. Tunable in the future.
const LIST_HARD_CAP = 10_000;
const COUNT_HARD_CAP = 100_000;

// ── Per-connection state ──────────────────────────────────────────────────────

interface SubState {
  includeSelf: boolean;
  batchMs?: number;
}

interface ConnSubs {
  keys: Map<string, SubState>;
  prefixes: Map<string, SubState>;
}

interface BatchBucket {
  changes: ChangeMsg[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface ConnState {
  authenticated: boolean;
  appId?: string;
  userId?: string;
  authTimeout: ReturnType<typeof setTimeout> | null;
  subs: ConnSubs;
  batchBuckets: Map<number /*batchMs*/, BatchBucket>;
}

interface RateBucket {
  count: number;
  windowStart: number;
  warned: boolean;
}

interface RateCheckResult extends RateLimitInfo {
  allowed: boolean;
}

export default class RoomServer implements Party.Server {
  private store!: Store;
  private persistence!: PersistenceLevel;
  private appId!: string;
  private roomId!: string;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  // Schemas registered in this room. Keyed by pattern (prefix-with-/, exact key, or "*").
  private schemas: Record<string, JsonSchema> = {};

  private connections = new Map<string, ConnState>();

  private rateLimits = new Map<string, RateBucket>();
  private httpRateLimits = new Map<string, RateBucket>();
  private rateLimitOps = 100;
  private rateLimitWindowMs = 10_000;
  private maxConnections = 100;
  private connectionCount = 0;
  private authTimeoutMs = 10_000;

  constructor(private party: Party.Room) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onStart() {
    const env = this.party.env as Env;
    if (env.RATE_LIMIT_OPS) this.rateLimitOps = parseInt(env.RATE_LIMIT_OPS, 10);
    if (env.RATE_LIMIT_WINDOW) this.rateLimitWindowMs = parseInt(env.RATE_LIMIT_WINDOW, 10) * 1000;
    if (env.MAX_CONNECTIONS) this.maxConnections = parseInt(env.MAX_CONNECTIONS, 10);
    if (env.AUTH_TIMEOUT) this.authTimeoutMs = parseInt(env.AUTH_TIMEOUT, 10) * 1000;

    const dos = this.party.storage as unknown as DurableObjectStorage;
    const savedPersistence = await dos.get<PersistenceLevel>(META_PERSISTENCE);
    const savedAppId = await dos.get<string>(META_APP_ID);
    const savedRoomId = await dos.get<string>(META_ROOM_ID);

    if (savedPersistence && savedAppId && savedRoomId) {
      this.persistence = savedPersistence;
      this.appId = savedAppId;
      this.roomId = savedRoomId;
      this.store = createStore(savedPersistence, dos);
      await this.store.hydrate();
      this.ready = true;

      const savedSchemas = await dos.get<Record<string, JsonSchema>>(META_SCHEMAS);
      if (savedSchemas) this.schemas = savedSchemas;

      const liveConnections = [...this.party.getConnections()];
      this.connectionCount = liveConnections.length;
      for (const conn of liveConnections) {
        // Pre-hibernation connections were already authenticated. Re-create state.
        this.connections.set(conn.id, this.createAuthedConnState());
      }
      const liveIds = new Set(liveConnections.map((c) => c.id));

      // Prune presence keys belonging to connections that didn't survive.
      let presenceCursor: string | undefined;
      do {
        const page = await this.store.list("presence/", 100, presenceCursor);
        for (const key of Object.keys(page.entries)) {
          const connId = key.slice("presence/".length);
          if (!liveIds.has(connId)) await this.store.delete(key);
        }
        presenceCursor = page.nextCursor;
      } while (presenceCursor);
    }
  }

  async onConnect(conn: Party.Connection) {
    if (this.connectionCount >= this.maxConnections) {
      send(conn, { op: "error", message: "Room connection limit reached" });
      conn.close(4002, "Connection limit reached");
      return;
    }

    this.connectionCount++;

    const state: ConnState = {
      authenticated: false,
      authTimeout: setTimeout(() => {
        const c = this.party.getConnection(conn.id);
        if (c) {
          send(c, { op: "error", message: "Auth timeout" });
          c.close(4003, "Auth timeout");
        }
      }, this.authTimeoutMs),
      subs: { keys: new Map(), prefixes: new Map() },
      batchBuckets: new Map(),
    };
    this.connections.set(conn.id, state);
  }

  async onMessage(message: string | ArrayBuffer, conn: Party.Connection) {
    const state = this.connections.get(conn.id);
    if (!state) return;

    const rate = this.checkRateLimit(conn.id);
    if (!rate.allowed) {
      send(conn, { op: "error", message: "Rate limit exceeded", rateLimit: toRateLimitInfo(rate) });
      return;
    }
    this.maybeWarnRateLimit(conn, conn.id, rate);

    let msg: ClientMsg;
    try {
      msg = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message)
      ) as ClientMsg;
    } catch {
      send(conn, { op: "error", message: "Invalid JSON" });
      return;
    }

    try {
      if (!state.authenticated) {
        if (msg.op !== "auth") {
          send(conn, {
            op: "error",
            requestId: (msg as { requestId?: string }).requestId,
            message: "Auth required — send {op:'auth',apiKey,userId?,persistence?} as the first message",
          });
          return;
        }
        await this.handleAuth(msg, conn, state);
        return;
      }

      await this.handle(msg, conn, state);
    } catch (err) {
      send(conn, {
        op: "error",
        requestId: (msg as { requestId?: string }).requestId,
        message: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  async onClose(conn: Party.Connection) {
    const state = this.connections.get(conn.id);
    this.connections.delete(conn.id);
    this.rateLimits.delete(conn.id);

    if (state) {
      if (state.authTimeout) clearTimeout(state.authTimeout);
      for (const bucket of state.batchBuckets.values()) {
        if (bucket.timer) clearTimeout(bucket.timer);
      }
      this.connectionCount = Math.max(0, this.connectionCount - 1);

      if (this.ready && state.authenticated) {
        const presenceKey = `presence/${conn.id}`;
        await this.store.delete(presenceKey);
        await this.bumpRev(presenceKey);
        await this.notify({ op: "change", type: "delete", key: presenceKey, rev: await this.getRev(presenceKey), originConnId: conn.id });
      }
    }
  }

  async onAlarm() {
    if (!this.ready) return;
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const now = Date.now();

    // 1. Sweep expired TTLs via the sorted-by-expiry index. Stops at first non-expired.
    let ttlCursor: string | undefined;
    let swept = 0;
    sweepLoop: while (true) {
      const page = await dos.list<string>({
        prefix: META_TTL_BY_EXPIRY,
        startAfter: ttlCursor,
        limit: 128,
      });
      let processed = 0;
      for (const [indexKey, userKey] of page) {
        processed++;
        ttlCursor = indexKey;
        const expiresAt = parseExpiryFromIndexKey(indexKey);
        if (expiresAt > now) break sweepLoop;
        await this.store.delete(userKey);
        await dos.delete(indexKey);
        await dos.delete(`${META_TTL}${userKey}`);
        await this.bumpRev(userKey);
        const rev = await this.getRev(userKey);
        await this.notify({ op: "change", type: "delete", key: userKey, rev, originConnId: null });
        swept++;
      }
      if (processed < 128) break;
    }

    // 2. One-shot alarm.
    const fireAt = await dos.get<number>(META_ALARM_FIRE_AT);
    const alarmAction = await dos.get<AlarmAction>(META_ALARM_ACTION);
    if (fireAt && fireAt <= now) {
      if (alarmAction) {
        try { await this.executeAction(alarmAction); } catch {}
      }
      await dos.delete(META_ALARM_FIRE_AT);
      await dos.delete(META_ALARM_ACTION);
    }

    // 3. Recurring.
    const recurring = await dos.get<{ interval: number; action: AlarmAction; nextAt: number }>(
      META_ALARM_RECURRING
    );
    if (recurring && (recurring.nextAt ?? 0) <= now) {
      try { await this.executeAction(recurring.action); } catch {}
      await dos.put(META_ALARM_RECURRING, {
        ...recurring,
        nextAt: now + recurring.interval * 1000,
      });
    }

    await this.rescheduleNextAlarm(dos);
    void swept; // silence unused-var if we ever drop the count
  }

  // ── HTTP REST API ───────────────────────────────────────────────────────────

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(req.url);
    const apiKey =
      req.headers.get("Authorization")?.replace(/^Bearer\s+/, "") ??
      url.searchParams.get("apiKey") ??
      "";

    const authResult = this.authenticate(apiKey, this.party.env as Env);
    if (!authResult.ok) {
      return cors(new Response("Unauthorized", { status: 401 }));
    }

    const rate = this.checkHttpRateLimit(authResult.appId);
    if (!rate.allowed) {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("X-RateLimit-Limit", String(rate.limit));
      headers.set("X-RateLimit-Remaining", String(rate.remaining));
      headers.set("X-RateLimit-Reset", String(rate.resetAt));
      headers.set("Retry-After", String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
      return cors(
        new Response(
          JSON.stringify({ error: "Rate limit exceeded", rateLimit: toRateLimitInfo(rate) }),
          { status: 429, headers }
        )
      );
    }

    if (!this.ready) {
      await this.ensureInit(authResult.appId, "durable");
    }

    try {
      if (req.method === "GET") {
        const key = url.searchParams.get("key");
        const prefix = url.searchParams.get("prefix");
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor") ?? undefined;

        if (key !== null) {
          if (key.startsWith(META)) return cors(Response.json({ key, value: null, rev: 0 }));
          const value = await this.getWithTTLCheck(key, null);
          const rev = await this.getRev(key);
          return cors(Response.json({ key, value, rev }));
        }

        if (prefix !== null) {
          const result = await this.listUserKeys(
            prefix,
            limit ? parseInt(limit, 10) : undefined,
            cursor
          );
          return cors(Response.json(result));
        }

        return cors(new Response("Missing key or prefix", { status: 400 }));
      }

      if (req.method === "POST") {
        const body = (await req.json()) as { key: unknown; value: unknown; ttl?: number };
        if (typeof body.key !== "string" || !body.key) {
          return cors(new Response("Missing or invalid key", { status: 400 }));
        }
        if (!("value" in (body as object))) {
          return cors(new Response("Missing value", { status: 400 }));
        }
        if (body.key.startsWith(META) || body.key.startsWith("presence/")) {
          return cors(new Response("Reserved key prefix", { status: 400 }));
        }
        const errs = this.validateWrite(body.key, body.value);
        if (errs) {
          return cors(Response.json({ error: "Validation failed", validationError: errs }, { status: 400 }));
        }
        await this.store.set(body.key, body.value);
        await this.clearTTL(body.key, true);
        if (body.ttl) await this.scheduleTTL(body.key, body.ttl);
        await this.rescheduleNextAlarm(this.party.storage as unknown as DurableObjectStorage);
        await this.bumpRev(body.key);
        const rev = await this.getRev(body.key);
        await this.notify({ op: "change", type: "set", key: body.key, value: body.value, rev, originConnId: null });
        return cors(Response.json({ ok: true, rev }));
      }

      if (req.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) return cors(new Response("Missing key", { status: 400 }));
        if (key.startsWith(META) || key.startsWith("presence/")) {
          return cors(new Response("Reserved key prefix", { status: 400 }));
        }
        await this.store.delete(key);
        await this.clearTTL(key);
        await this.bumpRev(key);
        const rev = await this.getRev(key);
        await this.notify({ op: "change", type: "delete", key, rev, originConnId: null });
        return cors(Response.json({ ok: true, rev }));
      }
    } catch (err) {
      return cors(
        Response.json(
          { error: err instanceof Error ? err.message : "Internal error" },
          { status: 500 }
        )
      );
    }

    return cors(new Response("Method not allowed", { status: 405 }));
  }

  // ── Auth handler ────────────────────────────────────────────────────────────

  private async handleAuth(
    msg: Extract<ClientMsg, { op: "auth" }>,
    conn: Party.Connection,
    state: ConnState
  ) {
    const env = this.party.env as Env;
    const authResult = this.authenticate(msg.apiKey, env);
    if (!authResult.ok) {
      send(conn, { op: "error", requestId: msg.requestId, message: authResult.reason });
      conn.close(4001, "Unauthorized");
      return;
    }

    if (state.authTimeout) {
      clearTimeout(state.authTimeout);
      state.authTimeout = null;
    }
    state.authenticated = true;
    state.appId = authResult.appId;
    state.userId = msg.userId;

    await this.ensureInit(authResult.appId, msg.persistence ?? "durable");

    const presenceKey = `presence/${conn.id}`;
    const presenceValue: Record<string, unknown> = { connectedAt: Date.now() };
    if (msg.userId) presenceValue["userId"] = msg.userId;
    await this.store.set(presenceKey, presenceValue);
    await this.bumpRev(presenceKey);
    const presenceRev = await this.getRev(presenceKey);
    await this.notify({
      op: "change",
      type: "set",
      key: presenceKey,
      value: presenceValue,
      rev: presenceRev,
      originConnId: conn.id,
    });

    send(conn, {
      op: "ready",
      persistence: this.persistence,
      appId: this.appId,
      roomId: this.roomId,
      connectionId: conn.id,
    });
  }

  // ── Authenticated message dispatch ──────────────────────────────────────────

  private async handle(msg: ClientMsg, conn: Party.Connection, state: ConnState) {
    switch (msg.op) {
      case "auth":
        send(conn, { op: "error", requestId: msg.requestId, message: "Already authenticated" });
        break;

      case "set": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        const errs = this.validateWrite(msg.key, msg.value);
        if (errs) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Validation failed", validationError: errs });
          break;
        }
        await this.store.set(msg.key, msg.value);
        await this.clearTTL(msg.key, true);
        if (msg.ttl) await this.scheduleTTL(msg.key, msg.ttl);
        await this.rescheduleNextAlarm(this.party.storage as unknown as DurableObjectStorage);
        await this.bumpRev(msg.key);
        const rev = await this.getRev(msg.key);
        send(conn, { op: "ack", requestId: msg.requestId });
        await this.notify({ op: "change", type: "set", key: msg.key, value: msg.value, rev, originConnId: conn.id });
        break;
      }

      case "get": {
        if (msg.key.startsWith(META)) {
          send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: null, rev: 0 });
          break;
        }
        const value = await this.getWithTTLCheck(msg.key, conn.id);
        const rev = await this.getRev(msg.key);
        send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value, rev });
        break;
      }

      case "delete": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        await this.store.delete(msg.key);
        await this.clearTTL(msg.key);
        await this.bumpRev(msg.key);
        const rev = await this.getRev(msg.key);
        send(conn, { op: "ack", requestId: msg.requestId });
        await this.notify({ op: "change", type: "delete", key: msg.key, rev, originConnId: conn.id });
        break;
      }

      case "list": {
        const result = await this.listUserKeys(msg.prefix, msg.limit, msg.cursor);
        send(conn, {
          op: "list_result",
          requestId: msg.requestId,
          prefix: msg.prefix,
          entries: result.entries,
          nextCursor: result.nextCursor,
          truncated: result.truncated,
        });
        break;
      }

      case "count": {
        const result = await this.countUserKeys(msg.prefix);
        send(conn, {
          op: "count_result",
          requestId: msg.requestId,
          prefix: msg.prefix,
          count: result.count,
          truncated: result.truncated,
        });
        break;
      }

      case "increment": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        const current = await this.getWithTTLCheck(msg.key, conn.id);
        const num = typeof current === "number" ? current : 0;
        const next = num + (msg.delta ?? 1);
        const errs = this.validateWrite(msg.key, next);
        if (errs) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Validation failed", validationError: errs });
          break;
        }
        await this.store.set(msg.key, next);
        await this.bumpRev(msg.key);
        const rev = await this.getRev(msg.key);
        send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: next, rev });
        await this.notify({ op: "change", type: "set", key: msg.key, value: next, rev, originConnId: conn.id });
        break;
      }

      case "set_if": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        if (msg.ifValue !== undefined && msg.ifRev !== undefined) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Pass either ifValue or ifRev, not both" });
          break;
        }
        const current = await this.getWithTTLCheck(msg.key, conn.id);
        const currentRev = await this.getRev(msg.key);
        let match: boolean;
        if (msg.ifRev !== undefined) match = currentRev === msg.ifRev;
        else                         match = deepEqual(current, msg.ifValue);

        if (match) {
          const errs = this.validateWrite(msg.key, msg.value);
          if (errs) {
            send(conn, { op: "error", requestId: msg.requestId, message: "Validation failed", validationError: errs });
            break;
          }
          await this.store.set(msg.key, msg.value);
          await this.bumpRev(msg.key);
          const newRev = await this.getRev(msg.key);
          send(conn, { op: "set_if_result", requestId: msg.requestId, success: true, current, rev: newRev });
          await this.notify({ op: "change", type: "set", key: msg.key, value: msg.value, rev: newRev, originConnId: conn.id });
        } else {
          send(conn, { op: "set_if_result", requestId: msg.requestId, success: false, current, rev: currentRev });
        }
        break;
      }

      case "touch": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        if (typeof msg.ttl !== "number" || msg.ttl <= 0) {
          send(conn, { op: "error", requestId: msg.requestId, message: "ttl must be > 0" });
          break;
        }
        const current = await this.store.get(msg.key);
        if (current === null || current === undefined) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Cannot touch key (does not exist or is null)" });
          break;
        }
        await this.scheduleTTL(msg.key, msg.ttl);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "delete_prefix": {
        if (msg.prefix === "" || msg.prefix.startsWith(META) || msg.prefix.startsWith("presence/")) {
          send(conn, {
            op: "error",
            requestId: msg.requestId,
            message: msg.prefix === ""
              ? "delete_prefix requires a non-empty prefix"
              : "Reserved key prefix",
          });
          break;
        }
        const deleted = await this.deletePrefix(msg.prefix, conn.id);
        send(conn, { op: "delete_prefix_result", requestId: msg.requestId, deleted });
        break;
      }

      case "snapshot": {
        const result = await this.handleSnapshot(msg.keys, msg.prefixes, conn.id);
        if ("error" in result) {
          send(conn, { op: "error", requestId: msg.requestId, message: result.error });
          break;
        }
        send(conn, {
          op: "snapshot_result",
          requestId: msg.requestId,
          keys: result.keys,
          prefixes: result.prefixes,
          truncated: result.truncated,
        });
        break;
      }

      case "transact": {
        await this.handleTransact(msg, conn);
        break;
      }

      case "subscribe_key": {
        if (msg.key.startsWith(META)) {
          send(conn, { op: "error", message: "Reserved key prefix" });
          break;
        }
        state.subs.keys.set(msg.key, { includeSelf: msg.includeSelf === true, batchMs: msg.batchMs });
        break;
      }

      case "subscribe_prefix": {
        if (msg.prefix !== "" && !msg.prefix.endsWith("/")) {
          send(conn, { op: "error", message: "Prefix must end with '/' or be empty string" });
          break;
        }
        if (msg.prefix.startsWith(META)) {
          send(conn, { op: "error", message: "Reserved key prefix" });
          break;
        }
        state.subs.prefixes.set(msg.prefix, { includeSelf: msg.includeSelf === true, batchMs: msg.batchMs });
        break;
      }

      case "subscribe_with_snapshot_key": {
        if (msg.key.startsWith(META)) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        state.subs.keys.set(msg.key, { includeSelf: msg.includeSelf === true, batchMs: msg.batchMs });
        const value = await this.getWithTTLCheck(msg.key, conn.id);
        const rev = await this.getRev(msg.key);
        send(conn, {
          op: "snapshot_initial",
          requestId: msg.requestId,
          kind: "key",
          target: msg.key,
          value,
          rev,
        });
        break;
      }

      case "subscribe_with_snapshot_prefix": {
        if (msg.prefix !== "" && !msg.prefix.endsWith("/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Prefix must end with '/' or be empty string" });
          break;
        }
        if (msg.prefix.startsWith(META)) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        state.subs.prefixes.set(msg.prefix, { includeSelf: msg.includeSelf === true, batchMs: msg.batchMs });
        const entries = await this.collectAllUserKeys(msg.prefix);
        send(conn, {
          op: "snapshot_initial",
          requestId: msg.requestId,
          kind: "prefix",
          target: msg.prefix,
          entries: entries.entries,
          truncated: entries.truncated,
        });
        break;
      }

      case "unsubscribe_key": {
        state.subs.keys.delete(msg.key);
        break;
      }

      case "unsubscribe_prefix": {
        state.subs.prefixes.delete(msg.prefix);
        break;
      }

      case "broadcast": {
        const broadcastMsg: ServerMsg = { op: "broadcast_recv", channel: msg.channel, data: msg.data };
        this.party.broadcast(JSON.stringify(broadcastMsg), [conn.id]);
        break;
      }

      case "register_schemas": {
        if (msg.replace) this.schemas = { ...msg.schemas };
        else             this.schemas = { ...this.schemas, ...msg.schemas };
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.put(META_SCHEMAS, this.schemas);
        send(conn, {
          op: "schemas_registered",
          requestId: msg.requestId,
          count: Object.keys(this.schemas).length,
        });
        break;
      }

      case "schedule_alarm": {
        if (msg.delay < 0) {
          send(conn, { op: "error", requestId: msg.requestId, message: "delay must be >= 0" });
          break;
        }
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.put(META_ALARM_FIRE_AT, Date.now() + msg.delay * 1000);
        await dos.put(META_ALARM_ACTION, msg.action ?? null);
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "cancel_alarm": {
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.delete(META_ALARM_FIRE_AT);
        await dos.delete(META_ALARM_ACTION);
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "schedule_recurring": {
        if (msg.interval <= 0) {
          send(conn, { op: "error", requestId: msg.requestId, message: "interval must be > 0" });
          break;
        }
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.put(META_ALARM_RECURRING, {
          interval: msg.interval,
          action: msg.action,
          nextAt: Date.now() + msg.interval * 1000,
        });
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "cancel_recurring": {
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.delete(META_ALARM_RECURRING);
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        send(conn, { op: "error", message: "Unknown op" });
      }
    }
  }

  // ── Transact ────────────────────────────────────────────────────────────────

  private async handleTransact(
    msg: Extract<ClientMsg, { op: "transact" }>,
    conn: Party.Connection
  ) {
    // Phase 1: validate ops + check preconditions before any write.
    for (let i = 0; i < msg.ops.length; i++) {
      const op = msg.ops[i]!;
      if (op.key.startsWith(META) || op.key.startsWith("presence/")) {
        send(conn, {
          op: "transact_result",
          requestId: msg.requestId,
          success: false,
          results: [],
          error: `op ${i}: reserved key prefix`,
        });
        return;
      }
    }

    // Phase 2: simulate each set_if precondition. Treat same-key writes within the
    // batch as ordered: a later set_if's precondition reads the value written by
    // an earlier op in the same transact.
    const projected = new Map<string, { value: unknown; rev: number; deleted: boolean }>();
    const readCurrent = async (key: string): Promise<{ value: unknown; rev: number }> => {
      if (projected.has(key)) {
        const p = projected.get(key)!;
        return { value: p.deleted ? null : p.value, rev: p.rev };
      }
      const value = await this.getWithTTLCheck(key, null);
      const rev = await this.getRev(key);
      return { value, rev };
    };

    for (let i = 0; i < msg.ops.length; i++) {
      const op = msg.ops[i]!;
      if (op.op === "set_if") {
        const cur = await readCurrent(op.key);
        const ok = op.ifRev !== undefined
          ? cur.rev === op.ifRev
          : deepEqual(cur.value, op.ifValue);
        if (!ok) {
          send(conn, {
            op: "transact_result",
            requestId: msg.requestId,
            success: false,
            results: [],
            error: `op ${i}: set_if precondition failed for "${op.key}"`,
          });
          return;
        }
      }
      // Project this op's effect for subsequent precondition checks.
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

    // Phase 3: validate all projected values against schemas before any write.
    for (const [key, p] of projected) {
      if (p.deleted) continue;
      const errs = this.validateWrite(key, p.value);
      if (errs) {
        send(conn, {
          op: "error",
          requestId: msg.requestId,
          message: `Validation failed for "${key}"`,
          validationError: errs,
        });
        return;
      }
    }

    // Phase 4: apply, in order. Each op produces one TransactOpResult and one notify.
    const results: TransactOpResult[] = [];
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const changes: ChangeMsg[] = [];

    for (let i = 0; i < msg.ops.length; i++) {
      const op = msg.ops[i]!;
      switch (op.op) {
        case "set": {
          await this.store.set(op.key, op.value);
          await this.clearTTL(op.key, true);
          if (op.ttl) await this.scheduleTTL(op.key, op.ttl);
          await this.bumpRev(op.key);
          const rev = await this.getRev(op.key);
          results.push({ op: "set", key: op.key, rev });
          changes.push({ op: "change", type: "set", key: op.key, value: op.value, rev, originConnId: conn.id });
          break;
        }
        case "delete": {
          await this.store.delete(op.key);
          await this.clearTTL(op.key, true);
          await this.bumpRev(op.key);
          const rev = await this.getRev(op.key);
          results.push({ op: "delete", key: op.key, rev });
          changes.push({ op: "change", type: "delete", key: op.key, rev, originConnId: conn.id });
          break;
        }
        case "increment": {
          const current = await this.getWithTTLCheck(op.key, null);
          const num = typeof current === "number" ? current : 0;
          const next = num + (op.delta ?? 1);
          await this.store.set(op.key, next);
          await this.bumpRev(op.key);
          const rev = await this.getRev(op.key);
          results.push({ op: "increment", key: op.key, rev, value: next });
          changes.push({ op: "change", type: "set", key: op.key, value: next, rev, originConnId: conn.id });
          break;
        }
        case "set_if": {
          const current = await this.getWithTTLCheck(op.key, null);
          await this.store.set(op.key, op.value);
          await this.bumpRev(op.key);
          const rev = await this.getRev(op.key);
          results.push({ op: "set_if", key: op.key, success: true, current, rev });
          changes.push({ op: "change", type: "set", key: op.key, value: op.value, rev, originConnId: conn.id });
          break;
        }
      }
    }

    await this.rescheduleNextAlarm(dos);

    send(conn, {
      op: "transact_result",
      requestId: msg.requestId,
      success: true,
      results,
    });
    for (const change of changes) await this.notify(change);
  }

  // ── Snapshot helper ─────────────────────────────────────────────────────────

  private async handleSnapshot(
    keys: string[] | undefined,
    prefixes: string[] | undefined,
    sourceConnId: string
  ): Promise<
    | { keys: Record<string, unknown>; prefixes: Record<string, Record<string, unknown>>; truncated?: boolean }
    | { error: string }
  > {
    const keysOut: Record<string, unknown> = {};
    const prefixesOut: Record<string, Record<string, unknown>> = {};
    let truncated = false;

    if (keys) {
      for (const k of keys) {
        if (k.startsWith(META)) continue;
        keysOut[k] = await this.getWithTTLCheck(k, sourceConnId);
      }
    }

    if (prefixes) {
      for (const p of prefixes) {
        if (p !== "" && !p.endsWith("/")) {
          return { error: "Prefix must end with '/' or be empty string" };
        }
        const result = await this.collectAllUserKeys(p);
        prefixesOut[p] = result.entries;
        if (result.truncated) truncated = true;
      }
    }

    if (truncated) return { keys: keysOut, prefixes: prefixesOut, truncated };
    return { keys: keysOut, prefixes: prefixesOut };
  }

  // ── Alarm action executor ───────────────────────────────────────────────────

  private async executeAction(action: AlarmAction) {
    switch (action.op) {
      case "set": {
        await this.store.set(action.key, action.value);
        await this.bumpRev(action.key);
        const rev = await this.getRev(action.key);
        await this.notify({ op: "change", type: "set", key: action.key, value: action.value, rev, originConnId: null });
        break;
      }
      case "delete": {
        await this.store.delete(action.key);
        await this.bumpRev(action.key);
        const rev = await this.getRev(action.key);
        await this.notify({ op: "change", type: "delete", key: action.key, rev, originConnId: null });
        break;
      }
      case "increment": {
        const current = await this.store.get(action.key);
        const next = (typeof current === "number" ? current : 0) + (action.delta ?? 1);
        await this.store.set(action.key, next);
        await this.bumpRev(action.key);
        const rev = await this.getRev(action.key);
        await this.notify({ op: "change", type: "set", key: action.key, value: next, rev, originConnId: null });
        break;
      }
      case "broadcast":
        this.party.broadcast(
          JSON.stringify({ op: "broadcast_recv", channel: action.channel, data: action.data })
        );
        break;
    }
  }

  // ── List helpers ────────────────────────────────────────────────────────────

  // User-visible list. Skips internal `__rs/` entries and entries whose TTL has
  // already expired (lazy filter — the alarm sweep eventually deletes them).
  // Returns `truncated: true` when our paging budget is exhausted.
  private async listUserKeys(
    prefix: string,
    limit?: number,
    cursor?: string
  ): Promise<{ entries: Record<string, unknown>; nextCursor?: string; truncated?: boolean }> {
    const entries: Record<string, unknown> = {};
    let nextCursor: string | undefined;
    let fetchCursor = cursor;
    let truncated = false;

    const META_SKIP = META.slice(0, -1) + String.fromCharCode(META.charCodeAt(META.length - 1) + 1);
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const now = Date.now();

    for (let i = 0; i < 20; i++) {
      const page = await this.store.list(prefix, limit, fetchCursor);
      let pageHadUserKeys = false;
      for (const [k, v] of Object.entries(page.entries)) {
        if (k.startsWith(META)) continue;
        // Filter expired keys.
        const expiresAt = await dos.get<number>(`${META_TTL}${k}`);
        if (expiresAt !== undefined && expiresAt <= now) continue;
        entries[k] = v;
        pageHadUserKeys = true;
      }
      nextCursor = page.nextCursor;
      const userCount = Object.keys(entries).length;
      if (!nextCursor || (limit !== undefined && userCount >= limit)) break;
      fetchCursor = (!pageHadUserKeys && nextCursor.startsWith(META))
        ? META_SKIP
        : nextCursor;
      if (i === 19 && nextCursor) truncated = true;
    }

    if (limit) {
      const keys = Object.keys(entries);
      if (keys.length > limit) {
        const trimmed: Record<string, unknown> = {};
        for (const k of keys.slice(0, limit)) trimmed[k] = entries[k];
        return { entries: trimmed, nextCursor: keys[limit - 1] };
      }
    }

    return truncated ? { entries, nextCursor, truncated } : { entries, nextCursor };
  }

  private async collectAllUserKeys(
    prefix: string
  ): Promise<{ entries: Record<string, unknown>; truncated?: boolean }> {
    const out: Record<string, unknown> = {};
    let cursor: string | undefined;
    let truncated = false;

    while (true) {
      const page = await this.listUserKeys(prefix, 128, cursor);
      Object.assign(out, page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (Object.keys(out).length >= LIST_HARD_CAP) {
        truncated = true;
        break;
      }
    }
    return truncated ? { entries: out, truncated } : { entries: out };
  }

  private async countUserKeys(prefix: string): Promise<{ count: number; truncated?: boolean }> {
    let count = 0;
    let cursor: string | undefined;
    const META_SKIP = META.slice(0, -1) + String.fromCharCode(META.charCodeAt(META.length - 1) + 1);
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const now = Date.now();

    while (true) {
      const page = await this.store.list(prefix, 128, cursor);
      let pageHadUserKeys = false;
      for (const k of Object.keys(page.entries)) {
        if (k.startsWith(META)) continue;
        const expiresAt = await dos.get<number>(`${META_TTL}${k}`);
        if (expiresAt !== undefined && expiresAt <= now) continue;
        count++;
        pageHadUserKeys = true;
      }
      if (!page.nextCursor) break;
      cursor = (!pageHadUserKeys && page.nextCursor.startsWith(META)) ? META_SKIP : page.nextCursor;
      if (count >= COUNT_HARD_CAP) return { count, truncated: true };
    }
    return { count };
  }

  private async deletePrefix(prefix: string, sourceConnId: string): Promise<number> {
    const META_SKIP = META.slice(0, -1) + String.fromCharCode(META.charCodeAt(META.length - 1) + 1);
    let count = 0;
    let cursor: string | undefined;
    const dos = this.party.storage as unknown as DurableObjectStorage;

    while (true) {
      const page = await this.store.list(prefix, 128, cursor);
      let pageHadUserKeys = false;
      const keys = Object.keys(page.entries);

      for (const k of keys) {
        if (k.startsWith(META)) continue;
        pageHadUserKeys = true;
        await this.store.delete(k);
        // Per-key TTL cleanup, reschedule once at the end.
        const expiresAt = await dos.get<number>(`${META_TTL}${k}`);
        if (expiresAt !== undefined) {
          await dos.delete(`${META_TTL}${k}`);
          await dos.delete(buildTTLIndexKey(expiresAt, k));
        }
        await this.bumpRev(k);
        const rev = await this.getRev(k);
        await this.notify({ op: "change", type: "delete", key: k, rev, originConnId: sourceConnId });
        count++;
      }

      if (!page.nextCursor) break;
      cursor = (!pageHadUserKeys && page.nextCursor.startsWith(META)) ? META_SKIP : page.nextCursor;
    }

    if (count > 0) await this.rescheduleNextAlarm(dos);
    return count;
  }

  // ── TTL helpers ─────────────────────────────────────────────────────────────

  private async scheduleTTL(key: string, ttl: number) {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const expiresAt = Date.now() + ttl * 1000;
    // Clear any existing index entry first.
    const existing = await dos.get<number>(`${META_TTL}${key}`);
    if (existing !== undefined) {
      await dos.delete(buildTTLIndexKey(existing, key));
    }
    await dos.put(`${META_TTL}${key}`, expiresAt);
    await dos.put(buildTTLIndexKey(expiresAt, key), key);
    await this.rescheduleNextAlarm(dos);
  }

  private async clearTTL(key: string, skipReschedule = false) {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const expiresAt = await dos.get<number>(`${META_TTL}${key}`);
    if (expiresAt !== undefined) {
      await dos.delete(`${META_TTL}${key}`);
      await dos.delete(buildTTLIndexKey(expiresAt, key));
      if (!skipReschedule) await this.rescheduleNextAlarm(dos);
    }
  }

  private async rescheduleNextAlarm(dos: DurableObjectStorage) {
    const now = Date.now();
    let next: number | null = null;

    const pick = (t: number) => { next = next === null ? t : Math.min(next, t); };

    // Cheapest "next TTL" lookup: list 1 entry from the sorted index.
    const ttlPage = await dos.list<string>({ prefix: META_TTL_BY_EXPIRY, limit: 1 });
    for (const [indexKey] of ttlPage) {
      const expiresAt = parseExpiryFromIndexKey(indexKey);
      if (expiresAt > now) pick(expiresAt);
      else                 pick(now + 1); // overdue; fire immediately
    }

    const fireAt = await dos.get<number>(META_ALARM_FIRE_AT);
    if (fireAt) pick(Math.max(fireAt, now + 1));

    const rec = await dos.get<{ nextAt?: number }>(META_ALARM_RECURRING);
    if (rec) pick(Math.max(rec.nextAt ?? 0, now + 1));

    if (next !== null) await dos.setAlarm(next);
    else await dos.deleteAlarm();
  }

  private async getWithTTLCheck(key: string, sourceConnId: string | null): Promise<unknown> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const expiresAt = await dos.get<number>(`${META_TTL}${key}`);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.store.delete(key);
      await dos.delete(`${META_TTL}${key}`);
      await dos.delete(buildTTLIndexKey(expiresAt, key));
      await this.bumpRev(key);
      const rev = await this.getRev(key);
      await this.notify({ op: "change", type: "delete", key, rev, originConnId: sourceConnId });
      return null;
    }
    return this.store.get(key);
  }

  // ── Rev helpers ─────────────────────────────────────────────────────────────

  private async getRev(key: string): Promise<number> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    return (await dos.get<number>(`${META_REV}${key}`)) ?? 0;
  }

  private async bumpRev(key: string): Promise<number> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const current = (await dos.get<number>(`${META_REV}${key}`)) ?? 0;
    const next = current + 1;
    await dos.put(`${META_REV}${key}`, next);
    return next;
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  // Returns the validation error structure, or null if the value passes (or no
  // schema applies).
  private validateWrite(
    key: string,
    value: unknown
  ): { key: string; schemaPattern: string; errors: ValidationErrorDetail[] } | null {
    if (Object.keys(this.schemas).length === 0) return null;
    const match = resolveSchema(key, this.schemas);
    if (!match) return null;
    const errors = validate(value, match.schema);
    if (errors.length === 0) return null;
    return { key, schemaPattern: match.pattern, errors };
  }

  // ── Subscription fanout (with batching) ─────────────────────────────────────

  private async notify(change: ChangeMsg) {
    for (const [connId, state] of this.connections) {
      if (!state.authenticated) continue;
      const isSource = change.originConnId !== null && connId === change.originConnId;

      let matched = false;
      let includeSelf = false;
      let minBatchMs: number | "immediate" = "immediate";

      // Walk subs once to determine: matched? includeSelf? minBatchMs?
      const exact = state.subs.keys.get(change.key);
      if (exact) {
        matched = true;
        if (exact.includeSelf) includeSelf = true;
        if (exact.batchMs === undefined) minBatchMs = "immediate";
        else if (minBatchMs !== "immediate" && exact.batchMs < minBatchMs) minBatchMs = exact.batchMs;
        else if (minBatchMs !== "immediate" && minBatchMs === Infinity) minBatchMs = exact.batchMs;
      }

      for (const [prefix, sub] of state.subs.prefixes) {
        if (!change.key.startsWith(prefix)) continue;
        matched = true;
        if (sub.includeSelf) includeSelf = true;
        if (sub.batchMs === undefined) {
          minBatchMs = "immediate";
        } else if (minBatchMs !== "immediate") {
          if (typeof minBatchMs === "number") {
            if (sub.batchMs < minBatchMs) minBatchMs = sub.batchMs;
          } else {
            // minBatchMs === Infinity (no batched sub seen yet)
            minBatchMs = sub.batchMs;
          }
        }
      }

      if (!matched) continue;
      if (isSource && !includeSelf) continue;

      if (minBatchMs === "immediate") {
        const target = this.party.getConnection(connId);
        if (target) target.send(JSON.stringify(change));
      } else {
        // Batched delivery for this connection bucket.
        const batchMs = typeof minBatchMs === "number" ? minBatchMs : 0;
        let bucket = state.batchBuckets.get(batchMs);
        if (!bucket) {
          bucket = { changes: [], timer: null };
          state.batchBuckets.set(batchMs, bucket);
        }
        bucket.changes.push(change);
        if (!bucket.timer) {
          bucket.timer = setTimeout(() => {
            this.flushBatchBucket(connId, batchMs);
          }, batchMs);
        }
      }
    }
  }

  private flushBatchBucket(connId: string, batchMs: number) {
    const state = this.connections.get(connId);
    if (!state) return;
    const bucket = state.batchBuckets.get(batchMs);
    if (!bucket) return;
    bucket.timer = null;
    if (bucket.changes.length === 0) return;
    const payload = JSON.stringify({ op: "change_batch", changes: bucket.changes });
    bucket.changes = [];
    const target = this.party.getConnection(connId);
    if (target) target.send(payload);
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────

  private checkRateLimit(connId: string): RateCheckResult {
    return this.rateCheck(this.rateLimits, connId);
  }

  private checkHttpRateLimit(apiKey: string): RateCheckResult {
    return this.rateCheck(this.httpRateLimits, apiKey);
  }

  private rateCheck(map: Map<string, RateBucket>, key: string): RateCheckResult {
    const now = Date.now();
    const limit = this.rateLimitOps;
    const window = this.rateLimitWindowMs;
    const existing = map.get(key);

    if (!existing || now - existing.windowStart > window) {
      map.set(key, { count: 1, windowStart: now, warned: false });
      return { allowed: true, limit, window, remaining: limit - 1, resetAt: now + window };
    }

    existing.count++;
    return {
      allowed: existing.count <= limit,
      limit,
      window,
      remaining: Math.max(0, limit - existing.count),
      resetAt: existing.windowStart + window,
    };
  }

  private maybeWarnRateLimit(conn: Party.Connection, connId: string, rate: RateCheckResult) {
    const bucket = this.rateLimits.get(connId);
    if (!bucket || bucket.warned) return;
    if (rate.remaining / rate.limit > 0.2) return;
    bucket.warned = true;
    send(conn, { op: "rate_limit_warning", remaining: rate.remaining, resetAt: rate.resetAt });
  }

  // ── Auth (apiKey allowlist) ─────────────────────────────────────────────────

  private authenticate(apiKey: string, env: Env): { ok: true; appId: string } | { ok: false; reason: string } {
    if (!apiKey) return { ok: false, reason: "Missing apiKey" };
    const allowed = env.ALLOWED_KEYS;
    if (!allowed) return { ok: true, appId: apiKey };
    const keys = allowed.split(",").map((k) => k.trim());
    if (!keys.includes(apiKey)) return { ok: false, reason: "Invalid apiKey" };
    return { ok: true, appId: apiKey };
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  private ensureInit(appId: string, persistence: PersistenceLevel): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.initPromise) this.initPromise = this._doInit(appId, persistence);
    return this.initPromise;
  }

  private async _doInit(appId: string, persistence: PersistenceLevel): Promise<void> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    this.appId = appId;
    this.roomId = this.party.id.includes(":")
      ? this.party.id.slice(this.party.id.indexOf(":") + 1)
      : this.party.id;
    this.persistence = persistence;
    this.store = createStore(persistence, dos);
    await this.store.hydrate();
    await dos.put(META_PERSISTENCE, persistence);
    await dos.put(META_APP_ID, appId);
    await dos.put(META_ROOM_ID, this.roomId);
    this.ready = true;
  }

  private createAuthedConnState(): ConnState {
    return {
      authenticated: true,
      authTimeout: null,
      subs: { keys: new Map(), prefixes: new Map() },
      batchBuckets: new Map(),
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(conn: Party.Connection, msg: ServerMsg) {
  conn.send(JSON.stringify(msg));
}

function toRateLimitInfo(r: RateCheckResult): RateLimitInfo {
  return { limit: r.limit, window: r.window, remaining: r.remaining, resetAt: r.resetAt };
}

// Pad expiresAt to a fixed-width zero-padded decimal so DO's lexicographic
// list ordering matches numeric ordering. 16 digits covers up to year 5138.
function buildTTLIndexKey(expiresAt: number, userKey: string): string {
  return `${META_TTL_BY_EXPIRY}${String(expiresAt).padStart(16, "0")}-${userKey}`;
}

function parseExpiryFromIndexKey(indexKey: string): number {
  const stripped = indexKey.slice(META_TTL_BY_EXPIRY.length);
  const dash = stripped.indexOf("-");
  if (dash === -1) return 0;
  return parseInt(stripped.slice(0, dash), 10);
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

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers: h });
}

void ((): TransactOp[] => []); // keep TransactOp imported for tsc when only used in types
