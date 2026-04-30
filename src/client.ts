import PartySocket from "partysocket";
import type {
  AlarmAction,
  ClientMsg,
  ConnectConfig,
  CountResult,
  JsonSchema,
  ListResult,
  PersistenceLevel,
  RateLimitInfo,
  RoomErrorKind,
  ServerMsg,
  SnapshotResult,
  TransactOp,
  TransactOpResult,
  ValidationErrorDetail,
} from "./types.js";

export type {
  ConnectConfig,
  CountResult,
  JsonSchema,
  ListResult,
  PersistenceLevel,
  RateLimitInfo,
  RoomErrorKind,
  SnapshotResult,
  TransactOp,
  TransactOpResult,
  ValidationErrorDetail,
};

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A room schema is a map from key-pattern to value type. Patterns:
 *
 *  - exact key:  `"meta"`, `"settings"`
 *  - prefix:     `"users/"`, `"votes/"` (must end with `/`)
 *  - catch-all:  `"*"`
 *
 * Resolution priority (matches the server-side validator): exact > longest
 * prefix > `"*"` > `unknown`. Both `interface Schema { ... }` and
 * `type Schema = { ... }` declarations are accepted (the constraint is `object`
 * rather than `Record<string, unknown>` so plain interfaces type-check).
 */
export type RoomSchemaMap = object;

type MatchPrefix<S, K extends string> = {
  [P in keyof S & string]: P extends `${infer Pre}/`
    ? K extends `${Pre}/${string}`
      ? S[P]
      : never
    : never;
}[keyof S & string];

/** Resolve the value type stored at `K` against schema map `S`. */
export type ResolveKey<S, K extends string> = K extends keyof S
  ? S[K]
  : MatchPrefix<S, K> extends never
    ? "*" extends keyof S
      ? S["*"]
      : unknown
    : MatchPrefix<S, K>;

export type TypedChangeEvent<V> =
  | {
      type: "set";
      key: string;
      value: V;
      /** Revision after this change. */
      rev: number;
      /** Connection that originated the write. `null` for HTTP, alarm, or TTL sweeps. */
      originConnId: string | null;
    }
  | {
      type: "delete";
      key: string;
      /**
       * Last known value before the delete. The server emits this on every
       * delete event when it can read the prior value cheaply (which is
       * essentially always). `null` when the key was already absent or the
       * prior value really was `null`. Lets subscribers maintain derived
       * state keyed by something other than the storage key.
       */
      priorValue: V | null;
      rev: number;
      originConnId: string | null;
    };

export type ChangeEvent = TypedChangeEvent<unknown>;

export type ChangeHandler = (event: ChangeEvent) => void;
export type BroadcastHandler = (data: unknown) => void;
export type UnsubscribeFn = () => void;

export type Status = "connecting" | "ready" | "reconnecting" | "closed";

export interface SubscribeOptions {
  /** Receive changes originated by this client. Default: false. */
  includeSelf?: boolean;
  /**
   * Server-side flow control: collect changes for this subscription and emit
   * them as a single `change_batch` every N ms (which the SDK transparently
   * fans out to handlers). Helpful for noisy prefixes; trades latency for
   * fewer wire frames. Default: immediate delivery.
   */
  batchMs?: number;
}

export interface SetOptions {
  ttl?: number;
}

export interface SetResult {
  rev: number;
}

export interface GetResult {
  value: unknown;
  rev: number;
}

export interface SetIfOptions {
  /** Set only if current value deeply equals this. */
  ifValue?: unknown;
  /** Set only if current revision equals this. `0` matches non-existent keys. */
  ifRev?: number;
}

export interface SetIfResult {
  success: boolean;
  current: unknown;
  rev: number;
}

