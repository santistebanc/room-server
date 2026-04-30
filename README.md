# room-server

A generic PartyKit backend. Any app can connect and get real-time key-value storage, subscriptions, atomic ops, presence, broadcast, and scheduled jobs — with no server code to write.

> **Breaking changes since the previous release.** The subscribe API was redesigned, the `change` event shape is now a discriminated union, and the wire protocol gained `originConnId`, new ops (`touch`, `delete_prefix`, `snapshot`), and rate-limit telemetry. See "Migration notes" at the bottom for details.

## Deploy the server

**1. Clone and install**

```bash
git clone <this-repo>
cd room-server
npm install
```

**2. (Optional) Set an allowlist of API keys**

If you skip this, the server runs in open mode — any key is accepted and used as the app namespace. Fine for development; set keys for production.

```bash
npx partykit env add ALLOWED_KEYS
# enter a comma-separated list: key-app1,key-app2,key-app3
```

**3. Deploy**

```bash
npm run deploy
```

PartyKit will print your server URL:

```
https://room-server.<your-username>.partykit.dev
```

---

## Connect from your app

### Install

```bash
npm install github:santistebanc/room-server
```

This installs the client SDK directly from GitHub. The `prepare` script compiles TypeScript automatically on install — no extra steps needed.

### Connect

```ts
import { RoomClient } from "room-server/client";
import type { ConnectConfig } from "room-server/types";

const room = new RoomClient({
  host: "room-server.<your-username>.partykit.dev",
  roomId: "my-room",
  config: {
    apiKey: "key-app1",       // must be in ALLOWED_KEYS, or any string in open mode
    persistence: "storage",   // "storage" (default) | "memory"
  },
});

await room.ready();           // resolves once first server handshake completes
```

Each unique `roomId` is a fully isolated namespace. Different `apiKey` values are always isolated from each other — two apps cannot access each other's rooms.

The client automatically reconnects on disconnect and restores all subscriptions and in-flight operations. Use `room.status` and `room.on("status", ...)` to observe the connection lifecycle (see below).

---

## API

### `room.set(key, value, opts?)` → `Promise<void>`

Store any JSON-serialisable value. Optionally set a TTL in seconds after which the key auto-expires.

```ts
await room.set("users/alice", { name: "Alice", online: true });
await room.set("session/abc", { userId: 1 }, { ttl: 3600 }); // expires in 1 hour
```

### `room.get(key)` → `Promise<unknown>`

```ts
const user = await room.get("users/alice");
```

Returns `null` if the key does not exist or has expired.

### `room.delete(key)` → `Promise<void>`

```ts
await room.delete("users/alice");
```

### `room.list(prefix, opts?)` → `Promise<{ entries, nextCursor? }>`

Get all keys that start with `prefix`. Supports pagination.

```ts
// Get all users
const { entries } = await room.list("users/");

// Paginate — 10 at a time
const page1 = await room.list("users/", { limit: 10 });
const page2 = await room.list("users/", { limit: 10, cursor: page1.nextCursor });
```

Pass `""` as prefix to list everything in the room.

### `room.increment(key, delta?)` → `Promise<number>`

Atomically increment a numeric key. Starts from `0` if the key does not exist. `delta` defaults to `1`.

```ts
const views = await room.increment("stats/views");      // 1
const views = await room.increment("stats/views", 5);   // 6
const views = await room.increment("stats/views", -1);  // 5
```

### `room.setIf(key, value, ifValue)` → `Promise<{ success, current }>`

Compare-and-swap. Sets `value` only if the current stored value equals `ifValue`. Returns whether the swap succeeded and the current value.

```ts
const { success, current } = await room.setIf("lock", "mine", null);
// success = true if key was null (unset), false if already held by someone else
```

### `room.touch(key, { ttl })` → `Promise<void>`

Refresh the TTL on an existing key without rewriting its value. Errors if the key does not exist or is `null`.

```ts
await room.touch("session/abc", { ttl: 3600 }); // reset to 1h from now
```

### `room.deletePrefix(prefix)` → `Promise<{ deleted: number }>`

Atomically delete every key under a prefix. Subscribers receive one `delete` event per key.

```ts
const { deleted } = await room.deletePrefix("votes/");
```

The empty prefix and reserved prefixes (`__rs/`, `presence/`) are rejected.

### `room.snapshot({ keys?, prefixes? })` → `Promise<{ keys, prefixes }>`

