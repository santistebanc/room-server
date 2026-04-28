import type * as Party from "partykit/server";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createStore, type Store } from "./persistence.js";
import type {
  AlarmAction,
  ClientMsg,
  Env,
  PersistenceLevel,
  ServerMsg,
} from "./types.js";

// Internal storage key prefix — never exposed to clients via list().
const META = "__rs/";

export default class RoomServer implements Party.Server {
  private store!: Store;
  private persistence!: PersistenceLevel;
  private appId!: string;
  private roomId!: string;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  // connectionId → set of subscribed prefixes
  private subscriptions = new Map<string, Set<string>>();

  // Rate limiting: connectionId → { count, windowStart }
  private rateLimits = new Map<string, { count: number; windowStart: number }>();
  // HTTP rate limiting: apiKey → { count, windowStart }
  private httpRateLimits = new Map<string, { count: number; windowStart: number }>();
  private rateLimitOps = 100;
  private rateLimitWindowMs = 10_000;
  private maxConnections = 100;
  private connectionCount = 0;

  constructor(private party: Party.Room) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onStart() {
    const env = this.party.env as Env;
    if (env.RATE_LIMIT_OPS) this.rateLimitOps = parseInt(env.RATE_LIMIT_OPS, 10);
    if (env.RATE_LIMIT_WINDOW) this.rateLimitWindowMs = parseInt(env.RATE_LIMIT_WINDOW, 10) * 1000;
    if (env.MAX_CONNECTIONS) this.maxConnections = parseInt(env.MAX_CONNECTIONS, 10);

    const dos = this.party.storage as unknown as DurableObjectStorage;
    const savedPersistence = await dos.get<PersistenceLevel>(`${META}persistence`);
    const savedAppId = await dos.get<string>(`${META}appId`);
    const savedRoomId = await dos.get<string>(`${META}roomId`);

    if (savedPersistence && savedAppId && savedRoomId) {
      this.persistence = savedPersistence;
      this.appId = savedAppId;
      this.roomId = savedRoomId;
      this.store = createStore(savedPersistence, dos);
      await this.store.hydrate();
      this.ready = true;

      // Restore connection count and prune presence keys left by a hard crash.
      // On hibernation wakeup, live connections are preserved and their presence
      // keys are valid. On crash, connections drop and old presence keys are orphaned.
      const liveConnections = [...this.party.getConnections()];
      this.connectionCount = liveConnections.length;
      // Populate subscriptions so re-subscribe messages and onClose work correctly
      // after hibernation wakeup (onConnect is not re-fired for existing connections).
      for (const conn of liveConnections) {
        this.subscriptions.set(conn.id, new Set());
      }
      const liveIds = new Set(liveConnections.map((c) => c.id));

      let presenceCursor: string | undefined;
      do {
        const presencePage = await this.store.list("presence/", 100, presenceCursor);
        for (const key of Object.keys(presencePage.entries)) {
          const connId = key.slice("presence/".length);
          if (!liveIds.has(connId)) await this.store.delete(key);
        }
        presenceCursor = presencePage.nextCursor;
      } while (presenceCursor);
    }
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const apiKey = url.searchParams.get("apiKey") ?? "";
    const persistence =
      (url.searchParams.get("persistence") as PersistenceLevel | null) ?? "storage";

    const authResult = this.authenticate(apiKey, this.party.env as Env);
    if (!authResult.ok) {
      send(conn, { op: "error", message: authResult.reason });
      conn.close(4001, "Unauthorized");
      return;
    }

    if (this.connectionCount >= this.maxConnections) {
      send(conn, { op: "error", message: "Room connection limit reached" });
      conn.close(4002, "Connection limit reached");
      return;
    }

    // Increment before the await so concurrent onConnect calls can't both
    // pass the limit check and overshoot maxConnections.
    this.connectionCount++;
    this.subscriptions.set(conn.id, new Set());

    await this.ensureInit(authResult.appId, persistence);

    // Record presence.
    const presenceKey = `presence/${conn.id}`;
    const presenceValue = { connectedAt: Date.now() };
    await this.store.set(presenceKey, presenceValue);
    this.notifySubscribers(presenceKey, presenceValue, conn.id);

    send(conn, {
      op: "ready",
      persistence: this.persistence,
      appId: this.appId,
      roomId: this.roomId,
    });
  }

