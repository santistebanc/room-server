export type PersistenceLevel = "memory" | "storage";

export interface ConnectConfig {
  apiKey: string;
  persistence?: PersistenceLevel;
}

// ── Client → Server messages ──────────────────────────────────────────────────

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
  ifValue: unknown; // only set if current value equals this
  requestId?: string;
}

export interface TouchMsg {
  op: "touch";
  key: string;
  ttl: number; // seconds from now; replaces any existing TTL on the key
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

export interface SubscribeKeyMsg {
  op: "subscribe_key";
  key: string;
  includeSelf?: boolean;
}

export interface SubscribePrefixMsg {
  op: "subscribe_prefix";
  prefix: string;
  includeSelf?: boolean;
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

// Actions the server can execute autonomously when an alarm fires.
export type AlarmAction =
  | { op: "set"; key: string; value: unknown }
  | { op: "delete"; key: string }
  | { op: "increment"; key: string; delta?: number }
  | { op: "broadcast"; channel: string; data: unknown };

export interface ScheduleAlarmMsg {
  op: "schedule_alarm";
  delay: number; // seconds from now
  action?: AlarmAction; // optional — if omitted the alarm fires silently
  requestId?: string;
}

export interface CancelAlarmMsg {
  op: "cancel_alarm";
  requestId?: string;
}

export interface ScheduleRecurringMsg {
  op: "schedule_recurring";
  interval: number; // seconds between fires
  action: AlarmAction;
  requestId?: string;
}

export interface CancelRecurringMsg {
  op: "cancel_recurring";
  requestId?: string;
}

export type ClientMsg =
  | SetMsg
  | GetMsg
  | DeleteMsg
  | ListMsg
  | IncrementMsg
  | SetIfMsg
  | TouchMsg
  | DeletePrefixMsg
  | SnapshotMsg
  | SubscribeKeyMsg
  | SubscribePrefixMsg
  | UnsubscribeKeyMsg
  | UnsubscribePrefixMsg
  | BroadcastMsg
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
}

export interface ListResultMsg {
  op: "list_result";
  requestId?: string;
  prefix: string;
  entries: Record<string, unknown>;
  nextCursor?: string;
}

export interface SetIfResultMsg {
  op: "set_if_result";
  requestId?: string;
  success: boolean;
  current: unknown;
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
}

export type ChangeMsg =
  | {
      op: "change";
      type: "set";
      key: string;
      value: unknown;
      // Connection that originated the write. `null` for HTTP, alarm-driven,
      // and TTL-sweep changes.
      originConnId: string | null;
    }
  | {
      op: "change";
      type: "delete";
      key: string;
      originConnId: string | null;
    };

export interface BroadcastRecvMsg {
  op: "broadcast_recv";
  channel: string;
  data: unknown;
}

export interface RateLimitInfo {
  limit: number;       // max ops per window
  window: number;      // window size in milliseconds
  remaining: number;   // ops left in current window
  resetAt: number;     // epoch ms when the current window resets
}

export interface ErrorMsg {
  op: "error";
  requestId?: string;
  message: string;
  rateLimit?: RateLimitInfo;
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
  | SetIfResultMsg
  | DeletePrefixResultMsg
  | SnapshotResultMsg
  | ChangeMsg
  | BroadcastRecvMsg
  | ErrorMsg
  | RateLimitWarningMsg
  | AckMsg;

// ── Misc ──────────────────────────────────────────────────────────────────────

export interface ListResult {
  entries: Record<string, unknown>;
  nextCursor?: string;
}

export interface SnapshotResult {
  keys: Record<string, unknown>;
  prefixes: Record<string, Record<string, unknown>>;
}

export interface PresenceInfo {
  connectedAt: number;
  [key: string]: unknown;
}

// ── Env ───────────────────────────────────────────────────────────────────────

export interface Env {
  // Comma-separated valid API keys. If absent, open mode: any key accepted.
  ALLOWED_KEYS?: string;
  // Max ops per window per connection (WebSocket) or per apiKey (HTTP). Default: 100.
  RATE_LIMIT_OPS?: string;
  // Window size in seconds. Default: 10.
  RATE_LIMIT_WINDOW?: string;
  // Max simultaneous WebSocket connections per room. Default: 100.
  MAX_CONNECTIONS?: string;
}
