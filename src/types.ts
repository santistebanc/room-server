export type PersistenceLevel = "ephemeral" | "durable";

export interface ConnectConfig {
  apiKey: string;
  /**
   * Optional stable identity for the connecting user. When provided, it is
   * stored alongside the connection's `presence/{connectionId}` entry so
   * subscribers can derive user-level presence.
   */
  userId?: string;
  persistence?: PersistenceLevel;
}

// ── Client → Server messages ──────────────────────────────────────────────────

export interface AuthMsg {
  op: "auth";
  apiKey: string;
  userId?: string;
  persistence?: PersistenceLevel;
  requestId?: string;
}

export interface SetMsg {
  op: "set";
  key: string;
  value: unknown;
  ttl?: number; // seconds until expiry
  requestId?: string;
}

export interface GetMsg {
  op: "get";
  key: string;
  requestId?: string;
}

export interface DeleteMsg {
  op: "delete";
  key: string;
  requestId?: string;
}

export interface ListMsg {
  op: "list";
  prefix: string;
  limit?: number;
  cursor?: string;
  requestId?: string;
}

export interface CountMsg {
  op: "count";
  prefix: string;
  requestId?: string;
}

export interface IncrementMsg {
  op: "increment";
  key: string;
  delta?: number; // default 1
  requestId?: string;
}

export interface SetIfMsg {
  op: "set_if";
  key: string;
  value: unknown;
  /** Set only if current value deeply equals this. Mutually exclusive with `ifRev`. */
  ifValue?: unknown;
  /**
   * Set only if the current revision matches. `0` matches a key that has never
   * existed. Mutually exclusive with `ifValue`.
   */
  ifRev?: number;
  requestId?: string;
}

export interface TouchMsg {
  op: "touch";
  key: string;
  ttl: number;
  requestId?: string;
}

export interface DeletePrefixMsg {
  op: "delete_prefix";
  prefix: string;
  requestId?: string;
}

export interface SnapshotMsg {
  op: "snapshot";
  keys?: string[];
  prefixes?: string[];
  requestId?: string;
}

/**
 * Atomic multi-op write. All `ops` are applied together inside the same
 * transaction; any failure (validation, CAS mismatch, reserved key) rolls
 * back the entire batch.
 */
export interface TransactMsg {
  op: "transact";
  ops: TransactOp[];
  requestId?: string;
}

export type TransactOp =
  | { op: "set"; key: string; value: unknown; ttl?: number }
  | { op: "delete"; key: string }
  | { op: "increment"; key: string; delta?: number }
  | {
      op: "set_if";
      key: string;
      value: unknown;
      ifValue?: unknown;
      ifRev?: number;
    };

export interface SubscribeKeyMsg {
  op: "subscribe_key";
  key: string;
  includeSelf?: boolean;
  /** If set, server batches change events for this sub and emits a `change_batch` every N ms. */
  batchMs?: number;
}

export interface SubscribePrefixMsg {
  op: "subscribe_prefix";
  prefix: string;
  includeSelf?: boolean;
  batchMs?: number;
}

/**
 * Atomic subscribe + initial-state delivery. Server sends a `snapshot_initial`
 * message before any further `change` events for this subscription, eliminating
 * the snapshot-then-subscribe race.
 */
export interface SubscribeWithSnapshotKeyMsg {
  op: "subscribe_with_snapshot_key";
  key: string;
  includeSelf?: boolean;
  batchMs?: number;
  requestId?: string;
}

export interface SubscribeWithSnapshotPrefixMsg {
  op: "subscribe_with_snapshot_prefix";
  prefix: string;
  includeSelf?: boolean;
  batchMs?: number;
  requestId?: string;
}

export interface UnsubscribeKeyMsg {
  op: "unsubscribe_key";
  key: string;
}

export interface UnsubscribePrefixMsg {
  op: "unsubscribe_prefix";
  prefix: string;
}

export interface BroadcastMsg {
  op: "broadcast";
  channel: string;
  data: unknown;
}