  async onMessage(message: string | ArrayBuffer, conn: Party.Connection) {
    if (!this.ready) {
      send(conn, { op: "error", message: "Room not initialized" });
      return;
    }

    if (!this.checkRateLimit(conn.id)) {
      send(conn, { op: "error", message: "Rate limit exceeded" });
      return;
    }

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
      await this.handle(msg, conn);
    } catch (err) {
      send(conn, {
        op: "error",
        requestId: (msg as { requestId?: string }).requestId,
        message: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  async onClose(conn: Party.Connection) {
    // Only decrement if this connection was actually accepted (i.e. made it past auth/limit checks).
    const wasAccepted = this.subscriptions.has(conn.id);
    this.subscriptions.delete(conn.id);
    this.rateLimits.delete(conn.id);
    if (wasAccepted) this.connectionCount = Math.max(0, this.connectionCount - 1);

    if (this.ready) {
      const presenceKey = `presence/${conn.id}`;
      await this.store.delete(presenceKey);
      this.notifySubscribers(presenceKey, null, conn.id, true);
    }
  }

  async onAlarm() {
    if (!this.ready) return;
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const now = Date.now();

    // 1. Sweep expired TTL keys (paginate — DO storage returns max 128 per call).
    let ttlCursor: string | undefined;
    do {
      const ttlPage = await dos.list<number>({ prefix: `${META}ttl/`, startAfter: ttlCursor });
      for (const [ttlKey, expiresAt] of ttlPage) {
        if (expiresAt <= now) {
          const key = ttlKey.slice(`${META}ttl/`.length);
          await this.store.delete(key);
          await dos.delete(ttlKey);
          this.notifySubscribers(key, null, "", true);
        }
        ttlCursor = ttlKey;
      }
      if (ttlPage.size < 128) break;
    } while (true);

    // 2. Execute one-shot alarm if its scheduled time has arrived.
    const fireAt = await dos.get<number>(`${META}alarm/fireAt`);
    const alarmAction = await dos.get<AlarmAction>(`${META}alarm/action`);
    if (fireAt && fireAt <= now) {
      if (alarmAction) {
        try { await this.executeAction(alarmAction); } catch {}
      }
      await dos.delete(`${META}alarm/fireAt`);
      await dos.delete(`${META}alarm/action`);
    }

    // 3. Execute recurring action only when its own scheduled time has arrived.
    const recurring = await dos.get<{ interval: number; action: AlarmAction; nextAt: number }>(
      `${META}alarm/recurring`
    );
    if (recurring && (recurring.nextAt ?? 0) <= now) {
      try { await this.executeAction(recurring.action); } catch {}
      await dos.put(`${META}alarm/recurring`, {
        ...recurring,
        nextAt: now + recurring.interval * 1000,
      });
    }

    // Reschedule based on all remaining pending alarms.
    await this.rescheduleNextAlarm(dos);
  }

  // ── HTTP REST API ───────────────────────────────────────────────────────────
  // GET  /parties/room/{id}?key=path        → { key, value }
  // GET  /parties/room/{id}?prefix=p&limit=N&cursor=C → { entries, nextCursor }
  // POST /parties/room/{id}  body: { key, value, ttl? } → { ok }
  // DELETE /parties/room/{id}?key=path      → { ok }

  async onRequest(req: Party.Request): Promise<Response> {
    // Pre-flight must succeed before auth — browsers send OPTIONS without credentials.
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const apiKey =
      req.headers.get("Authorization")?.replace(/^Bearer\s+/, "") ??
      new URL(req.url).searchParams.get("apiKey") ??
      "";

    const authResult = this.authenticate(apiKey, this.party.env as Env);
    if (!authResult.ok) {
      return cors(new Response("Unauthorized", { status: 401 }));
    }

    if (!this.checkHttpRateLimit(authResult.appId)) {
      return cors(new Response("Rate limit exceeded", { status: 429 }));
    }

    if (!this.ready) {
      await this.ensureInit(authResult.appId, "storage");
    }

    const url = new URL(req.url);

    try {
      if (req.method === "GET") {
        const key = url.searchParams.get("key");
        const prefix = url.searchParams.get("prefix");
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor") ?? undefined;

        if (key !== null) {
          if (key.startsWith(META)) return cors(Response.json({ key, value: null }));
          const value = await this.getWithTTLCheck(key);
          return cors(Response.json({ key, value }));
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
        const body = (await req.json()) as {
          key: unknown;
          value: unknown;
          ttl?: number;
        };
        if (typeof body.key !== "string" || !body.key)
          return cors(new Response("Missing or invalid key", { status: 400 }));
        if (body.key.startsWith(META) || body.key.startsWith("presence/"))
          return cors(new Response("Reserved key prefix", { status: 400 }));
        await this.store.set(body.key, body.value);
        await this.clearTTL(body.key, !!body.ttl);
        if (body.ttl) await this.scheduleTTL(body.key, body.ttl);
        this.notifySubscribers(body.key, body.value, "");
        return cors(Response.json({ ok: true }));
      }

      if (req.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) return cors(new Response("Missing key", { status: 400 }));
        if (key.startsWith(META) || key.startsWith("presence/"))
          return cors(new Response("Reserved key prefix", { status: 400 }));
        await this.store.delete(key);
        await this.clearTTL(key);
        this.notifySubscribers(key, null, "", true);
        return cors(Response.json({ ok: true }));
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

  // ── Message handling ────────────────────────────────────────────────────────

  private async handle(msg: ClientMsg, conn: Party.Connection) {
    switch (msg.op) {
      case "set": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        await this.store.set(msg.key, msg.value);
        await this.clearTTL(msg.key, !!msg.ttl);
        if (msg.ttl) await this.scheduleTTL(msg.key, msg.ttl);
        send(conn, { op: "ack", requestId: msg.requestId });
        this.notifySubscribers(msg.key, msg.value, conn.id);
        break;
      }

      case "get": {
        if (msg.key.startsWith(META)) {
          send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: null });
          break;
        }
        const value = await this.getWithTTLCheck(msg.key);
        send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value });
        break;
      }

      case "delete": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        await this.store.delete(msg.key);
        await this.clearTTL(msg.key);
        send(conn, { op: "ack", requestId: msg.requestId });
        this.notifySubscribers(msg.key, null, conn.id, true);
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
        });
        break;
      }

