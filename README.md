# room-server

A generic PartyKit backend. Any app can connect and get real-time key-value storage, subscriptions, atomic ops, presence, broadcast, and scheduled jobs — with no server code to write.

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

await room.ready();           // resolves once server handshake completes
```

Each unique `roomId` is a fully isolated namespace. Different `apiKey` values are always isolated from each other — two apps cannot access each other's rooms.

The client automatically reconnects on disconnect and restores all subscriptions and in-flight operations.

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

### `room.subscribe(prefix, handler)` → `unsubscribe()`

Receive real-time changes from other connected clients whenever a matching key is set or deleted.

```ts
const unsub = room.subscribe("users/", (key, value, deleted) => {
  if (deleted) removeUser(key);
  else updateUser(key, value);
});

unsub(); // stop listening
```

The subscribing client does **not** receive its own changes.

Subscribe to `"presence/"` to track who is online — the server automatically manages `presence/{connectionId}` entries on connect and disconnect.

```ts
// Get current online users immediately, then watch for changes.
const { entries } = await room.list("presence/");
const online = new Map(Object.entries(entries));

room.subscribe("presence/", (key, value, deleted) => {
  if (deleted) online.delete(key);
  else online.set(key, value);
  console.log("online:", [...online.keys()]);
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

Close the WebSocket connection.

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
{ "op": "set",         "key": "k", "value": <any>, "ttl": 60,        "requestId": "abc" }
{ "op": "get",         "key": "k",                                    "requestId": "abc" }
{ "op": "delete",      "key": "k",                                    "requestId": "abc" }
{ "op": "list",        "prefix": "users/", "limit": 10, "cursor": "…","requestId": "abc" }
{ "op": "increment",   "key": "k", "delta": 1,                        "requestId": "abc" }
{ "op": "set_if",      "key": "k", "value": <any>, "ifValue": <any>,  "requestId": "abc" }
{ "op": "subscribe",        "prefix": "users/" }
{ "op": "unsubscribe",      "prefix": "users/" }
{ "op": "broadcast",        "channel": "chat", "data": <any> }
{ "op": "schedule_alarm",   "delay": 60, "action": <AlarmAction>,          "requestId": "abc" }
{ "op": "cancel_alarm",                                                     "requestId": "abc" }
{ "op": "schedule_recurring","interval": 60, "action": <AlarmAction>,      "requestId": "abc" }
{ "op": "cancel_recurring",                                                 "requestId": "abc" }
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
{ "op": "ready",         "persistence": "storage", "appId": "key-app1", "roomId": "my-room" }
{ "op": "ack",           "requestId": "abc" }
{ "op": "result",        "requestId": "abc", "key": "k", "value": <any> }
{ "op": "list_result",   "requestId": "abc", "prefix": "users/", "entries": {…}, "nextCursor": "…" }
{ "op": "set_if_result", "requestId": "abc", "success": true, "current": <any> }
{ "op": "change",        "key": "k", "value": <any>, "deleted": false }
{ "op": "broadcast_recv","channel": "chat", "data": <any> }
{ "op": "error",         "requestId": "abc", "message": "…" }
```
