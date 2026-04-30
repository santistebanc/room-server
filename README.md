# room-server

A generic PartyKit backend. Any app can connect and get real-time key-value storage, subscriptions, atomic ops, presence, broadcast, scheduled jobs, and schema-validated writes — with no server code to write.

> **v3.0.0 — breaking release.** First-message auth replaces the query-string `apiKey`. `get()` now returns `{ value, rev }`. New methods: `update`, `transact`, `count`, `reserve`, `subscribeWithSnapshotKey/Prefix`, `registerSchemas`. Persistence levels renamed `memory`→`ephemeral`, `storage`→`durable`. See [Migration notes](#migration-notes) for the full diff.

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

const room = new RoomClient({
  host: "room-server.<your-username>.partykit.dev",
  roomId: "my-room",
  config: {
    apiKey: "key-app1",         // must be in ALLOWED_KEYS, or any string in open mode
    userId: "alice",            // optional — stored alongside the connection's presence entry
    persistence: "durable",     // "durable" (default) | "ephemeral"
  },
});

await room.ready();             // resolves once the auth handshake completes
```

The `apiKey` and `userId` are sent inside the first WebSocket frame, not in the URL — keeping credentials out of proxy logs. The server rejects any other op until auth succeeds.

Each unique `roomId` is a fully isolated namespace. Different `apiKey` values are always isolated from each other — two apps cannot access each other's rooms.

The client automatically reconnects on disconnect and restores all subscriptions and in-flight operations. Use `room.status` and `room.on("status", ...)` to observe the connection lifecycle.

---

## API

### `room.set(key, value, opts?)` → `Promise<{ rev }>`

Store any JSON-serialisable value. Optionally set a TTL in seconds after which the key auto-expires.

```ts
await room.set("users/alice", { name: "Alice", online: true });
await room.set("session/abc", { userId: 1 }, { ttl: 3600 }); // expires in 1 hour
```

### `room.get(key)` → `Promise<{ value, rev }>`

Returns the current value and its revision. `rev` is `0` when the key has never existed and increments on every successful write or delete (see [Revisions](#revisions)).

```ts
const { value, rev } = await room.get("users/alice");
if (value === null) {
  // key missing or expired
}
```

### `room.delete(key)` → `Promise<{ rev }>`

```ts
await room.delete("users/alice");
```

### `room.list(prefix, opts?)` → `Promise<{ entries, nextCursor?, truncated? }>`

Get all keys that start with `prefix`. Supports pagination. **Filters out expired TTL keys lazily** (the alarm sweep eventually removes them from storage).

```ts
const { entries } = await room.list("users/");

const page1 = await room.list("users/", { limit: 10 });
const page2 = await room.list("users/", { limit: 10, cursor: page1.nextCursor });
```

If the unbounded list traversal would exceed the soft cap, the response carries `truncated: true`. For large prefixes use [`room.count`](#roomcountprefix--promise-count-truncated-) to probe size first, or paginate.

### `room.count(prefix)` → `Promise<{ count, truncated? }>`

Counts user-visible keys matching a prefix without returning the values. Useful for "should I bother listing this?" checks before pulling a potentially large set.

```ts
const { count, truncated } = await room.count("votes/");
if (truncated) {
  // count was capped; consider sharding the prefix
}
```

### `room.increment(key, delta?)` → `Promise<{ value, rev }>`

Atomically increment a numeric key. Starts from `0` if the key does not exist. `delta` defaults to `1`.

```ts
const { value: views } = await room.increment("stats/views");      // 1
const { value: views } = await room.increment("stats/views", 5);   // 6
```

### `room.setIf(key, value, opts)` → `Promise<{ success, current, rev }>`

Compare-and-swap. Pass exactly one of `ifValue` or `ifRev`.

```ts
// Value-based CAS
const { success } = await room.setIf("lock", "mine", { ifValue: null });

// Revision-based CAS — pair with `room.get` for read-modify-write
const { value, rev } = await room.get("counter");
const { success } = await room.setIf(
  "counter",
  (value as number ?? 0) + 1,
  { ifRev: rev }
);
```

`ifRev: 0` matches any key that has never existed.

### `room.update(key, fn)` → `Promise<{ value, rev }>`

Read-modify-write with automatic revision-based retry on conflict. Up to 5 attempts before throwing.

```ts
const { value } = await room.update<number>("counter", (current) => (current ?? 0) + 1);
```

`update` is implemented client-side using `get` + `setIf({ ifRev })`. The function may run multiple times under contention, so keep it pure.

### `room.reserve(key, value)` → `Promise<boolean>`

Returns `true` if this caller won the race to create the key (i.e. the key did not exist), `false` otherwise. Common use: room metadata, room locks, primary-leader elections.

```ts
const won = await room.reserve("meta", { createdAt: Date.now(), createdBy: userId });
```

Equivalent to `setIf(key, value, { ifRev: 0 }).then(r => r.success)`.

### `room.touch(key, { ttl })` → `Promise<void>`

Refresh the TTL on an existing key without rewriting its value. Errors if the key does not exist or is `null`.

```ts
await room.touch("session/abc", { ttl: 3600 });
```

### `room.deletePrefix(prefix)` → `Promise<{ deleted }>`

Atomically delete every key under a prefix. Subscribers receive one `delete` event per key.

```ts
const { deleted } = await room.deletePrefix("votes/");
```

The empty prefix and reserved prefixes (`__rs/`, `presence/`) are rejected.

### `room.snapshot({ keys?, prefixes? })` → `Promise<{ keys, prefixes, truncated? }>`

Read several keys and/or prefixes in a single round trip. Useful for hydrating UI on first load without N separate fetches.

```ts
const snap = await room.snapshot({
  keys: ["meta", "settings"],
  prefixes: ["users/", "votes/"],
});
// snap.keys.meta, snap.keys.settings
// snap.prefixes["users/"]  — Record<string, unknown>
```

Each prefix is bounded at 10,000 entries; if the cap is hit, `truncated: true` is set.

### `room.transact(ops)` → `Promise<{ success, results, error? }>`

Atomic multi-key write. All ops apply together inside the same Durable Object turn — any precondition failure (CAS mismatch, validation error, reserved key) rolls back the whole batch with no writes performed and no change events emitted.

```ts
const { success, results } = await room.transact([
  { op: "set",       key: "users/alice", value: { name: "Alice" } },
  { op: "increment", key: "stats/users", delta: 1 },
  { op: "set_if",    key: "meta",        value: { version: 2 }, ifRev: 1 },
]);
```

Within a single transact, later ops see the projected state of earlier ops on the same key — so `set` followed by `set_if(ifRev: nextRev)` is well-defined.

### `room.subscribeKey(key, handler, opts?)` → `unsubscribe()`

Receive real-time changes for a single exact key.

```ts
const unsub = room.subscribeKey("meta", (event) => {
  if (event.type === "delete") clearMeta();
  else                         applyMeta(event.value);
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

### `room.subscribeWithSnapshotKey(key, handler, opts?)` → `Promise<{ initial, unsubscribe }>`

Atomic register-and-snapshot. The server delivers the initial state **before** any change event for the same subscription, so there is no bootstrap race between fetching state and subscribing.

```ts
const { initial, unsubscribe } = await room.subscribeWithSnapshotKey(
  "meta",
  (event) => applyMetaEvent(event)
);
applyMetaEvent({ type: "set", key: "meta", value: initial.value, rev: initial.rev, originConnId: null });
```

### `room.subscribeWithSnapshotPrefix(prefix, handler, opts?)` → `Promise<{ initial, unsubscribe }>`

```ts
const { initial, unsubscribe } = await room.subscribeWithSnapshotPrefix(
  "users/",
  (event) => {
    if (event.type === "delete") removeUser(event.key);
    else                         updateUser(event.key, event.value);
  }
);
for (const [k, v] of Object.entries(initial.entries)) updateUser(k, v);
```

### Subscribe options

All subscribe methods accept:

```ts
{
  includeSelf?: boolean,  // default false — receive changes originated by this client
  batchMs?: number,       // default undefined — server batches changes per N ms
}
```

`batchMs` is **flow control**, not true backpressure: the server collects changes for the subscription and flushes a single `change_batch` every N milliseconds, smoothing bursty fanout for slow consumers. Trades latency for fewer wire frames.

### `ChangeEvent`

```ts
type ChangeEvent =
  | { type: "set";    key: string; value: unknown; rev: number; originConnId: string | null }
  | { type: "delete"; key: string;                  rev: number; originConnId: string | null };
```

`originConnId` identifies the connection that originated the change. It is `null` for HTTP, alarm-driven, and TTL-sweep changes. Compare with `room.connectionId` to detect self-writes.

### Presence

The server automatically manages `presence/{connectionId}` entries on connect and disconnect. The presence value is `{ connectedAt, userId? }` if you passed `userId` in the connect config — letting subscribers derive user-level presence cheaply.

```ts
const { initial, unsubscribe } = await room.subscribeWithSnapshotPrefix(
  "presence/",
  (event) => {
    if (event.type === "delete") online.delete(event.key);
    else                         online.set(event.key, event.value);
  }
);
const online = new Map(Object.entries(initial.entries));
```

### `room.broadcast(channel, data)`

Send an arbitrary payload to all connections in the room.

```ts
room.broadcast("chat", { from: "alice", text: "hello" });
```

### `room.onBroadcast(channel, handler)` → `unsubscribe()`

```ts
const unsub = room.onBroadcast("chat", (data) => console.log(data));
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

## Revisions

Every user-visible key has a monotonically increasing revision number stored at `__rs/rev/{key}`. The rev is bumped on every successful `set`, `delete`, `increment`, `setIf`, and on any write via `transact`. Deletes also bump the rev (this prevents ABA bugs in CAS where a value gets deleted and recreated between a read and a `setIf`).

- `get()` returns the current `rev`.
- Change events carry the `rev` after the change.
- `setIf({ ifRev })` succeeds only when the current rev matches.
- `setIf({ ifRev: 0 })` matches a never-existed key (used by `reserve`).

---

## Schema validation

Two complementary layers — server-side enforcement and optional client-side pre-validation.

### Server-side: register JSON Schema in the room

```ts
await room.registerSchemas({
  // Prefix pattern (trailing /)
  "users/": {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
  // Exact key
  "meta": {
    type: "object",
    properties: { version: { type: "integer", minimum: 1 } },
  },
  // Catch-all
  "*": { type: "object" },
});
```

Schemas persist in the room. Subsequent writes whose key matches a pattern are validated; failures return an `error` with a `validationError: { key, schemaPattern, errors[] }` payload.

Pattern resolution: exact key > longest matching prefix > `"*"`. The bundled validator covers a pragmatic subset of JSON Schema Draft 7 (`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minLength/maxLength/pattern`, `minimum/maximum`, `oneOf/anyOf/allOf`). It is intentionally minimal so the whole module fits in a Cloudflare Worker without a 100KB+ bundled validator. For richer schemas, layer client-side validation on top.

### Client-side: optional Standard Schema validators

Pass a `schemas` map to the constructor. Any value type whose validator implements the [Standard Schema](https://github.com/standard-schema/standard-schema) interface (Zod, Valibot, ArkType, etc.) works as-is.

```ts
import { z } from "zod";

const room = new RoomClient({
  host, roomId,
  config: { apiKey: "key-app1" },
  schemas: {
    "users/": z.object({ name: z.string().min(1) }),
    "meta":   z.object({ version: z.number().int().positive() }),
  },
});
```

Client-side schemas are checked before each `set`, `setIf`, `update`, and `transact`. Failures throw `RoomError` with the same `validationError` shape as server-side rejections, but never reach the wire.

---

## Connection lifecycle

`room.status` is one of `"connecting" | "ready" | "reconnecting" | "closed"`.

```ts
room.status                 // current state
room.connectionId           // string once "ready", null otherwise

const off = room.on("status", (s) => {
  document.getElementById("badge")!.textContent = s;
});
off();
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
room.debug = true; // logs every send/recv and ws lifecycle event
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

All responses are JSON and include `rev` on read/write of single keys. CORS headers are set on every response.

```bash
curl https://room-server.<user>.partykit.dev/parties/room/key-app1:my-room \
  -H "Authorization: Bearer key-app1" \
  -G --data-urlencode "key=users/alice"
# → { "key": "users/alice", "value": {…}, "rev": 7 }
```

HTTP writes trigger real-time change notifications to subscribed WebSocket clients. Server-side schema validation applies to HTTP writes too.

> **Note:** The HTTP API supports only basic get/set/delete/list. Atomic operations (`increment`, `set_if`, `transact`) are WebSocket-only. If you need a counter or compare-and-swap from an HTTP context, use a WebSocket connection — an HTTP read-then-write is not atomic and will race.

---

## Persistence levels

| Level | Survives server hibernation | Notes |
|---|---|---|
| `durable` | Yes | Backed by Cloudflare Durable Object storage. Default. |
| `ephemeral` | No | In-process only. Faster, no storage cost. |

The persistence level is set on the **first** connection to a room and is fixed for the lifetime of that room.

---

## Rate limits

Default: 100 ops per 10-second window per WebSocket connection. Excess ops receive an `error` message and are dropped.

Configure at deploy time via env vars:

```bash
npx partykit env add RATE_LIMIT_OPS     # default: 100
npx partykit env add RATE_LIMIT_WINDOW  # window seconds (default: 10)
npx partykit env add MAX_CONNECTIONS    # default: 100
npx partykit env add AUTH_TIMEOUT       # seconds an unauth'd connection has to send auth (default: 10)
```

Rate limiting applies to both WebSocket ops (per connection) and HTTP requests (per API key). Excess requests receive a `429` HTTP response or an `error` WebSocket message.

---

## Scheduled jobs

Scheduling is configured entirely from the client — no server modifications needed.

### One-shot alarm

```ts
await room.scheduleAlarm(600, { op: "delete", key: "temp/cache" });
await room.scheduleAlarm(3600, { op: "increment", key: "stats/delayed" });
await room.scheduleAlarm(30, { op: "broadcast", channel: "alerts", data: { msg: "time's up" } });
await room.cancelAlarm();
```

### Recurring alarm

Equivalent to a per-room cron job — survives hibernation and reconnects.

```ts
await room.scheduleRecurring(60, { op: "increment", key: "stats/ticks" });
await room.scheduleRecurring(30, { op: "broadcast", channel: "ping", data: { ts: Date.now() } });
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

## Testing with `MockRoomClient`

For unit tests, `room-server/mock` exposes an in-memory implementation of the same `IRoomClient` interface. Multiple mock clients with the same `(apiKey, roomId)` share a single in-memory room, so multi-client flows can be tested without a network.

```ts
import { MockRoomClient, resetMockRooms } from "room-server/mock";

afterEach(resetMockRooms);

test("two clients see each other", async () => {
  const a = new MockRoomClient({ roomId: "r1", config: { apiKey: "k", userId: "alice" } });
  const b = new MockRoomClient({ roomId: "r1", config: { apiKey: "k", userId: "bob" } });
  await Promise.all([a.ready(), b.ready()]);

  const events: any[] = [];
  b.subscribePrefix("counter/", (e) => events.push(e));

  await a.set("counter/x", 1);
  expect(events).toEqual([{ type: "set", key: "counter/x", value: 1, rev: 1, originConnId: a.connectionId }]);
});
```

Mocks honour the same key restrictions, schema validation, rev tracking, TTLs, alarms, and `batchMs` flow control as the real server.

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

**WebSocket URL** (auth happens in-band, not via query string)

```
wss://your-server.partykit.dev/parties/room/{apiKey}:{roomId}
```

**Client → Server**

```jsonc
// Required first message — server rejects everything else until this lands.
{ "op": "auth",                 "apiKey": "…", "userId": "…", "persistence": "durable", "requestId": "abc" }

{ "op": "set",                  "key": "k", "value": <any>, "ttl": 60,                   "requestId": "abc" }
{ "op": "get",                  "key": "k",                                              "requestId": "abc" }
{ "op": "delete",               "key": "k",                                              "requestId": "abc" }
{ "op": "list",                 "prefix": "users/", "limit": 10, "cursor": "…",          "requestId": "abc" }
{ "op": "count",                "prefix": "users/",                                      "requestId": "abc" }
{ "op": "increment",            "key": "k", "delta": 1,                                  "requestId": "abc" }
{ "op": "set_if",               "key": "k", "value": <any>, "ifValue": <any>,            "requestId": "abc" }
{ "op": "set_if",               "key": "k", "value": <any>, "ifRev": 7,                  "requestId": "abc" }
{ "op": "touch",                "key": "k", "ttl": 60,                                   "requestId": "abc" }
{ "op": "delete_prefix",        "prefix": "votes/",                                      "requestId": "abc" }
{ "op": "snapshot",             "keys": ["…"], "prefixes": ["…/"],                       "requestId": "abc" }
{ "op": "transact",             "ops": [<TransactOp>, …],                                "requestId": "abc" }
{ "op": "register_schemas",     "schemas": { "users/": <JsonSchema>, … }, "replace": false, "requestId": "abc" }

{ "op": "subscribe_key",        "key": "meta",      "includeSelf": false, "batchMs": 100 }
{ "op": "subscribe_prefix",     "prefix": "users/", "includeSelf": false, "batchMs": 100 }
{ "op": "subscribe_with_snapshot_key",    "key": "meta",      "includeSelf": false, "batchMs": 100, "requestId": "abc" }
{ "op": "subscribe_with_snapshot_prefix", "prefix": "users/", "includeSelf": false, "batchMs": 100, "requestId": "abc" }
{ "op": "unsubscribe_key",      "key": "meta" }
{ "op": "unsubscribe_prefix",   "prefix": "users/" }

{ "op": "broadcast",            "channel": "chat", "data": <any> }
{ "op": "schedule_alarm",       "delay": 60, "action": <AlarmAction>,                    "requestId": "abc" }
{ "op": "cancel_alarm",                                                                  "requestId": "abc" }
{ "op": "schedule_recurring",   "interval": 60, "action": <AlarmAction>,                 "requestId": "abc" }
{ "op": "cancel_recurring",                                                              "requestId": "abc" }
```

Where `TransactOp` is one of:

```jsonc
{ "op": "set",       "key": "k", "value": <any>, "ttl": 60 }
{ "op": "delete",    "key": "k" }
{ "op": "increment", "key": "k", "delta": 1 }
{ "op": "set_if",    "key": "k", "value": <any>, "ifValue": <any> }
{ "op": "set_if",    "key": "k", "value": <any>, "ifRev": 7 }
```

And `AlarmAction` is one of:

```jsonc
{ "op": "set",       "key": "k", "value": <any> }
{ "op": "delete",    "key": "k" }
{ "op": "increment", "key": "k", "delta": 1 }
{ "op": "broadcast", "channel": "c", "data": <any> }
```

**Server → Client**

```jsonc
{ "op": "ready",                "persistence": "durable", "appId": "key-app1", "roomId": "my-room", "connectionId": "…" }
{ "op": "ack",                  "requestId": "abc" }
{ "op": "result",               "requestId": "abc", "key": "k", "value": <any>, "rev": 7 }
{ "op": "list_result",          "requestId": "abc", "prefix": "users/", "entries": {…}, "nextCursor": "…", "truncated": false }
{ "op": "count_result",         "requestId": "abc", "prefix": "users/", "count": 42, "truncated": false }
{ "op": "set_if_result",        "requestId": "abc", "success": true, "current": <any>, "rev": 8 }
{ "op": "delete_prefix_result", "requestId": "abc", "deleted": 12 }
{ "op": "snapshot_result",      "requestId": "abc", "keys": {…}, "prefixes": { "users/": {…} } }
{ "op": "transact_result",      "requestId": "abc", "success": true, "results": [<TransactOpResult>, …] }
{ "op": "snapshot_initial",     "requestId": "abc", "kind": "key" | "prefix", "target": "…", "value": <any>, "rev": 7, "entries": {…} }
{ "op": "schemas_registered",   "requestId": "abc", "count": 3 }

{ "op": "change",               "type": "set",    "key": "k", "value": <any>, "rev": 8, "originConnId": "conn-id" | null }
{ "op": "change",               "type": "delete", "key": "k",                  "rev": 9, "originConnId": "conn-id" | null }
{ "op": "change_batch",         "changes": [<change>, …] }

{ "op": "broadcast_recv",       "channel": "chat", "data": <any> }
{ "op": "rate_limit_warning",   "remaining": 17, "resetAt": 1714500000000 }
{ "op": "error",                "requestId": "abc", "message": "…",
                                "rateLimit": { "limit": 100, "window": 10000, "remaining": 0, "resetAt": 1714500000000 },
                                "validationError": { "key": "users/alice", "schemaPattern": "users/", "errors": [{ "path": ".name", "message": "…" }] } }
```

`originConnId` is `null` for HTTP, alarm-driven, and TTL-sweep changes. The `rateLimit` and `validationError` fields on `error` are only set when relevant.

---

## Migration notes

Upgrading from v2.x:

- **Auth moved out of the URL.** v2 sent `apiKey` and `persistence` as query-string params; v3 sends them as the first WebSocket frame (`{ op: "auth", apiKey, userId?, persistence? }`). The SDK does this automatically — no consumer change required, but custom protocol clients must update.
- **Persistence levels renamed.** `"memory"` → `"ephemeral"`, `"storage"` → `"durable"`. There is no compat alias; existing rooms persisted with the old names will fail to hydrate. Since v2.x was a brief release, this is expected to affect at most one consumer.
- **`get()` returns `{ value, rev }`** instead of `unknown`. Update call sites to destructure.
- **Change events carry `rev`.** Existing handlers continue to work (`event.rev` is just an extra field), but consumers wanting CAS can now read it directly.
- **`setIf` signature changed.** The third argument is now an options object: `setIf(key, value, { ifValue })` or `setIf(key, value, { ifRev })`. The old positional `setIf(key, value, ifValue)` no longer compiles.
- **`set` and `delete` return `{ rev }`.** Callers ignoring the return value continue to work.
- **`list()` filters out expired TTL keys** — closes a v2 correctness gap where expired keys could surface in list results between sweeps.
- **New methods**: `room.update`, `room.transact`, `room.count`, `room.reserve`, `room.subscribeWithSnapshotKey/Prefix`, `room.registerSchemas`. New constructor option `config.userId` and `options.schemas` (client-side Standard Schema validators).
- **`subscribePrefix` and `subscribeKey` accept `batchMs`** for server-side flow control on noisy prefixes.
- **TTL sweep is now O(log n)** via a sorted-by-expiry index — relevant only for rooms with many TTLs in flight.
