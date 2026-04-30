import PartySocket from "partysocket";
import type {
  AlarmAction,
  ClientMsg,
  ConnectConfig,
  ListResult,
  PersistenceLevel,
  RateLimitInfo,
  ServerMsg,
  SnapshotResult,
} from "./types.js";

export type {
  ConnectConfig,
  ListResult,
  PersistenceLevel,
  RateLimitInfo,
  SnapshotResult,
};

// ── Public types ──────────────────────────────────────────────────────────────

export type ChangeEvent =
  | {
      type: "set";
      key: string;
      value: unknown;
      // Connection that originated the write. `null` for HTTP, alarm, or TTL
      // sweeps. Compare with `client.connectionId` to detect self-writes.
      originConnId: string | null;
    }
  | {
      type: "delete";
      key: string;
      originConnId: string | null;
    };

export type ChangeHandler = (event: ChangeEvent) => void;
export type BroadcastHandler = (data: unknown) => void;
export type UnsubscribeFn = () => void;

export type Status = "connecting" | "ready" | "reconnecting" | "closed";

export interface SubscribeOptions {
  /**
   * If true, the handler will also fire for changes originated by this same
   * client (i.e. the server will echo this connection's writes back to it).
   * Defaults to false.
   */
  includeSelf?: boolean;
}

export interface SetOptions {
  ttl?: number; // seconds
}

export interface SetIfResult {
  success: boolean;
  current: unknown;
}

export interface DeletePrefixResult {
  deleted: number;
}

export interface SnapshotRequest {
  keys?: string[];
  prefixes?: string[];
}

export interface RateLimitWarning {
  remaining: number;
  resetAt: number;
}

export class RoomError extends Error {
  rateLimit?: RateLimitInfo;
  constructor(message: string, rateLimit?: RateLimitInfo) {
    super(message);
    this.name = "RoomError";
    if (rateLimit) this.rateLimit = rateLimit;
  }
}

export interface RoomClientEvents {
  status: Status;
  rateLimit: RateLimitWarning;
}

export interface IRoomClient {
  readonly status: Status;
  readonly connectionId: string | null;
  debug: boolean;

  ready(timeoutMs?: number): Promise<void>;

  set(key: string, value: unknown, opts?: SetOptions): Promise<void>;
  get(key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<ListResult>;

  increment(key: string, delta?: number): Promise<number>;
  setIf(key: string, value: unknown, ifValue: unknown): Promise<SetIfResult>;
  touch(key: string, opts: { ttl: number }): Promise<void>;
  deletePrefix(prefix: string): Promise<DeletePrefixResult>;
  snapshot(req: SnapshotRequest): Promise<SnapshotResult>;

  scheduleAlarm(delay: number, action?: AlarmAction): Promise<void>;
  cancelAlarm(): Promise<void>;
  scheduleRecurring(interval: number, action: AlarmAction): Promise<void>;
  cancelRecurring(): Promise<void>;

  subscribeKey(
    key: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn;
  subscribePrefix(
    prefix: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn;

  broadcast(channel: string, data: unknown): void;
  onBroadcast(channel: string, handler: BroadcastHandler): UnsubscribeFn;

  on<E extends keyof RoomClientEvents>(
    event: E,
    handler: (payload: RoomClientEvents[E]) => void
  ): UnsubscribeFn;

  flushAndDisconnect(timeoutMs?: number): Promise<void>;
  disconnect(): void;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  msg: ClientMsg;
}

interface HandlerEntry {
  handler: ChangeHandler;
  includeSelf: boolean;
}

interface SubGroup {
  kind: "key" | "prefix";
  target: string;
  handlers: Set<HandlerEntry>;
  // Last includeSelf value sent to the server. Re-sent if the OR over handlers
  // changes (because subscribing again with a different includeSelf overwrites
  // the server-side state for that connection+target).
  serverIncludeSelf: boolean;
}

export interface RoomClientOptions {
  host: string;
  roomId: string;
  config: ConnectConfig;
}

// ── RoomClient ────────────────────────────────────────────────────────────────

export class RoomClient implements IRoomClient {
  private socket: PartySocket;
  private pending = new Map<string, Pending>();
  private subs = new Map<string, SubGroup>();
  private broadcastHandlers = new Map<string, Set<BroadcastHandler>>();

  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;
  private isFirstOpen = true;

  private _status: Status = "connecting";
  private _connectionId: string | null = null;
  private userClosed = false;

  private listeners: { [E in keyof RoomClientEvents]: Set<(p: RoomClientEvents[E]) => void> } = {
    status: new Set(),
    rateLimit: new Set(),
  };

  private sessionId: string;
  private uidCounter = 0;

  debug = false;

  constructor(opts: RoomClientOptions) {
    const { host, roomId, config } = opts;
    const params = new URLSearchParams({
      apiKey: config.apiKey,
      persistence: config.persistence ?? "storage",
    });

    this.sessionId = makeSessionId();

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = () => {
        this.readySettled = true;
        resolve();
      };
      this.rejectReady = (err) => {
        this.readySettled = true;
        reject(err);
      };
    });

    this.socket = new PartySocket({
      host,
      party: "room",
      room: `${config.apiKey}:${roomId}`,
      query: Object.fromEntries(params),
    });

    this.socket.addEventListener("open", () => {
      this.log("ws", "open");
      if (this.isFirstOpen) {
        this.isFirstOpen = false;
        return;
      }
      // Reconnect: restore subscriptions and replay in-flight ops.
      for (const group of this.subs.values()) {
        this.sendSubscribe(group.kind, group.target, group.serverIncludeSelf);
      }
      for (const { msg } of this.pending.values()) {
        this.sendRaw(msg);
      }
    });

    this.socket.addEventListener("close", () => {
      this.log("ws", "close");
      this._connectionId = null;
      if (this.userClosed) {
        this.setStatus("closed");
      } else {
        this.setStatus("reconnecting");
      }
    });

    this.socket.addEventListener("error", (evt: Event) => {
      this.log("ws", "error", evt);
    });

    this.socket.addEventListener("message", (evt: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(evt.data as string) as ServerMsg;
      } catch {
        return;
      }
      this.log("recv", msg);
      this.onMessage(msg);
    });
  }