      case "increment": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        const current = await this.getWithTTLCheck(msg.key);
        const num = typeof current === "number" ? current : 0;
        const next = num + (msg.delta ?? 1);
        await this.store.set(msg.key, next);
        send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: next });
        this.notifySubscribers(msg.key, next, conn.id);
        break;
      }

      case "set_if": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        const current = await this.getWithTTLCheck(msg.key);
        const match = deepEqual(current, msg.ifValue);
        if (match) {
          await this.store.set(msg.key, msg.value);
          this.notifySubscribers(msg.key, msg.value, conn.id);
        }
        send(conn, {
          op: "set_if_result",
          requestId: msg.requestId,
          success: match,
          current,
        });
        break;
      }

      case "subscribe": {
        this.subscriptions.get(conn.id)?.add(msg.prefix);
        break;
      }

      case "unsubscribe": {
        this.subscriptions.get(conn.id)?.delete(msg.prefix);
        break;
      }

      case "broadcast": {
        const broadcastMsg: ServerMsg = {
          op: "broadcast_recv",
          channel: msg.channel,
          data: msg.data,
        };
        // Exclude sender — consistent with subscribe change fanout.
        this.party.broadcast(JSON.stringify(broadcastMsg), [conn.id]);
        break;
      }

      case "schedule_alarm": {
        if (msg.delay < 0) {
          send(conn, { op: "error", requestId: msg.requestId, message: "delay must be >= 0" });
          break;
        }
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.put(`${META}alarm/fireAt`, Date.now() + msg.delay * 1000);
        await dos.put(`${META}alarm/action`, msg.action ?? null);
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "cancel_alarm": {
        const dos = this.party.storage as unknown as DurableObjectStorage;
        await dos.delete(`${META}alarm/fireAt`);
        await dos.delete(`${META}alarm/action`);
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
        await dos.put(`${META}alarm/recurring`, {
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
        await dos.delete(`${META}alarm/recurring`);
        await this.rescheduleNextAlarm(dos);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      default: {
        send(conn, { op: "error", message: "Unknown op" });
      }
    }
  }

  // ── Alarm action executor ───────────────────────────────────────────────────

  private async executeAction(action: AlarmAction) {
    switch (action.op) {
      case "set":
        await this.store.set(action.key, action.value);
        this.notifySubscribers(action.key, action.value, "");
        break;
      case "delete":
        await this.store.delete(action.key);
        this.notifySubscribers(action.key, null, "", true);
        break;
      case "increment": {
        const current = await this.store.get(action.key);
        const next = (typeof current === "number" ? current : 0) + (action.delta ?? 1);
        await this.store.set(action.key, next);
        this.notifySubscribers(action.key, next, "");
        break;
      }
      case "broadcast":
        this.party.broadcast(
          JSON.stringify({ op: "broadcast_recv", channel: action.channel, data: action.data })
        );
        break;
    }
  }

  // ── List helper ─────────────────────────────────────────────────────────────

  // Fetches user-visible keys, skipping internal __rs/ entries.
  // If a page is entirely internal keys, fetches the next page (up to 5 times)
  // so callers always get either user data or a definitive empty result.
  private async listUserKeys(
    prefix: string,
    limit?: number,
    cursor?: string
  ): Promise<{ entries: Record<string, unknown>; nextCursor?: string }> {
    const entries: Record<string, unknown> = {};
    let nextCursor: string | undefined;
    let fetchCursor = cursor;

    for (let i = 0; i < 5; i++) {
      const page = await this.store.list(prefix, limit, fetchCursor);
      for (const [k, v] of Object.entries(page.entries)) {
        if (!k.startsWith(META)) entries[k] = v;
      }
      nextCursor = page.nextCursor;
      const userCount = Object.keys(entries).length;
      // Stop when we have no more pages, or have met the requested limit.
      if (!nextCursor || (limit !== undefined && userCount >= limit)) break;
      fetchCursor = nextCursor;
    }

    // Trim if a page boundary caused overshoot beyond limit.
    if (limit) {
      const keys = Object.keys(entries);
      if (keys.length > limit) {
        const trimmed: Record<string, unknown> = {};
        for (const k of keys.slice(0, limit)) trimmed[k] = entries[k];
        // Use the last included key as nextCursor so the next page starts after it.
        return { entries: trimmed, nextCursor: keys[limit - 1] };
      }
    }

    return { entries, nextCursor };
  }

  // ── TTL helpers ─────────────────────────────────────────────────────────────

  private async scheduleTTL(key: string, ttl: number) {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    await dos.put(`${META}ttl/${key}`, Date.now() + ttl * 1000);
    await this.rescheduleNextAlarm(dos);
  }

  private async rescheduleNextAlarm(dos: DurableObjectStorage) {
    const now = Date.now();
    let next: number | null = null;

    const pick = (t: number) => { next = next === null ? t : Math.min(next, t); };

    // Paginate — DO storage list() returns max 128 entries per call.
    let ttlCursor: string | undefined;
    do {
      const ttlPage = await dos.list<number>({ prefix: `${META}ttl/`, startAfter: ttlCursor });
      for (const [k, expiresAt] of ttlPage) {
        if (expiresAt > now) pick(expiresAt);
        ttlCursor = k;
      }
      if (ttlPage.size < 128) break;
    } while (true);

    const fireAt = await dos.get<number>(`${META}alarm/fireAt`);
    // Clamp to at least now+1 so delay=0 alarms are always scheduled.
    if (fireAt) pick(Math.max(fireAt, now + 1));

    const rec = await dos.get<{ nextAt?: number }>(`${META}alarm/recurring`);
    if (rec) pick(Math.max(rec.nextAt ?? 0, now + 1));

    if (next !== null) await dos.setAlarm(next);
    else await dos.deleteAlarm();
  }

  private async clearTTL(key: string, skipReschedule = false) {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const had = await dos.get(`${META}ttl/${key}`);
    if (had !== undefined) {
      await dos.delete(`${META}ttl/${key}`);
      if (!skipReschedule) await this.rescheduleNextAlarm(dos);
    }
  }

  private async getWithTTLCheck(key: string): Promise<unknown> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const expiresAt = await dos.get<number>(`${META}ttl/${key}`);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.store.delete(key);
      await dos.delete(`${META}ttl/${key}`);
      this.notifySubscribers(key, null, "", true);
      return null;
    }
    return this.store.get(key);
  }

  // ── Subscription fanout ─────────────────────────────────────────────────────

  private notifySubscribers(
    key: string,
    value: unknown,
    sourceConnId: string,
    deleted = false
  ) {
    const changeMsg: ServerMsg = { op: "change", key, value, deleted };
    const payload = JSON.stringify(changeMsg);

    for (const [connId, prefixes] of this.subscriptions) {
      if (connId === sourceConnId) continue;
      for (const prefix of prefixes) {
        if (key.startsWith(prefix)) {
          this.party.getConnection(connId)?.send(payload);
          break;
        }
      }
    }
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────
  private checkRateLimit(connId: string): boolean {
    return this.rateCheck(this.rateLimits, connId);
  }

  private checkHttpRateLimit(apiKey: string): boolean {
    return this.rateCheck(this.httpRateLimits, apiKey);
  }

  private rateCheck(
    map: Map<string, { count: number; windowStart: number }>,
    key: string
  ): boolean {
    const now = Date.now();
    const existing = map.get(key);
    if (!existing || now - existing.windowStart > this.rateLimitWindowMs) {
      map.set(key, { count: 1, windowStart: now });
      return true;
    }
    existing.count++;
    return existing.count <= this.rateLimitOps;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  private authenticate(
    apiKey: string,
    env: Env
  ): { ok: true; appId: string } | { ok: false; reason: string } {
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
    await dos.put(`${META}persistence`, persistence);
    await dos.put(`${META}appId`, appId);
    await dos.put(`${META}roomId`, this.roomId);
    this.ready = true;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(conn: Party.Connection, msg: ServerMsg) {
  conn.send(JSON.stringify(msg));
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