Read several keys and/or prefixes in a single round trip. Useful for hydrating UI on first load without N separate fetches.

```ts
const snap = await room.snapshot({
  keys: ["meta", "settings"],
  prefixes: ["users/", "votes/"],
});
// snap.keys.meta, snap.keys.settings
// snap.prefixes["users/"]  — Record<string, unknown>
// snap.prefixes["votes/"]
```

Each prefix is bounded at 10,000 entries. For larger sets, use `list()` with pagination.

### `room.subscribeKey(key, handler, opts?)` → `unsubscribe()`

Receive real-time changes for a single exact key.

```ts
const unsub = room.subscribeKey("meta", (event) => {
  if (event.type === "delete") clearMeta();
  else applyMeta(event.value);
});
```

### `room.subscribePrefix(prefix, handler, opts?)` → `unsubscribe()`

Receive real-time changes for any key starting with `prefix`. The prefix must end with `"/"` or be the empty string (which matches everything).

```ts
room.subscribePrefix("users/", (event) => {
  if (event.type === "delete") removeUser(event.key);
  else                         updateUser(event.key, event.value);
});
```

Both subscribe methods accept `{ includeSelf: true }` to also receive changes originated by this client. By default, the subscribing client does **not** receive its own writes.

```ts
room.subscribePrefix("votes/", handler, { includeSelf: true });
```

### `ChangeEvent`

```ts
type ChangeEvent =
  | { type: "set";    key: string; value: unknown; originConnId: string | null }
  | { type: "delete"; key: string;                  originConnId: string | null };
```

`originConnId` identifies the connection that originated the change. It is `null` for HTTP, alarm-driven, and TTL-sweep changes. Compare with `room.connectionId` to detect self-writes.

### Presence

The server automatically manages `presence/{connectionId}` entries on connect and disconnect. Subscribe to `"presence/"` to track who is online.

```ts
const snap = await room.snapshot({ prefixes: ["presence/"] });
const online = new Map(Object.entries(snap.prefixes["presence/"]));

room.subscribePrefix("presence/", (event) => {
  if (event.type === "delete") online.delete(event.key);
  else                         online.set(event.key, event.value);
});
```

### `room.broadcast(channel, data)`

Send an arbitrary payload to all connections in the room.

```ts
room.broadcast("chat", { from: "alice", text: "hello" });
```

### `room.onBroadcast(channel, handler)` → `unsubscribe()`

```ts
const unsub = room.onBroadcast("chat", (data) => {
  console.log(data);
});
```

### `room.disconnect()`

Close the WebSocket connection immediately. Pending operations are rejected.

### `room.flushAndDisconnect(timeoutMs?)` → `Promise<void>`

Wait for in-flight operations to settle (or the timeout, default 5s) before closing. Useful in `beforeunload` handlers to make sure the user's last write actually lands.

```ts
window.addEventListener("beforeunload", () => {
  room.flushAndDisconnect();
});
```

---

## Connection lifecycle

`room.status` is one of `"connecting" | "ready" | "reconnecting" | "closed"`.

```ts
room.status                 // current state
room.connectionId           // string once "ready", null otherwise

const off = room.on("status", (s) => {
  document.getElementById("badge")!.textContent = s;
});
off(); // stop listening
```

Subscriptions and in-flight ops are automatically restored when the socket reconnects. While reconnecting, new ops are queued and replayed on reconnect.

### Rate-limit telemetry

```ts
room.on("rateLimit", ({ remaining, resetAt }) => {
  console.warn(`rate limit at 80% — ${remaining} ops left until ${new Date(resetAt)}`);
});
```

When a request is denied, the rejected promise is a `RoomError` with an optional `rateLimit` field carrying `{ limit, window, remaining, resetAt }`.

### Debug logging

```ts
room.debug = true; // logs every send/recv and ws lifecycle event to the console
```

---

## HTTP REST API

The server also accepts plain HTTP requests — useful for SSR, scripts, or any client that doesn't need a persistent socket.

**Auth:** `Authorization: Bearer <apiKey>` header, or `?apiKey=<key>` query param.

```
GET    /parties/room/{apiKey}:{roomId}?key=path/to/key
GET    /parties/room/{apiKey}:{roomId}?prefix=users/&limit=10&cursor=<cursor>
POST   /parties/room/{apiKey}:{roomId}   body: { "key": "...", "value": ..., "ttl": 60 }
DELETE /parties/room/{apiKey}:{roomId}?key=path/to/key
```