export interface IncrementResult {
  value: number;
  rev: number;
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

export interface TransactResult {
  success: boolean;
  results: TransactOpResult[];
  error?: string;
}

export interface InitialKeySnapshot {
  value: unknown;
  rev: number;
}

export interface InitialPrefixSnapshot {
  entries: Record<string, unknown>;
  truncated?: boolean;
}

export interface SubscribeWithSnapshotKeyResult {
  initial: InitialKeySnapshot;
  unsubscribe: UnsubscribeFn;
}

export interface SubscribeWithSnapshotPrefixResult {
  initial: InitialPrefixSnapshot;
  unsubscribe: UnsubscribeFn;
}

export interface ValidationErrorPayload {
  key: string;
  schemaPattern: string;
  errors: ValidationErrorDetail[];
}

export interface SchemaConflictPayload {
  incomingVersion: number;
  currentVersion: number;
}

export class RoomError extends Error {
  kind: RoomErrorKind;
  rateLimit?: RateLimitInfo;
  validationError?: ValidationErrorPayload;
  schemaConflict?: SchemaConflictPayload;
  constructor(
    message: string,
    extras?: {
      kind?: RoomErrorKind;
      rateLimit?: RateLimitInfo;
      validationError?: ValidationErrorPayload;
      schemaConflict?: SchemaConflictPayload;
    }
  ) {
    super(message);
    this.name = "RoomError";
    this.kind = extras?.kind ?? "unknown";
    if (extras?.rateLimit) this.rateLimit = extras.rateLimit;
    if (extras?.validationError) this.validationError = extras.validationError;
    if (extras?.schemaConflict) this.schemaConflict = extras.schemaConflict;
  }
}

export interface RoomClientEvents {
  status: Status;
  rateLimit: RateLimitWarning;
}

// Optional Standard-Schema-shaped validator. Mirrors the `~standard.validate`
// surface so consumers can pass Zod/Valibot/ArkType/etc schemas without us
// importing any of them.
export interface StandardSchemaLike<T = unknown> {
  "~standard": {
    validate: (value: unknown) =>
      | { value: T }
      | { issues: { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }[] }
      | Promise<
          | { value: T }
          | { issues: { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }[] }
        >;
  };
}

// Generic key→value schema map. Entries with a trailing `/` are prefix patterns;
// entries without are exact keys. `"*"` is the catch-all.
export type ClientSchemaMap = Record<string, StandardSchemaLike<unknown>>;

/**
 * Constructor schemas option. All three sub-fields are independent:
 *
 *  - `server` — JSON Schema map registered on the room (server-side validation
 *    that rejects bad writes from any client). Persists across reconnects.
 *  - `client` — Standard Schema validators run locally before each set/update,
 *    failing fast without a round-trip.
 *  - `version` — monotonic integer. When the local version > server's, the SDK
 *    auto-uploads `server` schemas in the handshake. When local <= server, the
 *    SDK skips registration entirely (zero bandwidth waste in steady state and
 *    deterministic behavior under racing tabs running mixed code versions).
 */
export interface RoomSchemasConfig {
  server?: Record<string, JsonSchema>;
  client?: ClientSchemaMap;
  version?: number;
}

export interface RoomClientOptions {
  host: string;
  roomId: string;
  config: ConnectConfig;
  schemas?: RoomSchemasConfig;
}

export interface IRoomClient<S extends RoomSchemaMap = RoomSchemaMap> {
  readonly status: Status;
  readonly connectionId: string | null;
  readonly schemaVersion: number | null;
  debug: boolean;

  ready(timeoutMs?: number): Promise<void>;

  set<K extends string>(key: K, value: ResolveKey<S, K>, opts?: SetOptions): Promise<SetResult>;
  get<K extends string>(key: K): Promise<{ value: ResolveKey<S, K> | null; rev: number }>;
  delete(key: string): Promise<SetResult>;
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<ListResult>;
  count(prefix: string): Promise<CountResult>;

