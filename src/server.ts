import type * as Party from "partykit/server";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createStore, type Store } from "./persistence.js";
import type {
  AlarmAction,
  ClientMsg,
  Env,
  PersistenceLevel,
  RateLimitInfo,
  ServerMsg,
} from "./types.js";

// Internal storage key prefix — never exposed to clients via list().
const META = "__rs/";

// Per-connection subscription state.
//   - keys:     exact-key subscriptions, target -> { includeSelf }.
//   - prefixes: prefix subscriptions,    target -> { includeSelf }.
// A subscribing client may overwrite includeSelf by re-sending subscribe with
// a different value; unsubscribe removes the entry regardless of includeSelf.
interface ConnSubs {
  keys: Map<string, { includeSelf: boolean }>;
  prefixes: Map<string, { includeSelf: boolean }>;
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

  private subscriptions = new Map<string, ConnSubs>();

  private rateLimits = new Map<string, RateBucket>();
  private httpRateLimits = new Map<string, RateBucket>();
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
      for (const conn of liveConnections) {
        this.subscriptions.set(conn.id, emptyConnSubs());
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
    this.subscriptions.set(conn.id, emptyConnSubs());

    await this.ensureInit(authResult.appId, persistence);

    const presenceKey = `presence/${conn.id}`;
    const presenceValue = { connectedAt: Date.now() };
    await this.store.set(presenceKey, presenceValue);
    this.notifySet(presenceKey, presenceValue, conn.id);

    send(conn, {
      op: "ready",
      persistence: this.persistence,
      appId: this.appId,
      roomId: this.roomId,
      connectionId: conn.id,
    });
  }

  async onMessage(message: string | ArrayBuffer, conn: Party.Connection) {
    if (!this.ready) {
      send(conn, { op: "error", message: "Room not initialized" });
      return;
    }

    const rate = this.checkRateLimit(conn.id);
    if (!rate.allowed) {
      send(conn, {
        op: "error",
        message: "Rate limit exceeded",
        rateLimit: toRateLimitInfo(rate),
      });
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
      this.notifyDelete(presenceKey, conn.id);
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
          this.notifyDelete(key, null);
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

    await this.rescheduleNextAlarm(dos);
  }

  // ── HTTP REST API ───────────────────────────────────────────────────────────
  // GET  /parties/room/{id}?key=path        → { key, value }
  // GET  /parties/room/{id}?prefix=p&limit=N&cursor=C → { entries, nextCursor }
  // POST /parties/room/{id}  body: { key, value, ttl? } → { ok }
  // DELETE /parties/room/{id}?key=path      → { ok }

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
      await this.ensureInit(authResult.appId, "storage");
    }