/**
 * Register one or more JSON Schemas against key patterns. Schemas persist in
 * the room. Subsequent writes (set, set_if, transact) whose key matches a
 * pattern are validated; validation failures return an error with a
 * `validationError` field.
 *
 * Pattern syntax: a key prefix (e.g. `"users/"`) matches any key starting with
 * the prefix. Use `"*"` to match every key. Use an exact key (no trailing `/`)
 * to match only that key. The most-specific (longest) match wins.
 */
export interface RegisterSchemasMsg {
  op: "register_schemas";
  schemas: Record<string, JsonSchema>;
  /** If true, replaces existing schema registry; otherwise merges. Default: false. */
  replace?: boolean;
  requestId?: string;
}

// Actions the server can execute autonomously when an alarm fires.
export type AlarmAction =
  | { op: "set"; key: string; value: unknown }
  | { op: "delete"; key: string }
  | { op: "increment"; key: string; delta?: number }
  | { op: "broadcast"; channel: string; data: unknown };

export interface ScheduleAlarmMsg {
  op: "schedule_alarm";
  delay: number;
  action?: AlarmAction;
  requestId?: string;
}

export interface CancelAlarmMsg {
  op: "cancel_alarm";
  requestId?: string;
}

export interface ScheduleRecurringMsg {
  op: "schedule_recurring";
  interval: number;
  action: AlarmAction;
  requestId?: string;
}

export interface CancelRecurringMsg {
  op: "cancel_recurring";
  requestId?: string;
}

export type ClientMsg =
  | AuthMsg
  | SetMsg
  | GetMsg
  | DeleteMsg
  | ListMsg
  | CountMsg
  | IncrementMsg
  | SetIfMsg
  | TouchMsg
  | DeletePrefixMsg
  | SnapshotMsg
  | TransactMsg
  | SubscribeKeyMsg
  | SubscribePrefixMsg
  | SubscribeWithSnapshotKeyMsg
  | SubscribeWithSnapshotPrefixMsg
  | UnsubscribeKeyMsg
  | UnsubscribePrefixMsg
  | BroadcastMsg
  | RegisterSchemasMsg
  | ScheduleAlarmMsg
  | CancelAlarmMsg
  | ScheduleRecurringMsg
  | CancelRecurringMsg;

// ── Server → Client messages ──────────────────────────────────────────────────

export interface ReadyMsg {
  op: "ready";
  persistence: PersistenceLevel;
  appId: string;
  roomId: string;
  connectionId: string;
}

export interface ResultMsg {
  op: "result";
  requestId?: string;
  key: string;
  value: unknown;
  /** Current revision of the key. `0` means the key has never existed. */
  rev: number;
}

export interface ListResultMsg {
  op: "list_result";
  requestId?: string;
  prefix: string;
  entries: Record<string, unknown>;
  nextCursor?: string;
  /** True when a soft cap was hit and more entries exist beyond `nextCursor`. */
  truncated?: boolean;
}

export interface CountResultMsg {
  op: "count_result";
  requestId?: string;
  prefix: string;
  count: number;
  /** True if the count was capped (very large prefixes). */
  truncated?: boolean;
}

export interface SetIfResultMsg {
  op: "set_if_result";
  requestId?: string;
  success: boolean;
  current: unknown;
  /** Current revision after the operation. */
  rev: number;
}

export interface DeletePrefixResultMsg {
  op: "delete_prefix_result";
  requestId?: string;
  deleted: number;
}

export interface SnapshotResultMsg {
  op: "snapshot_result";
  requestId?: string;
  keys: Record<string, unknown>;
  prefixes: Record<string, Record<string, unknown>>;
  truncated?: boolean;
}

/**
 * Per-op results for a transact. The array is in the same order as the
 * input ops. On rollback, `success` at top level is false and individual
 * results may be partially populated up to the failure point.
 */
export interface TransactResultMsg {
  op: "transact_result";
  requestId?: string;
  success: boolean;
  results: TransactOpResult[];
  error?: string;
}

export type TransactOpResult =
  | { op: "set" | "delete" | "increment"; key: string; rev: number; value?: unknown }
  | { op: "set_if"; key: string; success: boolean; current: unknown; rev: number };