All responses are JSON. CORS headers are included on every response.

```bash
# Read a key
curl https://room-server.<user>.partykit.dev/parties/room/key-app1:my-room \
  -H "Authorization: Bearer key-app1" \
  -G --data-urlencode "key=users/alice"

# Write a key
curl https://room-server.<user>.partykit.dev/parties/room/key-app1:my-room \
  -H "Authorization: Bearer key-app1" \
  -H "Content-Type: application/json" \
  -d '{"key":"users/alice","value":{"name":"Alice"}}'

# Delete a key
curl -X DELETE "https://room-server.<user>.partykit.dev/parties/room/key-app1:my-room?key=users/alice" \
  -H "Authorization: Bearer key-app1"
```

HTTP writes trigger real-time change notifications to subscribed WebSocket clients.

> **Note:** The HTTP API supports only basic get/set/delete/list. Atomic operations (`increment`, `set_if`) are WebSocket-only. If you need a counter or compare-and-swap from an HTTP context, use a WebSocket connection instead — an HTTP read-then-write is not atomic and will race under concurrent access.

---

## Persistence levels

| Level | Survives server hibernation | Notes |
|---|---|---|
| `storage` | Yes | Backed by Cloudflare Durable Object storage. Default. |
| `memory` | No | In-process only. Faster, no storage cost. |

The persistence level is set on the **first** connection to a room and is fixed for the lifetime of that room.

---

## Rate limits

Default: 100 ops per 10-second window per WebSocket connection. Excess ops receive an `error` message and are dropped.

Configure at deploy time via env vars:

```bash
npx partykit env add RATE_LIMIT_OPS     # max ops per window (default: 100)
npx partykit env add RATE_LIMIT_WINDOW  # window size in seconds (default: 10)
npx partykit env add MAX_CONNECTIONS    # max simultaneous WS connections per room (default: 100)
```

Or pass them directly on the CLI:

```bash
npx partykit deploy --var RATE_LIMIT_OPS=200 --var RATE_LIMIT_WINDOW=5 --var MAX_CONNECTIONS=50
```

Rate limiting applies to both WebSocket ops (per connection) and HTTP requests (per API key). Excess requests receive a `429` HTTP response or an `error` WebSocket message.

---

## Scheduled jobs

Scheduling is configured entirely from the client — no server modifications needed.

### One-shot alarm

Fire an action once after a delay (in seconds).

```ts
// Delete a key after 10 minutes
await room.scheduleAlarm(600, { op: "delete", key: "temp/cache" });

// Increment a counter in 1 hour
await room.scheduleAlarm(3600, { op: "increment", key: "stats/delayed" });

// Broadcast a message after 30 seconds
await room.scheduleAlarm(30, { op: "broadcast", channel: "alerts", data: { msg: "time's up" } });

// Cancel a pending alarm
await room.cancelAlarm();
```

### Recurring alarm

Fire an action repeatedly on an interval (in seconds). Equivalent to a per-room cron job — survives hibernation and reconnects.

```ts
// Increment a counter every minute
await room.scheduleRecurring(60, { op: "increment", key: "stats/ticks" });

// Broadcast a heartbeat every 30 seconds
await room.scheduleRecurring(30, { op: "broadcast", channel: "ping", data: { ts: Date.now() } });

// Stop the recurring job
await room.cancelRecurring();
```

### Supported alarm actions

| Action | Effect |
|---|---|
| `{ op: "set", key, value }` | Set a key, notifies subscribers |
| `{ op: "delete", key }` | Delete a key, notifies subscribers |
| `{ op: "increment", key, delta? }` | Increment a numeric key, notifies subscribers |
| `{ op: "broadcast", channel, data }` | Broadcast to all connections in the room |

Alarms are backed by Durable Object alarms — they survive hibernation and are guaranteed to fire at least once. Only one one-shot and one recurring job can be active per room at a time.

---

## Running locally

```bash
# Terminal 1 — server (http://localhost:1999)
npm run dev

# Terminal 2 — example app (http://localhost:5173)
cd example
npm install
npm run dev
```

The example app lets you connect, set/get/delete/list keys, and chat via broadcast. Open two tabs to see real-time sync.

---

## Wire protocol

You can connect from any language — no SDK required.

**WebSocket URL**

```
ws://localhost:1999/parties/room/{apiKey}:{roomId}?apiKey=<key>&persistence=storage
```

**Client → Server**