  increment(key: string, delta?: number): Promise<IncrementResult>;
  setIf<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts: SetIfOptions & SetOptions
  ): Promise<SetIfResult>;
  update<K extends string>(
    key: K,
    fn: (current: ResolveKey<S, K> | null) => ResolveKey<S, K>
  ): Promise<{ value: ResolveKey<S, K>; rev: number }>;
  touch(key: string, opts: { ttl: number }): Promise<void>;
  reserve<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts?: SetOptions
  ): Promise<boolean>;
  deletePrefix(prefix: string): Promise<DeletePrefixResult>;
  snapshot(req: SnapshotRequest): Promise<SnapshotResult>;
  transact(ops: TransactOp[]): Promise<TransactResult>;

  registerSchemas(
    schemas: Record<string, JsonSchema>,
    opts?: { replace?: boolean; version?: number }
  ): Promise<{ count: number; schemaVersion: number }>;

  scheduleAlarm(delay: number, action?: AlarmAction): Promise<void>;
  cancelAlarm(): Promise<void>;
  scheduleRecurring(interval: number, action: AlarmAction): Promise<void>;
  cancelRecurring(): Promise<void>;

  subscribeKey<K extends string>(
    key: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): UnsubscribeFn;
  subscribePrefix<K extends string>(
    prefix: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): UnsubscribeFn;

  subscribeWithSnapshotKey<K extends string>(
    key: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): Promise<{
    initial: { value: ResolveKey<S, K> | null; rev: number };
    unsubscribe: UnsubscribeFn;
  }>;
  subscribeWithSnapshotPrefix<K extends string>(
    prefix: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): Promise<SubscribeWithSnapshotPrefixResult>;

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
  batchMs?: number;
}

interface SubGroup {
  kind: "key" | "prefix";
  target: string;
  handlers: Set<HandlerEntry>;
  serverIncludeSelf: boolean;
  serverBatchMs?: number;
}

// ── RoomClient ────────────────────────────────────────────────────────────────

const UPDATE_MAX_RETRIES = 5;