/**
 * Initial-state delivery for a subscribe_with_snapshot_* request. Sent once,
 * before any change events for the same subscription. The shape mirrors the
 * subscription kind: a single key carries `value`+`rev`; a prefix carries
 * an `entries` map.
 */
export interface SnapshotInitialMsg {
  op: "snapshot_initial";
  requestId?: string;
  kind: "key" | "prefix";
  target: string;
  /** For kind="key" only. */
  value?: unknown;
  rev?: number;
  /** For kind="prefix" only — flat map of all matching keys at subscribe time. */
  entries?: Record<string, unknown>;
  truncated?: boolean;
}

export type ChangeMsg =
  | {
      op: "change";
      type: "set";
      key: string;
      value: unknown;
      rev: number;
      originConnId: string | null;
    }
  | {
      op: "change";
      type: "delete";
      key: string;
      rev: number;
      originConnId: string | null;
    };

/**
 * Batched change delivery for subs that opted into `batchMs`. Server collects
 * change events that match the same sub and flushes them on an interval to
 * smooth bursty fanout for slow consumers.
 */
export interface ChangeBatchMsg {
  op: "change_batch";
  changes: ChangeMsg[];
}

export interface BroadcastRecvMsg {
  op: "broadcast_recv";
  channel: string;
  data: unknown;
}

export interface SchemasRegisteredMsg {
  op: "schemas_registered";
  requestId?: string;
  count: number;
}

export interface RateLimitInfo {
  limit: number;
  window: number;
  remaining: number;
  resetAt: number;
}

export interface ValidationErrorDetail {
  /** Dotted path inside the value, e.g. `".name"`, `".items[2].id"`, or `""` for the root. */
  path: string;
  message: string;
}

export interface ErrorMsg {
  op: "error";
  requestId?: string;
  message: string;
  rateLimit?: RateLimitInfo;
  /** Populated when the error was caused by schema validation. */
  validationError?: {
    key: string;
    schemaPattern: string;
    errors: ValidationErrorDetail[];
  };
}

export interface RateLimitWarningMsg {
  op: "rate_limit_warning";
  remaining: number;
  resetAt: number;
}

export interface AckMsg {
  op: "ack";
  requestId?: string;
}

export type ServerMsg =
  | ReadyMsg
  | ResultMsg
  | ListResultMsg
  | CountResultMsg
  | SetIfResultMsg
  | DeletePrefixResultMsg
  | SnapshotResultMsg
  | TransactResultMsg
  | SnapshotInitialMsg
  | ChangeMsg
  | ChangeBatchMsg
  | BroadcastRecvMsg
  | SchemasRegisteredMsg
  | ErrorMsg
  | RateLimitWarningMsg
  | AckMsg;

// ── Misc ──────────────────────────────────────────────────────────────────────

export interface ListResult {
  entries: Record<string, unknown>;
  nextCursor?: string;
  truncated?: boolean;
}

export interface SnapshotResult {
  keys: Record<string, unknown>;
  prefixes: Record<string, Record<string, unknown>>;
  truncated?: boolean;
}

export interface CountResult {
  count: number;
  truncated?: boolean;
}

export interface PresenceInfo {
  connectedAt: number;
  userId?: string;
  [key: string]: unknown;
}

// ── JSON Schema (subset) ─────────────────────────────────────────────────────
//
// A pragmatic subset of JSON Schema Draft 7 sufficient for validating room
// values. Bundled validator is ~150 lines. For more advanced use cases,
// consumers can validate client-side with their own validator and trust the
// server's schema as a coarse boundary check.

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: unknown[];
  const?: unknown;

  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;

  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;

  // array
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;

  // composition
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];

  // metadata (ignored by validator)
  description?: string;
  title?: string;
  default?: unknown;
}

// ── Env ───────────────────────────────────────────────────────────────────────

export interface Env {
  ALLOWED_KEYS?: string;
  RATE_LIMIT_OPS?: string;
  RATE_LIMIT_WINDOW?: string;
  MAX_CONNECTIONS?: string;
  /** Time in seconds an unauthenticated connection has to send the auth frame before being closed. Default: 10. */
  AUTH_TIMEOUT?: string;
}