  // ── Status / events ─────────────────────────────────────────────────────────

  get status(): Status {
    return this._status;
  }

  get connectionId(): string | null {
    return this._connectionId;
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
      try {
        h(payload);
      } catch (err) {
        console.error(`[room-server] listener for ${event} threw`, err);
      }
    }
  }

  private setStatus(s: Status) {
    if (this._status === s) return;
    this._status = s;
    this.emit("status", s);
  }

  // ── Handshake ───────────────────────────────────────────────────────────────

  ready(timeoutMs = 10_000): Promise<void> {
    if (this.readySettled) return this.readyPromise;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("room-server: ready() timed out")),
        timeoutMs
      );
      this.readyPromise.then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  set(key: string, value: unknown, opts?: SetOptions): Promise<void> {
    const msg: ClientMsg = { op: "set", key, value, ...opts };
    return this.op(msg, () => undefined);
  }

  get(key: string): Promise<unknown> {
    return this.op({ op: "get", key }, (v) => v);
  }

  delete(key: string): Promise<void> {
    return this.op({ op: "delete", key }, () => undefined);
  }

  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<ListResult> {
    const msg: ClientMsg = { op: "list", prefix, limit: opts?.limit, cursor: opts?.cursor };
    return this.op(msg, (v) => v as ListResult);
  }

  // ── Atomic ops ──────────────────────────────────────────────────────────────

  increment(key: string, delta = 1): Promise<number> {
    return this.op({ op: "increment", key, delta }, (v) => v as number);
  }

  setIf(key: string, value: unknown, ifValue: unknown): Promise<SetIfResult> {
    return this.op({ op: "set_if", key, value, ifValue }, (v) => v as SetIfResult);
  }

  touch(key: string, opts: { ttl: number }): Promise<void> {
    return this.op({ op: "touch", key, ttl: opts.ttl }, () => undefined);
  }

  deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    return this.op({ op: "delete_prefix", prefix }, (v) => v as DeletePrefixResult);
  }

  snapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    return this.op({ op: "snapshot", keys: req.keys, prefixes: req.prefixes }, (v) =>
      v as SnapshotResult
    );
  }

  // ── Scheduled alarms ────────────────────────────────────────────────────────

  scheduleAlarm(delay: number, action?: AlarmAction): Promise<void> {
    return this.op({ op: "schedule_alarm", delay, action }, () => undefined);
  }

  cancelAlarm(): Promise<void> {
    return this.op({ op: "cancel_alarm" }, () => undefined);
  }

  scheduleRecurring(interval: number, action: AlarmAction): Promise<void> {
    return this.op({ op: "schedule_recurring", interval, action }, () => undefined);
  }

  cancelRecurring(): Promise<void> {
    return this.op({ op: "cancel_recurring" }, () => undefined);
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  subscribeKey(
    key: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
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
    return this.addSubscription("prefix", prefix, handler, opts?.includeSelf === true);
  }

  private addSubscription(
    kind: "key" | "prefix",
    target: string,
    handler: ChangeHandler,
    includeSelf: boolean
  ): UnsubscribeFn {
    const subKey = `${kind}:${target}`;
    let group = this.subs.get(subKey);

    if (!group) {
      group = {
        kind,
        target,
        handlers: new Set(),
        serverIncludeSelf: includeSelf,
      };
      this.subs.set(subKey, group);
      this.sendSubscribe(kind, target, includeSelf);
    } else if (includeSelf && !group.serverIncludeSelf) {
      group.serverIncludeSelf = true;
      this.sendSubscribe(kind, target, true);
    }

    const entry: HandlerEntry = { handler, includeSelf };
    group.handlers.add(entry);

    return () => {
      const g = this.subs.get(subKey);
      if (!g) return;
      g.handlers.delete(entry);
      if (g.handlers.size === 0) {
        this.subs.delete(subKey);
        this.sendUnsubscribe(kind, target);
      } else {
        const desired = anyWantsSelf(g);
        if (desired !== g.serverIncludeSelf) {
          g.serverIncludeSelf = desired;
          this.sendSubscribe(kind, target, desired);
        }
      }
    };
  }

  private sendSubscribe(kind: "key" | "prefix", target: string, includeSelf: boolean) {
    const msg: ClientMsg =
      kind === "key"
        ? { op: "subscribe_key", key: target, includeSelf }
        : { op: "subscribe_prefix", prefix: target, includeSelf };
    this.sendRaw(msg);
  }

  private sendUnsubscribe(kind: "key" | "prefix", target: string) {
    const msg: ClientMsg =
      kind === "key"
        ? { op: "unsubscribe_key", key: target }
        : { op: "unsubscribe_prefix", prefix: target };
    this.sendRaw(msg);
  }

  // ── Broadcast ───────────────────────────────────────────────────────────────

  broadcast(channel: string, data: unknown): void {
    this.sendRaw({ op: "broadcast", channel, data });
  }

  onBroadcast(channel: string, handler: BroadcastHandler): UnsubscribeFn {
    let handlers = this.broadcastHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.broadcastHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      this.broadcastHandlers.get(channel)?.delete(handler);
    };
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  async flushAndDisconnect(timeoutMs = 5_000): Promise<void> {
    this.userClosed = true;
    if (this.pending.size > 0) {
      const pendings = [...this.pending.values()].map(
        (p) => new Promise<void>((res) => {
          const origResolve = p.resolve;
          const origReject = p.reject;
          p.resolve = (v) => { origResolve(v); res(); };
          p.reject = (e) => { origReject(e); res(); };
        })
      );
      await Promise.race([
        Promise.all(pendings).then(() => undefined),
        new Promise<void>((res) => setTimeout(res, timeoutMs)),
      ]);
    }
    this.socket.close();
    this.setStatus("closed");
  }

  disconnect() {
    this.userClosed = true;
    for (const { reject } of this.pending.values()) {
      reject(new RoomError("Disconnected"));
    }
    this.pending.clear();
    this.socket.close();
    this.setStatus("closed");
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private op<T>(baseMsg: ClientMsg, transform: (v: unknown) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = this.uid();
      const msg: ClientMsg = { ...baseMsg, requestId } as ClientMsg;
      this.pending.set(requestId, {
        resolve: (v) => resolve(transform(v)),
        reject,
        msg,
      });
      this.sendRaw(msg);
    });
  }

  private sendRaw(msg: ClientMsg) {
    this.log("send", msg);
    this.socket.send(JSON.stringify(msg));
  }

  private uid(): string {
    return `${this.sessionId}-${++this.uidCounter}`;
  }

  private log(...args: unknown[]) {
    if (!this.debug) return;
    console.log("[room-server]", ...args);
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.op) {
      case "ready":
        this._connectionId = msg.connectionId;
        this.setStatus("ready");
        if (!this.readySettled) this.resolveReady();
        break;

      case "ack": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve(undefined);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve(msg.value);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "list_result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve({
            entries: msg.entries,
            nextCursor: msg.nextCursor,
          } satisfies ListResult);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "set_if_result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve({
            success: msg.success,
            current: msg.current,
          } satisfies SetIfResult);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "delete_prefix_result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve({
            deleted: msg.deleted,
          } satisfies DeletePrefixResult);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "snapshot_result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve({
            keys: msg.keys,
            prefixes: msg.prefixes,
          } satisfies SnapshotResult);
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "change": {
        const isSelf =
          this._connectionId !== null && msg.originConnId === this._connectionId;

        const event: ChangeEvent =
          msg.type === "set"
            ? {
                type: "set",
                key: msg.key,
                value: msg.value,
                originConnId: msg.originConnId,
              }
            : {
                type: "delete",
                key: msg.key,
                originConnId: msg.originConnId,
              };

        for (const group of this.subs.values()) {
          const matches =
            group.kind === "key"
              ? msg.key === group.target
              : msg.key.startsWith(group.target);
          if (!matches) continue;
          for (const entry of group.handlers) {
            if (isSelf && !entry.includeSelf) continue;
            try {
              entry.handler(event);
            } catch (err) {
              console.error("[room-server] change handler threw", err);
            }
          }
        }
        break;
      }

      case "broadcast_recv": {
        const handlers = this.broadcastHandlers.get(msg.channel);
        if (handlers) for (const h of handlers) {
          try { h(msg.data); } catch (err) {
            console.error("[room-server] broadcast handler threw", err);
          }
        }
        break;
      }

      case "rate_limit_warning": {
        this.emit("rateLimit", { remaining: msg.remaining, resetAt: msg.resetAt });
        break;
      }

      case "error": {
        this.log("error", msg);
        const err = new RoomError(msg.message, msg.rateLimit);
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.reject(err);
          this.pending.delete(msg.requestId);
        } else {
          // Connection-level error with no requestId (e.g. rate-limit on a
          // fire-and-forget op like broadcast). Surface to console.
          console.error(`[room-server] ${msg.message}`, msg.rateLimit ?? "");
        }
        break;
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function anyWantsSelf(group: SubGroup): boolean {
  for (const e of group.handlers) if (e.includeSelf) return true;
  return false;
}

function makeSessionId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