export class RoomClient<S extends RoomSchemaMap = RoomSchemaMap>
  implements IRoomClient<S> {
  private socket: PartySocket;
  private pending = new Map<string, Pending>();
  private subs = new Map<string, SubGroup>();
  private broadcastHandlers = new Map<string, Set<BroadcastHandler>>();
  private clientSchemas?: ClientSchemaMap;
  private serverSchemas?: Record<string, JsonSchema>;
  private localSchemaVersion?: number;
  private _serverSchemaVersion: number | null = null;

  private config: ConnectConfig;

  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;

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
    const { host, roomId, config, schemas } = opts;
    this.config = config;
    if (schemas) {
      this.clientSchemas = schemas.client;
      this.serverSchemas = schemas.server;
      this.localSchemaVersion = schemas.version;
    }

    this.sessionId = makeSessionId();

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = () => { this.readySettled = true; resolve(); };
      this.rejectReady = (err) => { this.readySettled = true; reject(err); };
    });

    // No more apiKey in URL — everything goes through the auth message.
    this.socket = new PartySocket({
      host,
      party: "room",
      room: `${config.apiKey}:${roomId}`,
    });

    this.socket.addEventListener("open", () => {
      this.log("ws", "open");
      this.sendAuth();
      // Reconnect: replay subs and pending in-flight ops.
      for (const group of this.subs.values()) {
        this.sendSubscribe(group.kind, group.target, group.serverIncludeSelf, group.serverBatchMs);
      }
      for (const { msg } of this.pending.values()) {
        this.sendRaw(msg);
      }
    });

    this.socket.addEventListener("close", () => {
      this.log("ws", "close");
      this._connectionId = null;
      this.setStatus(this.userClosed ? "closed" : "reconnecting");
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

  get status(): Status { return this._status; }
  get connectionId(): string | null { return this._connectionId; }
  get schemaVersion(): number | null { return this._serverSchemaVersion; }

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

  private sendAuth() {
    const authMsg: ClientMsg = {
      op: "auth",
      apiKey: this.config.apiKey,
      ...(this.config.userId !== undefined ? { userId: this.config.userId } : {}),
      ...(this.config.persistence !== undefined ? { persistence: this.config.persistence } : {}),
      ...(this.localSchemaVersion !== undefined ? { schemaVersion: this.localSchemaVersion } : {}),
    };
    this.sendRaw(authMsg);
  }

  /**
   * Called after `ready` arrives. If the consumer configured server schemas
   * with a version, and our version is newer than the server's, auto-register.
   * Schema conflicts (a racing tab beat us to it) are tolerated silently.
   */
  private async maybeRegisterServerSchemas() {
    if (!this.serverSchemas) return;
    if (this.localSchemaVersion === undefined) return;
    if (this._serverSchemaVersion === null) return;
    if (this.localSchemaVersion <= this._serverSchemaVersion) return;
    try {
      await this.registerSchemas(this.serverSchemas, {
        version: this.localSchemaVersion,
        replace: true,
      });
    } catch (err) {
      if (err instanceof RoomError && err.kind === "schemaConflict") {
        this.log("schemaConflict", err.schemaConflict);
        return;
      }
      console.error("[room-server] auto-register schemas failed:", err);
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async set<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts?: SetOptions
  ): Promise<SetResult> {
    await this.maybeValidateLocal(key, value);
    const msg: ClientMsg = { op: "set", key, value, ...opts };
    await this.op(msg, () => undefined);
    return { rev: -1 };
  }

  get<K extends string>(key: K): Promise<{ value: ResolveKey<S, K> | null; rev: number }> {
    return this.opWithRaw({ op: "get", key }, (msg) => {
      if (msg.op !== "result") throw new Error("Unexpected response to get");
      return { value: msg.value as ResolveKey<S, K> | null, rev: msg.rev };
    });
  }

  async delete(key: string): Promise<SetResult> {
    await this.op({ op: "delete", key }, () => undefined);
    return { rev: -1 };
  }

  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<ListResult> {
    const msg: ClientMsg = { op: "list", prefix, limit: opts?.limit, cursor: opts?.cursor };
    return this.opWithRaw(msg, (m) => {
      if (m.op !== "list_result") throw new Error("Unexpected response to list");
      const result: ListResult = { entries: m.entries };
      if (m.nextCursor !== undefined) result.nextCursor = m.nextCursor;
      if (m.truncated) result.truncated = true;
      return result;
    });
  }

  count(prefix: string): Promise<CountResult> {
    return this.opWithRaw({ op: "count", prefix }, (m) => {
      if (m.op !== "count_result") throw new Error("Unexpected response to count");
      const out: CountResult = { count: m.count };
      if (m.truncated) out.truncated = true;
      return out;
    });
  }

  // ── Atomic ops ──────────────────────────────────────────────────────────────

  increment(key: string, delta = 1): Promise<IncrementResult> {
    return this.opWithRaw({ op: "increment", key, delta }, (m) => {
      if (m.op !== "result") throw new Error("Unexpected response to increment");
      return { value: m.value as number, rev: m.rev };
    });
  }

  async setIf<K extends string>(
    key: K,
    value: ResolveKey<S, K>,
    opts: SetIfOptions & SetOptions
  ): Promise<SetIfResult> {
    if (opts.ifValue !== undefined && opts.ifRev !== undefined) {
      throw new RoomError("Pass either ifValue or ifRev, not both", { kind: "invalid" });
    }
    await this.maybeValidateLocal(key, value);
    return this.opWithRaw(
      {
        op: "set_if",
        key,
        value,
        ...(opts.ifValue !== undefined ? { ifValue: opts.ifValue } : {}),
        ...(opts.ifRev !== undefined ? { ifRev: opts.ifRev } : {}),
        ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
      },
      (m) => {
        if (m.op !== "set_if_result") throw new Error("Unexpected response to set_if");
        return { success: m.success, current: m.current, rev: m.rev };
      }
    );
  }

  async update<K extends string>(
    key: K,
    fn: (current: ResolveKey<S, K> | null) => ResolveKey<S, K>
  ): Promise<{ value: ResolveKey<S, K>; rev: number }> {
    for (let attempt = 0; attempt < UPDATE_MAX_RETRIES; attempt++) {
      const { value, rev } = await this.get(key);
      const next = fn(value);
      const result = await this.setIf(key, next, { ifRev: rev });
      if (result.success) return { value: next, rev: result.rev };
    }
    throw new RoomError(`update("${key}") failed after ${UPDATE_MAX_RETRIES} retries`, {
      kind: "transient",
    });
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

  touch(key: string, opts: { ttl: number }): Promise<void> {
    return this.op({ op: "touch", key, ttl: opts.ttl }, () => undefined);
  }

  deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    return this.opWithRaw({ op: "delete_prefix", prefix }, (m) => {
      if (m.op !== "delete_prefix_result") throw new Error("Unexpected response to delete_prefix");
      return { deleted: m.deleted };
    });
  }

  snapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    return this.opWithRaw(
      { op: "snapshot", keys: req.keys, prefixes: req.prefixes },
      (m) => {
        if (m.op !== "snapshot_result") throw new Error("Unexpected response to snapshot");
        const out: SnapshotResult = { keys: m.keys, prefixes: m.prefixes };
        if (m.truncated) out.truncated = true;
        return out;
      }
    );
  }

  async transact(ops: TransactOp[]): Promise<TransactResult> {
    // Validate any set/set_if ops locally if client schemas are configured.
    for (const op of ops) {
      if (op.op === "set" || op.op === "set_if") {
        await this.maybeValidateLocal(op.key, op.value);
      }
    }
    return this.opWithRaw({ op: "transact", ops }, (m) => {
      if (m.op !== "transact_result") throw new Error("Unexpected response to transact");
      const out: TransactResult = { success: m.success, results: m.results };
      if (m.error !== undefined) out.error = m.error;
      return out;
    });
  }

  registerSchemas(
    schemas: Record<string, JsonSchema>,
    opts?: { replace?: boolean; version?: number }
  ): Promise<{ count: number; schemaVersion: number }> {
    const msg: ClientMsg = { op: "register_schemas", schemas };
    if (opts?.replace) msg.replace = true;
    if (opts?.version !== undefined) msg.version = opts.version;
    return this.opWithRaw(msg, (m) => {
      if (m.op !== "schemas_registered") throw new Error("Unexpected response to register_schemas");
      this._serverSchemaVersion = m.schemaVersion;
      return { count: m.count, schemaVersion: m.schemaVersion };
    });
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

  subscribeKey<K extends string>(
    key: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
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
    const unsubscribe = this.addSubscription("key", key, handler as ChangeHandler, opts);
    try {
      const initial = await this.opWithRaw(
        {
          op: "subscribe_with_snapshot_key",
          key,
          ...(opts?.includeSelf ? { includeSelf: true } : {}),
          ...(opts?.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
        },
        (m) => {
          if (m.op !== "snapshot_initial" || m.kind !== "key") {
            throw new Error("Unexpected response to subscribe_with_snapshot_key");
          }
          return {
            value: m.value as ResolveKey<S, K> | null,
            rev: m.rev ?? 0,
          };
        }
      );
      return { initial, unsubscribe };
    } catch (err) {
      unsubscribe();
      throw err;
    }
  }

  async subscribeWithSnapshotPrefix<K extends string>(
    prefix: K,
    handler: (e: TypedChangeEvent<ResolveKey<S, K>>) => void,
    opts?: SubscribeOptions
  ): Promise<SubscribeWithSnapshotPrefixResult> {
    if (prefix !== "" && !prefix.endsWith("/")) {
      throw new Error(
        `room-server: subscribeWithSnapshotPrefix("${prefix}") requires a trailing "/" or empty string.`
      );
    }
    const unsubscribe = this.addSubscription("prefix", prefix, handler as ChangeHandler, opts);
    try {
      const initial = await this.opWithRaw(
        {
          op: "subscribe_with_snapshot_prefix",
          prefix,
          ...(opts?.includeSelf ? { includeSelf: true } : {}),
          ...(opts?.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
        },
        (m) => {
          if (m.op !== "snapshot_initial" || m.kind !== "prefix") {
            throw new Error("Unexpected response to subscribe_with_snapshot_prefix");
          }
          const out: InitialPrefixSnapshot = { entries: m.entries ?? {} };
          if (m.truncated) out.truncated = true;
          return out;
        }
      );
      return { initial, unsubscribe };
    } catch (err) {
      unsubscribe();
      throw err;
    }
  }

  private addSubscription(
    kind: "key" | "prefix",
    target: string,
    handler: ChangeHandler,
    opts?: SubscribeOptions
  ): UnsubscribeFn {
    const includeSelf = opts?.includeSelf === true;
    const batchMs = opts?.batchMs;
    const subKey = `${kind}:${target}`;
    let group = this.subs.get(subKey);

    if (!group) {
      group = {
        kind,
        target,
        handlers: new Set(),
        serverIncludeSelf: includeSelf,
        ...(batchMs !== undefined ? { serverBatchMs: batchMs } : {}),
      };
      this.subs.set(subKey, group);
      this.sendSubscribe(kind, target, includeSelf, batchMs);
    } else {
      // Recompute desired server-side flags as OR-of-includeSelf and MIN-of-batchMs.
      const desiredIncludeSelf = includeSelf || group.serverIncludeSelf;
      const desiredBatchMs = mergeBatchMs(group.serverBatchMs, batchMs);
      const changed =
        desiredIncludeSelf !== group.serverIncludeSelf ||
        desiredBatchMs !== group.serverBatchMs;
      if (changed) {
        group.serverIncludeSelf = desiredIncludeSelf;
        if (desiredBatchMs === undefined) delete group.serverBatchMs;
        else group.serverBatchMs = desiredBatchMs;
        this.sendSubscribe(kind, target, desiredIncludeSelf, desiredBatchMs);
      }
    }

    const entry: HandlerEntry = {
      handler,
      includeSelf,
      ...(batchMs !== undefined ? { batchMs } : {}),
    };
    group.handlers.add(entry);

    return () => {
      const g = this.subs.get(subKey);
      if (!g) return;
      g.handlers.delete(entry);
      if (g.handlers.size === 0) {
        this.subs.delete(subKey);
        this.sendUnsubscribe(kind, target);
      } else {
        const desiredSelf = anyWantsSelf(g);
        const desiredBatch = minBatchMs(g);
        const changed =
          desiredSelf !== g.serverIncludeSelf ||
          desiredBatch !== g.serverBatchMs;
        if (changed) {
          g.serverIncludeSelf = desiredSelf;
          if (desiredBatch === undefined) delete g.serverBatchMs;
          else g.serverBatchMs = desiredBatch;
          this.sendSubscribe(kind, target, desiredSelf, desiredBatch);
        }
      }
    };
  }

  private sendSubscribe(
    kind: "key" | "prefix",
    target: string,
    includeSelf: boolean,
    batchMs?: number
  ) {
    const base = { includeSelf, ...(batchMs !== undefined ? { batchMs } : {}) };
    const msg: ClientMsg =
      kind === "key"
        ? { op: "subscribe_key", key: target, ...base }
        : { op: "subscribe_prefix", prefix: target, ...base };
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
      reject(new RoomError("Disconnected", { kind: "transient" }));
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

  // Variant of `op` where the transformer receives the raw server message —
  // needed for results that carry richer payloads (rev, list metadata, etc.).
  private opWithRaw<T>(baseMsg: ClientMsg, transform: (m: ServerMsg) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = this.uid();
      const msg: ClientMsg = { ...baseMsg, requestId } as ClientMsg;
      this.pending.set(requestId, {
        resolve: (raw) => {
          try {
            resolve(transform(raw as ServerMsg));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
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

  private async maybeValidateLocal(key: string, value: unknown): Promise<void> {
    if (!this.clientSchemas) return;
    const schema = resolveClientSchema(key, this.clientSchemas);
    if (!schema) return;
    const result = await schema["~standard"].validate(value);
    if ("issues" in result) {
      const errors: ValidationErrorDetail[] = result.issues.map((i) => ({
        path: pathSegmentsToString(i.path),
        message: i.message,
      }));
      throw new RoomError(`Validation failed for "${key}"`, {
        kind: "validation",
        validationError: { key, schemaPattern: "<client-side>", errors },
      });
    }
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.op) {
      case "ready":
        this._connectionId = msg.connectionId;
        this._serverSchemaVersion = msg.schemaVersion;
        this.setStatus("ready");
        // Resolve `ready()` only after auto-schema-registration has settled, so
        // `client.schemaVersion` reflects the post-upload state when consumers
        // probe it directly after `await room.ready()`. Errors don't block —
        // the `ready` message itself already arrived.
        void this.maybeRegisterServerSchemas().finally(() => {
          if (!this.readySettled) this.resolveReady();
        });
        break;

      case "ack": {
        if (msg.requestId) {
          this.resolveRaw(msg.requestId, msg);
        }
        break;
      }

      case "result":
      case "list_result":
      case "count_result":
      case "set_if_result":
      case "delete_prefix_result":
      case "snapshot_result":
      case "transact_result":
      case "snapshot_initial":
      case "schemas_registered": {
        if (msg.requestId) this.resolveRaw(msg.requestId, msg);
        break;
      }

      case "change": {
        this.dispatchChange(msg);
        break;
      }

      case "change_batch": {
        for (const c of msg.changes) this.dispatchChange(c);
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
        const kind: RoomErrorKind = msg.kind ?? inferKind(msg);
        const err = new RoomError(msg.message, {
          kind,
          ...(msg.rateLimit ? { rateLimit: msg.rateLimit } : {}),
          ...(msg.validationError ? { validationError: msg.validationError } : {}),
          ...(msg.schemaConflict ? { schemaConflict: msg.schemaConflict } : {}),
        });
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.reject(err);
          this.pending.delete(msg.requestId);
        } else {
          console.error(`[room-server] ${msg.message}`, msg.rateLimit ?? "");
        }
        break;
      }
    }
  }

  private resolveRaw(requestId: string, msg: ServerMsg) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.resolve(msg);
  }

  private dispatchChange(msg: Extract<ServerMsg, { op: "change" }>) {
    const isSelf =
      this._connectionId !== null && msg.originConnId === this._connectionId;

    const event: ChangeEvent =
      msg.type === "set"
        ? { type: "set", key: msg.key, value: msg.value, rev: msg.rev, originConnId: msg.originConnId }
        : {
            type: "delete",
            key: msg.key,
            priorValue: msg.priorValue ?? null,
            rev: msg.rev,
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
        try { entry.handler(event); } catch (err) {
          console.error("[room-server] change handler threw", err);
        }
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function anyWantsSelf(group: SubGroup): boolean {
  for (const e of group.handlers) if (e.includeSelf) return true;
  return false;
}

function minBatchMs(group: SubGroup): number | undefined {
  let min: number | undefined;
  for (const e of group.handlers) {
    if (e.batchMs === undefined) return undefined; // any immediate sub trumps batched
    if (min === undefined || e.batchMs < min) min = e.batchMs;
  }
  return min;
}

function mergeBatchMs(
  current: number | undefined,
  incoming: number | undefined
): number | undefined {
  if (current === undefined || incoming === undefined) return undefined;
  return Math.min(current, incoming);
}

function makeSessionId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function resolveClientSchema(
  key: string,
  schemas: ClientSchemaMap
): StandardSchemaLike | null {
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

function pathSegmentsToString(
  path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined
): string {
  if (!path || path.length === 0) return "";
  let out = "";
  for (const seg of path) {
    const k = typeof seg === "object" && seg !== null && "key" in seg ? seg.key : seg;
    if (typeof k === "number") out += `[${k}]`;
    else                      out += `.${String(k)}`;
  }
  return out;
}

/**
 * Fallback when the server omits `kind` (older server). Infers from the
 * presence of optional fields and a small allowlist of known messages.
 */
function inferKind(msg: {
  message: string;
  rateLimit?: unknown;
  validationError?: unknown;
  schemaConflict?: unknown;
}): RoomErrorKind {
  if (msg.validationError) return "validation";
  if (msg.rateLimit) return "rateLimit";
  if (msg.schemaConflict) return "schemaConflict";
  const m = msg.message.toLowerCase();
  if (m.includes("auth")) return "auth";
  if (m.includes("rate limit") || m.includes("connection limit")) return "rateLimit";
  if (
    m.includes("reserved key") ||
    m.includes("must be") ||
    m.includes("invalid") ||
    m.includes("unknown op") ||
    m.includes("either if")
  ) {
    return "invalid";
  }
  return "unknown";
}
