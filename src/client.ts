import PartySocket from "partysocket";
import type {
  AlarmAction,
  ClientMsg,
  ConnectConfig,
  ListResult,
  PersistenceLevel,
  ServerMsg,
} from "./types.js";

export type { ConnectConfig, ListResult, PersistenceLevel };

type ChangeHandler = (key: string, value: unknown, deleted: boolean) => void;
type BroadcastHandler = (data: unknown) => void;
type UnsubscribeFn = () => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  msg: ClientMsg; // kept so we can replay on reconnect
}

export interface SetOptions {
  ttl?: number; // seconds
}

export interface SetIfResult {
  success: boolean;
  current: unknown;
}

export interface RoomClientOptions {
  host: string;
  roomId: string;
  config: ConnectConfig;
}

export class RoomClient {
  private socket: PartySocket;
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, Set<ChangeHandler>>();
  private broadcastHandlers = new Map<string, Set<BroadcastHandler>>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private isFirstOpen = true;

  constructor(opts: RoomClientOptions) {
    const { host, roomId, config } = opts;
    const params = new URLSearchParams({
      apiKey: config.apiKey,
      persistence: config.persistence ?? "storage",
    });

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.socket = new PartySocket({
      host,
      party: "room",
      room: `${config.apiKey}:${roomId}`,
      query: Object.fromEntries(params),
    });

    this.socket.addEventListener("open", () => {
      if (this.isFirstOpen) {
        this.isFirstOpen = false;
        return;
      }
      // Reconnect: restore subscriptions and replay in-flight ops.
      for (const prefix of this.subscriptions.keys()) {
        this.socket.send(JSON.stringify({ op: "subscribe", prefix }));
      }
      for (const { msg } of this.pending.values()) {
        this.socket.send(JSON.stringify(msg));
      }
    });

    this.socket.addEventListener("message", (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string) as ServerMsg;
      this.onMessage(msg);
    });
  }

  // ── Handshake ───────────────────────────────────────────────────────────────

  ready(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("room-server: ready() timed out")),
        timeoutMs
      );
      this.readyPromise.then(() => { clearTimeout(timer); resolve(); }, reject);
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

  subscribe(prefix: string, handler: ChangeHandler): UnsubscribeFn {
    if (!this.subscriptions.has(prefix)) {
      this.subscriptions.set(prefix, new Set());
      this.socket.send(JSON.stringify({ op: "subscribe", prefix }));
    }
    this.subscriptions.get(prefix)!.add(handler);

    return () => {
      const handlers = this.subscriptions.get(prefix);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscriptions.delete(prefix);
        this.socket.send(JSON.stringify({ op: "unsubscribe", prefix }));
      }
    };
  }

  // ── Broadcast ───────────────────────────────────────────────────────────────

  broadcast(channel: string, data: unknown): void {
    this.socket.send(JSON.stringify({ op: "broadcast", channel, data }));
  }

  onBroadcast(channel: string, handler: BroadcastHandler): UnsubscribeFn {
    if (!this.broadcastHandlers.has(channel)) {
      this.broadcastHandlers.set(channel, new Set());
    }
    this.broadcastHandlers.get(channel)!.add(handler);
    return () => this.broadcastHandlers.get(channel)?.delete(handler);
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  disconnect() {
    for (const { reject } of this.pending.values()) {
      reject(new Error("Disconnected"));
    }
    this.pending.clear();
    this.socket.close();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  // Sends a request message and returns a promise that resolves/rejects when
  // the server responds. `transform` maps the raw resolved value to the return type.
  private op<T>(baseMsg: ClientMsg, transform: (v: unknown) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = uid();
      const msg: ClientMsg = { ...baseMsg, requestId } as ClientMsg;
      this.pending.set(requestId, {
        resolve: (v) => resolve(transform(v)),
        reject,
        msg,
      });
      this.socket.send(JSON.stringify(msg));
    });
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.op) {
      case "ready":
        this.resolveReady();
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
          });
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "set_if_result": {
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.resolve({
            success: msg.success,
            current: msg.current,
          });
          this.pending.delete(msg.requestId);
        }
        break;
      }

      case "change": {
        for (const [prefix, handlers] of this.subscriptions) {
          if (msg.key.startsWith(prefix)) {
            for (const h of handlers) h(msg.key, msg.value, msg.deleted ?? false);
          }
        }
        break;
      }

      case "broadcast_recv": {
        const handlers = this.broadcastHandlers.get(msg.channel);
        if (handlers) for (const h of handlers) h(msg.data);
        break;
      }

      case "error": {
        console.error(`[room-server] error (req=${msg.requestId ?? "?"})`, msg.message);
        if (msg.requestId) {
          this.pending.get(msg.requestId)?.reject(new Error(msg.message));
          this.pending.delete(msg.requestId);
        }
        break;
      }
    }
  }
}

function uid() {
  return Math.random().toString(36).slice(2);
}