    try {
      if (req.method === "GET") {
        const key = url.searchParams.get("key");
        const prefix = url.searchParams.get("prefix");
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor") ?? undefined;

        if (key !== null) {
          if (key.startsWith(META)) return cors(Response.json({ key, value: null }));
          const value = await this.getWithTTLCheck(key, null);
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
        if (!("value" in (body as object)))
          return cors(new Response("Missing value", { status: 400 }));
        if (body.key.startsWith(META) || body.key.startsWith("presence/"))
          return cors(new Response("Reserved key prefix", { status: 400 }));
        await this.store.set(body.key, body.value);
        await this.clearTTL(body.key, !!body.ttl);
        if (body.ttl) await this.scheduleTTL(body.key, body.ttl);
        this.notifySet(body.key, body.value, null);
        return cors(Response.json({ ok: true }));
      }

      if (req.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) return cors(new Response("Missing key", { status: 400 }));
        if (key.startsWith(META) || key.startsWith("presence/"))
          return cors(new Response("Reserved key prefix", { status: 400 }));
        await this.store.delete(key);
        await this.clearTTL(key);
        this.notifyDelete(key, null);
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
        this.notifySet(msg.key, msg.value, conn.id);
        break;
      }

      case "get": {
        if (msg.key.startsWith(META)) {
          send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: null });
          break;
        }
        const value = await this.getWithTTLCheck(msg.key, conn.id);
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
        this.notifyDelete(msg.key, conn.id);
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
        const current = await this.getWithTTLCheck(msg.key, conn.id);
        const num = typeof current === "number" ? current : 0;
        const next = num + (msg.delta ?? 1);
        await this.store.set(msg.key, next);
        send(conn, { op: "result", requestId: msg.requestId, key: msg.key, value: next });
        this.notifySet(msg.key, next, conn.id);
        break;
      }

      case "set_if": {
        if (msg.key.startsWith(META) || msg.key.startsWith("presence/")) {
          send(conn, { op: "error", requestId: msg.requestId, message: "Reserved key prefix" });
          break;
        }
        const current = await this.getWithTTLCheck(msg.key, conn.id);
        const match = deepEqual(current, msg.ifValue);
        if (match) {
          await this.store.set(msg.key, msg.value);
          this.notifySet(msg.key, msg.value, conn.id);
        }
        send(conn, {
          op: "set_if_result",
          requestId: msg.requestId,
          success: match,
          current,
        });
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
        // Touch only refreshes TTL on keys that have a value. The store's get()
        // collapses missing-key and stored-null to null, so touch on null-valued
        // keys is rejected too.
        const current = await this.store.get(msg.key);
        if (current === null || current === undefined) {
          send(conn, {
            op: "error",
            requestId: msg.requestId,
            message: "Cannot touch key (does not exist or is null)",
          });
          break;
        }
        await this.scheduleTTL(msg.key, msg.ttl);
        send(conn, { op: "ack", requestId: msg.requestId });
        break;
      }

      case "delete_prefix": {
        if (
          msg.prefix.startsWith(META) ||
          msg.prefix.startsWith("presence/") ||
          msg.prefix === ""
        ) {
          send(conn, {
            op: "error",
            requestId: msg.requestId,
            message:
              msg.prefix === ""
                ? "delete_prefix requires a non-empty prefix"
                : "Reserved key prefix",
          });
          break;
        }
        const deleted = await this.deletePrefix(msg.prefix, conn.id);
        send(conn, {
          op: "delete_prefix_result",
          requestId: msg.requestId,
          deleted,
        });
        break;
      }

      case "snapshot": {
        const keysOut: Record<string, unknown> = {};
        const prefixesOut: Record<string, Record<string, unknown>> = {};

        if (msg.keys) {
          for (const k of msg.keys) {
            if (k.startsWith(META)) continue;
            keysOut[k] = await this.getWithTTLCheck(k, conn.id);
          }
        }

        if (msg.prefixes) {
          for (const p of msg.prefixes) {
            if (p !== "" && !p.endsWith("/")) {
              send(conn, {
                op: "error",
                requestId: msg.requestId,
                message: "Prefix must end with '/' or be empty string",
              });
              return;
            }
            prefixesOut[p] = await this.collectAllUserKeys(p);
          }
        }

        send(conn, {
          op: "snapshot_result",
          requestId: msg.requestId,
          keys: keysOut,
          prefixes: prefixesOut,
        });
        break;
      }

      case "subscribe_key": {
        const subs = this.subscriptions.get(conn.id);
        if (!subs) break;
        if (msg.key.startsWith(META)) {
          send(conn, { op: "error", message: "Reserved key prefix" });
          break;
        }
        subs.keys.set(msg.key, { includeSelf: msg.includeSelf === true });
        break;
      }

      case "subscribe_prefix": {
        const subs = this.subscriptions.get(conn.id);
        if (!subs) break;
        if (msg.prefix !== "" && !msg.prefix.endsWith("/")) {
          send(conn, {
            op: "error",
            message: "Prefix must end with '/' or be empty string",
          });
          break;
        }
        if (msg.prefix.startsWith(META)) {
          send(conn, { op: "error", message: "Reserved key prefix" });
          break;
        }
        subs.prefixes.set(msg.prefix, { includeSelf: msg.includeSelf === true });
        break;
      }

      case "unsubscribe_key": {
        this.subscriptions.get(conn.id)?.keys.delete(msg.key);
        break;
      }

      case "unsubscribe_prefix": {
        this.subscriptions.get(conn.id)?.prefixes.delete(msg.prefix);
        break;
      }

      case "broadcast": {
        const broadcastMsg: ServerMsg = {
          op: "broadcast_recv",
          channel: msg.channel,
          data: msg.data,
        };
        // Exclude sender — consistent with subscribe change fanout default.
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
        this.notifySet(action.key, action.value, null);
        break;
      case "delete":
        await this.store.delete(action.key);
        this.notifyDelete(action.key, null);
        break;
      case "increment": {
        const current = await this.store.get(action.key);
        const next = (typeof current === "number" ? current : 0) + (action.delta ?? 1);
        await this.store.set(action.key, next);
        this.notifySet(action.key, next, null);
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

  // Fetches user-visible keys, skipping internal __rs/ entries.
  // If a page is entirely internal keys, fetches the next page (up to 20 times)
  // so callers always get either user data or a definitive empty result.
  private async listUserKeys(
    prefix: string,
    limit?: number,
    cursor?: string
  ): Promise<{ entries: Record<string, unknown>; nextCursor?: string }> {
    const entries: Record<string, unknown> = {};
    let nextCursor: string | undefined;
    let fetchCursor = cursor;

    const META_SKIP =
      META.slice(0, -1) + String.fromCharCode(META.charCodeAt(META.length - 1) + 1);

    for (let i = 0; i < 20; i++) {
      const page = await this.store.list(prefix, limit, fetchCursor);
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
      fetchCursor = (!pageHadUserKeys && nextCursor.startsWith(META))
        ? META_SKIP
        : nextCursor;
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

  // Fetches every user-visible key under a prefix in a single call. Used by
  // snapshot — bounded by a safety cap to prevent runaway memory use.
  private async collectAllUserKeys(prefix: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    let cursor: string | undefined;
    const HARD_CAP = 10_000;

    while (true) {
      const page = await this.listUserKeys(prefix, 128, cursor);
      Object.assign(out, page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (Object.keys(out).length >= HARD_CAP) break;
    }
    return out;
  }

  // Walks every user-visible key under a prefix and deletes it. Returns the
  // count. Reschedules the alarm once at the end rather than per-key.
  private async deletePrefix(prefix: string, sourceConnId: string): Promise<number> {
    const META_SKIP =
      META.slice(0, -1) + String.fromCharCode(META.charCodeAt(META.length - 1) + 1);

    let count = 0;
    let cursor: string | undefined;
    let touchedAnyTTL = false;
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
        const had = await dos.get(`${META}ttl/${k}`);
        if (had !== undefined) {
          await dos.delete(`${META}ttl/${k}`);
          touchedAnyTTL = true;
        }
        this.notifyDelete(k, sourceConnId);
        count++;
      }

      if (!page.nextCursor) break;
      cursor = (!pageHadUserKeys && page.nextCursor.startsWith(META))
        ? META_SKIP
        : page.nextCursor;
    }

    if (touchedAnyTTL) await this.rescheduleNextAlarm(dos);
    return count;
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

  private async getWithTTLCheck(key: string, sourceConnId: string | null): Promise<unknown> {
    const dos = this.party.storage as unknown as DurableObjectStorage;
    const expiresAt = await dos.get<number>(`${META}ttl/${key}`);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.store.delete(key);
      await dos.delete(`${META}ttl/${key}`);
      this.notifyDelete(key, sourceConnId);
      return null;
    }
    return this.store.get(key);
  }

  // ── Subscription fanout ─────────────────────────────────────────────────────

  private notifySet(key: string, value: unknown, originConnId: string | null) {
    this.fanout(key, originConnId, {
      op: "change",
      type: "set",
      key,
      value,
      originConnId,
    });
  }

  private notifyDelete(key: string, originConnId: string | null) {
    this.fanout(key, originConnId, {
      op: "change",
      type: "delete",
      key,
      originConnId,
    });
  }

  // Walks all connections and dispatches `change` to those whose subscription
  // matches `key`. A connection that originated the change only receives it if
  // at least one matching sub has `includeSelf: true`.
  private fanout(key: string, sourceConnId: string | null, msg: ServerMsg) {
    let payload: string | null = null;

    for (const [connId, subs] of this.subscriptions) {
      const isSource = sourceConnId !== null && connId === sourceConnId;

      let matched = false;
      let includeSelf = false;

      const exact = subs.keys.get(key);
      if (exact) {
        matched = true;
        if (exact.includeSelf) includeSelf = true;
      }
      if (!includeSelf) {
        for (const [prefix, sub] of subs.prefixes) {
          if (key.startsWith(prefix)) {
            matched = true;
            if (sub.includeSelf) {
              includeSelf = true;
              break;
            }
          }
        }
      }

      if (!matched) continue;
      if (isSource && !includeSelf) continue;

      payload ??= JSON.stringify(msg);
      this.party.getConnection(connId)?.send(payload);
    }
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────

  private checkRateLimit(connId: string): RateCheckResult {
    return this.rateCheck(this.rateLimits, connId);
  }

  private checkHttpRateLimit(apiKey: string): RateCheckResult {
    return this.rateCheck(this.httpRateLimits, apiKey);
  }

  private rateCheck(
    map: Map<string, RateBucket>,
    key: string
  ): RateCheckResult {
    const now = Date.now();
    const limit = this.rateLimitOps;
    const window = this.rateLimitWindowMs;
    const existing = map.get(key);

    if (!existing || now - existing.windowStart > window) {
      map.set(key, { count: 1, windowStart: now, warned: false });
      return {
        allowed: true,
        limit,
        window,
        remaining: limit - 1,
        resetAt: now + window,
      };
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

  // Push a one-time `rate_limit_warning` per window once usage crosses 80%.
  private maybeWarnRateLimit(
    conn: Party.Connection,
    connId: string,
    rate: RateCheckResult
  ) {
    const bucket = this.rateLimits.get(connId);
    if (!bucket || bucket.warned) return;
    if (rate.remaining / rate.limit > 0.2) return;
    bucket.warned = true;
    send(conn, {
      op: "rate_limit_warning",
      remaining: rate.remaining,
      resetAt: rate.resetAt,
    });
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

function emptyConnSubs(): ConnSubs {
  return { keys: new Map(), prefixes: new Map() };
}

function toRateLimitInfo(r: RateCheckResult): RateLimitInfo {
  return { limit: r.limit, window: r.window, remaining: r.remaining, resetAt: r.resetAt };
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