```jsonc
{ "op": "set",                "key": "k", "value": <any>, "ttl": 60,           "requestId": "abc" }
{ "op": "get",                "key": "k",                                       "requestId": "abc" }
{ "op": "delete",             "key": "k",                                       "requestId": "abc" }
{ "op": "list",               "prefix": "users/", "limit": 10, "cursor": "…",   "requestId": "abc" }
{ "op": "increment",          "key": "k", "delta": 1,                           "requestId": "abc" }
{ "op": "set_if",             "key": "k", "value": <any>, "ifValue": <any>,     "requestId": "abc" }
{ "op": "touch",              "key": "k", "ttl": 60,                            "requestId": "abc" }
{ "op": "delete_prefix",      "prefix": "votes/",                               "requestId": "abc" }
{ "op": "snapshot",           "keys": ["…"], "prefixes": ["…/"],                "requestId": "abc" }
{ "op": "subscribe_key",      "key": "meta",      "includeSelf": false }
{ "op": "subscribe_prefix",   "prefix": "users/", "includeSelf": false }
{ "op": "unsubscribe_key",    "key": "meta" }
{ "op": "unsubscribe_prefix", "prefix": "users/" }
{ "op": "broadcast",          "channel": "chat", "data": <any> }
{ "op": "schedule_alarm",     "delay": 60, "action": <AlarmAction>,             "requestId": "abc" }
{ "op": "cancel_alarm",                                                          "requestId": "abc" }
{ "op": "schedule_recurring", "interval": 60, "action": <AlarmAction>,          "requestId": "abc" }
{ "op": "cancel_recurring",                                                      "requestId": "abc" }
```

Where `AlarmAction` is one of:

```jsonc
{ "op": "set",       "key": "k", "value": <any> }
{ "op": "delete",    "key": "k" }
{ "op": "increment", "key": "k", "delta": 1 }
{ "op": "broadcast", "channel": "c", "data": <any> }
```

**Server → Client**

```jsonc
{ "op": "ready",                "persistence": "storage", "appId": "key-app1", "roomId": "my-room", "connectionId": "…" }
{ "op": "ack",                  "requestId": "abc" }
{ "op": "result",               "requestId": "abc", "key": "k", "value": <any> }
{ "op": "list_result",          "requestId": "abc", "prefix": "users/", "entries": {…}, "nextCursor": "…" }
{ "op": "set_if_result",        "requestId": "abc", "success": true, "current": <any> }
{ "op": "delete_prefix_result", "requestId": "abc", "deleted": 12 }
{ "op": "snapshot_result",      "requestId": "abc", "keys": {…}, "prefixes": { "users/": {…} } }
{ "op": "change",               "type": "set",    "key": "k", "value": <any>, "originConnId": "conn-id" | null }
{ "op": "change",               "type": "delete", "key": "k",                  "originConnId": "conn-id" | null }
{ "op": "broadcast_recv",       "channel": "chat", "data": <any> }
{ "op": "rate_limit_warning",   "remaining": 17, "resetAt": 1714500000000 }
{ "op": "error",                "requestId": "abc", "message": "…", "rateLimit": { "limit": 100, "window": 10000, "remaining": 0, "resetAt": 1714500000000 } }
```

`originConnId` is `null` for HTTP, alarm-driven, and TTL-sweep changes. The `rateLimit` field on `error` is only set when the error was caused by rate limiting.

---

## Migration notes

If you're upgrading from a previous release:

- `room.subscribe(prefix, (key, value, deleted) => …)` is replaced by `room.subscribeKey(key, handler)` and `room.subscribePrefix(prefix, handler)`. Handlers now receive a single `ChangeEvent` discriminated union: `{ type: "set", key, value, originConnId }` or `{ type: "delete", key, originConnId }`. `subscribePrefix` requires the prefix to end with `"/"` or be the empty string.
- The wire `change` message gained `type: "set" | "delete"` and `originConnId` and dropped the `deleted` flag.
- `ready` messages now carry `connectionId`.
- New ops: `touch`, `delete_prefix`, `snapshot`. New client methods: `room.touch`, `room.deletePrefix`, `room.snapshot`, `room.flushAndDisconnect`, `room.on`, `room.status`, `room.connectionId`, `room.debug`.
- `error` responses gained an optional `rateLimit` field; the server now also pushes a `rate_limit_warning` once per window when usage crosses 80%.
- For unit tests, a `room-server/mock` entry point exposes `MockRoomClient` (in-memory, no socket) and `resetMockRooms()`.
