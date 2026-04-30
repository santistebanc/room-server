# room-server

A generic PartyKit backend. Any app can connect and get real-time key-value storage, subscriptions, atomic ops, presence, broadcast, scheduled jobs, and schema-validated writes — with no server code to write.

> **v3.2 — fully additive.** `delete` change events now carry `priorValue` (the last-known value before the delete), enabling derived-state subscribers to evict by a non-storage-key without a side-map. `room.ready()` waits for auto-schema-registration to settle, so `room.schemaVersion` is post-upload accurate the moment `await room.ready()` returns. README adds a "Safe schema evolution" section.
>
> **v3.1 — one constructor break.** `RoomClient<TSchema>` infers value types from a schema map. The `schemas` constructor option groups server JSON Schema, client Standard Schema, and a numeric `version` for handshake-time registration. `reserve` accepts `SetOptions` (TTL). `RoomError.kind` exposes a discriminated union for ergonomic error handling. See [Migration notes](#migration-notes).

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

### `room.reserve(key, value, opts?)` → `Promise<boolean>`

Returns `true` if this caller won the race to create the key (i.e. the key did not exist), `false` otherwise. Common use: room metadata, room locks, primary-leader elections, abandoned-room cleanup with TTL.

```ts
const won = await room.reserve("meta", { createdAt: Date.now(), createdBy: userId });

// With TTL — useful for rooms that should self-clean if abandoned.
await room.reserve("meta", DEFAULT_META(), { ttl: 60 * 60 * 24 * 30 }); // 30 days
```

Equivalent to `setIf(key, value, { ifRev: 0, ttl })` returning the `success` flag. The TTL applies on successful reservation; on a failed race the existing key's TTL is untouched.

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

**When to reach for `batchMs`:** default to immediate delivery. Consider `batchMs: 16` (one frame per animation tick) for prefixes that fire more than ~10 changes per second to a UI consumer that re-renders per event — e.g. a tally bar updating per vote in a 1k-voter poll. Bump higher (`100`–`250`) for analytics or background readers where sub-100ms latency doesn't matter. A subscription's effective `batchMs` is the **min** across all handlers attached to that key/prefix, so a single immediate-mode handler defeats batching for everyone on that subscription.

#### Self-write detection with `includeSelf`

When you opt into `includeSelf: true` for some subscriptions but not others, you may want to skip self-events on a per-handler basis — say, suppress your own typing indicator while still seeing it for others:

```ts
room.subscribePrefix("typing/", (event) => {
  if (event.originConnId === room.connectionId) return; // skip my own writes
  showTypingFor(event.key);
}, { includeSelf: true });
```

`originConnId` is `null` for HTTP, alarm-driven, and TTL-sweep changes; that's how you distinguish a server-side mutation from any client write.

### `subscribeWithSnapshotPrefix` capacity

The atomic `(snapshot + subscribe)` primitive is bounded at **1000 entries** in the initial snapshot — beyond that, the server returns `truncated: true`. There is no streaming pagination cursor for the truncated tail in v3.1; the design choice is that prefixes large enough to truncate should be sharded at write time (e.g. `votes/<bucket>/<id>`) rather than papered over with handler-side pagination.

If you absolutely need to read past the cap on cold start, fall back to `room.list(prefix)` after the subscription is registered — but be aware this reintroduces the bootstrap race the snapshot primitive was designed to close. For most apps the right answer is to design the key space so 1000 entries is generous (e.g. one prefix per poll, not one per app).

### `ChangeEvent`

```ts
type ChangeEvent =
  | { type: "set";    key: string; value: unknown;           rev: number; originConnId: string | null }
  | { type: "delete"; key: string; priorValue: unknown | null; rev: number; originConnId: string | null };
```

`originConnId` identifies the connection that originated the change. It is `null` for HTTP, alarm-driven, and TTL-sweep changes. Compare with `room.connectionId` to detect self-writes.

`priorValue` (since v3.2) is the last-known value of the key right before the delete — useful when you maintain derived state keyed by something other than the storage key (e.g. a `Set<userId>` derived from `presence/{connId}`):

```ts
const userIds = new Set<string>();
room.subscribePrefix("presence/", (e) => {
  if (e.type === "set"    && e.value?.userId)      userIds.add(e.value.userId);
  if (e.type === "delete" && e.priorValue?.userId) userIds.delete(e.priorValue.userId);
});
```

`priorValue` is `null` if the key was already absent at the time of the delete (or if the value really was `null`). The server populates it on every delete-driving code path (explicit `delete`, `delete_prefix`, `transact` delete, presence cleanup on disconnect, alarm-driven deletes, and TTL sweeps).

### Presence

The server automatically manages a `presence/{connectionId}` entry per live socket. On connect, `presence/{connId}` is set to `{ connectedAt, userId? }` (the `userId` is whatever you passed in the connect config — `null`/missing if you didn't). On graceful disconnect, the entry is deleted; on hibernation, surviving entries are pruned at room re-init.

The `presence/` prefix is a normal subscribable namespace — the same primitives apply with no special-casing:

```ts
// Read current online list — same call you'd use for any other prefix.
const snap = await room.snapshot({ prefixes: ["presence/"] });
const online = snap.prefixes["presence/"]; // Record<connectionId, { connectedAt, userId? }>

// Subscribe to live online/offline transitions.
const { initial, unsubscribe } = await room.subscribeWithSnapshotPrefix(
  "presence/",
  (event) => {
    if (event.type === "delete") onlineByUser.delete(event.key);
    else                         onlineByUser.set(event.key, event.value);
  }
);
```

`change` events fire on connect (as `set`) and disconnect (as `delete`) just like any other key. TTL applies the same way (none by default — entries are cleared when the socket closes, not by clock). The reserved prefix means clients **cannot** write under `presence/` themselves; this is the only namespace constraint on the otherwise generic key space.

A common pattern (and what you should reach for first) is to consolidate "is the socket alive?" with "what is this user doing?" by:

- letting the server own `presence/` (alive/dead, derived from the socket),
- writing your own `users/{userId}` records for app-level state (mode, profile, …),
- joining the two on the read side via `userId` in the presence value.

This composes without a 10-second heartbeat loop on the client.

#### Worked example: derived `Set<userId>` from `presence/`

Multi-tab users can have several `presence/{connId}` rows mapped to the same `userId`. To maintain a `Set<userId>` of currently-online distinct users, lean on `priorValue` (v3.2) so the delete handler knows whose connection just dropped — without you keeping a side-map from `connId → userId`:

```ts
type PresenceValue = { connectedAt: number; userId?: string };

const onlineUserIds = new Set<string>();
const refCount = new Map<string, number>(); // userId → live conn count

const { initial, unsubscribe } = await room.subscribeWithSnapshotPrefix<PresenceValue>(
  "presence/",
  (e) => {
    if (e.type === "set") {
      const uid = e.value.userId;
      if (!uid) return;
      refCount.set(uid, (refCount.get(uid) ?? 0) + 1);
      onlineUserIds.add(uid);
    } else {
      const uid = e.priorValue?.userId;
      if (!uid) return;
      const next = (refCount.get(uid) ?? 1) - 1;
      if (next <= 0) {
        refCount.delete(uid);
        onlineUserIds.delete(uid);
      } else {
        refCount.set(uid, next);
      }
    }
  }
);

// Seed from the initial snapshot.
for (const [, value] of Object.entries(initial.entries) as [string, PresenceValue][]) {
  if (!value.userId) continue;
  refCount.set(value.userId, (refCount.get(value.userId) ?? 0) + 1);
  onlineUserIds.add(value.userId);
}
```

The ref-count guards against "user closes one of their tabs" being interpreted as "user went offline" — only the last tab's delete evicts.

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

Close the WebSocket connection immediately. Pending operations are rejected with `RoomError` (`kind: "transient"`).

### `room.flushAndDisconnect(timeoutMs?)` → `Promise<void>`

Wait for in-flight operations to settle (or the timeout, default 5s) before closing. Useful in `beforeunload` handlers to make sure the user's last write actually lands.

```ts
window.addEventListener("beforeunload", () => {
  room.flushAndDisconnect();
});
```

Behavior under each connection state:

| `room.status` when called | What `flushAndDisconnect` does |
|---|---|
| `"ready"` | Awaits ack of every in-flight op (or `timeoutMs`, default 5000). Returns once the socket is closed. |
| `"reconnecting"` | Does **not** await reconnect. The pending ops are kept until either the socket reconnects and acks them within `timeoutMs`, or the timeout elapses. Either way, the socket is then closed and the promise resolves. |
| `"connecting"` | Same as `"reconnecting"`. |
| `"closed"` | No-op; resolves immediately. |

The promise itself never rejects — pending op promises do (`kind: "transient"`) if they didn't get acks before close. Treat `flushAndDisconnect` as a best-effort drain, not a guarantee of delivery.

---

## Revisions

Every user-visible key has a monotonically increasing revision number stored at `__rs/rev/{key}`. The rev is bumped on every successful `set`, `delete`, `increment`, `setIf`, and on any write via `transact`. Deletes also bump the rev (this prevents ABA bugs in CAS where a value gets deleted and recreated between a read and a `setIf`).

- `get()` returns the current `rev`.
- Change events carry the `rev` after the change.
- `setIf({ ifRev })` succeeds only when the current rev matches.
- `setIf({ ifRev: 0 })` matches a never-existed key (used by `reserve`).

---

## Schema validation

Three layers, declared in one place — the `schemas` constructor option:

```ts
import { RoomClient } from "room-server/client";
import { z } from "zod";

interface RoomSchema {
  meta:     { title: string; version: number };
  settings: { tally: "borda" | "copeland" };
  "users/": { name: string; mode: "voting" | "idle" };
  "votes/": { voterId: string; option: string };
}

const room = new RoomClient<RoomSchema>({
  host, roomId,
  config: { apiKey: "key-app1", userId: "alice" },
  schemas: {
    // 1. JSON Schema for server-side enforcement.
    server: {
      meta:     { type: "object", required: ["title", "version"], properties: { title: { type: "string" }, version: { type: "integer", minimum: 1 } } },
      "users/": { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
    },
    // 2. Optional Standard Schema for fast client-side pre-validation.
    client: {
      meta:     z.object({ title: z.string().min(1), version: z.number().int().positive() }),
      "users/": z.object({ name: z.string().min(1), mode: z.enum(["voting", "idle"]) }),
    },
    // 3. Monotonic version. Server stores it; only `version > current` re-uploads.
    version: 3,
  },
});
```

### What each layer does

- **`server`** — JSON Schema map. Persisted in the room. Every write (WS or HTTP) is validated against the matching pattern; failures return an `error` with `kind: "validation"` and a `validationError` payload. Resolution: exact key > longest prefix > `"*"`. The bundled validator implements the pragmatic subset of Draft 7 (`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minLength/maxLength/pattern`, `minimum/maximum`, `oneOf/anyOf/allOf`).
- **`client`** — optional Standard Schema validators ([Zod](https://zod.dev/), Valibot, ArkType, etc.). Run locally before each `set`/`setIf`/`update`/`transact`; failures throw `RoomError` with `kind: "validation"` without crossing the wire.
- **`version`** — monotonic integer. The handshake includes this number; if it's greater than the room's current version, the SDK auto-uploads `server` schemas with `replace: true` and bumps the room. If it's `≤ current`, the SDK skips registration entirely (zero bandwidth in steady state, deterministic under concurrent rolling deploys).

### `RoomClient<TSchema>` type inference

`TSchema` is a key-pattern → value-type map; the SDK narrows method signatures from it:

```ts
client.set("meta", { title: "Poll", version: 1 });    // ✓ value: Meta
client.set("meta", { title: 42 });                    // ✗ TS error
client.set("metaa", { … });                           // typo: value unconstrained (unknown)

const m = await client.get("meta");                   // m.value: Meta | null

client.update("meta", (current) => ({                 // current: Meta | null
  ...current,
  version: (current?.version ?? 0) + 1,
}));

client.subscribePrefix("votes/", (e) => {             // e.value: Vote on type "set"
  if (e.type === "set") apply(e.value.option);
});

await client.reserve("meta", DEFAULT_META, { ttl });
```

Patterns: exact keys (`"meta"`), prefixes (`"votes/"`, must end with `/`), or catch-all (`"*"`). Resolution: exact > longest prefix > `"*"` > `unknown`. Prefer a TypeScript `interface RoomSchema { … }` declaration — works as well as `type RoomSchema = { … }` (the constraint is `object`, not `Record<string, unknown>`).

#### TS schema vs server JSON Schema are independent

`RoomClient<TSchema>` and `schemas.server` are two separate maps that don't have to match. The TS one drives compile-time narrowing for handler values and method signatures; the server one drives runtime rejection of bad writes.

It's normal — and often correct — to declare them with different keys:

- Put `presence/` in your `TSchema` so `subscribePrefix("presence/", e => e.priorValue.userId)` types correctly. Don't put it in `schemas.server`: clients can't write `presence/` anyway, so server-side validation is moot.
- Conversely, validate `votes/` server-side without bothering to add it to `TSchema` if it's only ever read by code that already knows the shape (e.g. an admin tally script).

Mismatch is fine in either direction. The constraint is just that **for keys present in both**, the JSON Schema and the TypeScript type should describe the same structure — or your types lie about what hits the wire.

### Manual schema registration

`room.registerSchemas` is still available for ad-hoc updates from a privileged client:

```ts
await room.registerSchemas({ "votes/": NEW_VOTE_SCHEMA }, { replace: false, version: 4 });
```

Schemas are **forward-only**: registration validates only future writes. Pre-existing data is not re-validated, not quarantined, and continues to surface in `list`, `snapshot`, and `subscribe` results. Migrate explicitly (read-validate-rewrite under `setIf`) if you need to clean historical data.

### Schema conflicts

If two clients (e.g. an old tab and a new tab during a rolling deploy) try to register schemas concurrently with overlapping versions, the second fails with `RoomError` carrying `kind: "schemaConflict"` and a `schemaConflict: { incomingVersion, currentVersion }` payload. The SDK silently tolerates this in its auto-register path — the racing tab won, and the new room state is what you intended anyway.

### Safely evolving a schema

`registerSchemas` is **forward-only**: registration only validates future writes. Pre-existing data is not re-validated, not quarantined, and continues to surface in `list`, `snapshot`, and `subscribe` results. So the safety of a schema change depends on whether old in-flight writes from old clients (during your rolling deploy window) and old data already in the store remain valid under the new schema.

Two axes to think about — **structural** (what changed) and **strictness** (whether `additionalProperties` rejects the unexpected):

| Change | Old data still valid? | Old client writes still valid? | Action |
|---|---|---|---|
| Add an optional field | Yes | Yes | Bump `version` (so the new schema lands), no other action |
| Add a required field | **No** | **No** | Migrate first (read-validate-rewrite under `setIf({ ifRev })`), then bump `version` |
| Drop a field, `additionalProperties: true` (default) | Yes | Yes | Bump `version`, optionally migrate to clean up later |
| Drop a field, `additionalProperties: false` | **No** | **No** | Either keep `additionalProperties: true`, or migrate first then bump |
| Tighten a constraint (`minLength`, narrower `enum`, …) | If existing data complies | If old clients write compliant values | Audit, then bump |
| Loosen a constraint | Yes | Yes | Bump |
| Rename a field | **No** | **No** | Two-step migration: add the new name as optional, migrate data, drop the old name in a later version |

**The 2-step pattern for risky changes.** When you can't safely flip the schema in one shot:

1. Bump `version: N` to a permissive intermediate (e.g. `additionalProperties: true`, both old and new field names accepted as optional).
2. Migrate data with a one-shot script: read every key under the affected prefix, transform, write under `setIf({ ifRev })` to avoid clobbering concurrent writes.
3. Bump `version: N+1` to the strict final shape.

**Rolling-deploy window.** Between the moment the new code starts shipping and the moment every old tab has reloaded, both old and new clients are talking to the same room. Old clients pre-validate against the old `client` schemas (no problem) and write through. The server validates against whatever was last `register_schemas`'d. The auto-upload race resolves deterministically: the highest `version` wins, others get `schemaConflict` and back off. So:

- **In-flight writes during the auto-upload window** (the few ms between connect and `register_schemas` ack): the old schema is still active, so anything an old client could legally write goes through. Nothing accumulates "validated against the wrong schema" — the validator that ran is exactly the one in effect at that instant.
- **Data written by an old client after the upload completes**: must be valid under the new schema, or it's rejected. This is why "additive only" is the safe regime for rolling deploys; subtractive changes need the migration step before the bump.

When in doubt: leave `additionalProperties: true` (the default), make changes additive, and migrate explicitly with `update`/`setIf` if you ever need to clean historical data.

---

## Connection lifecycle

`room.status` is one of `"connecting" | "ready" | "reconnecting" | "closed"`.

```ts
room.status                 // current state
room.connectionId           // string once "ready", null otherwise
room.schemaVersion          // current room schema version (post-upload), null until ready

const off = room.on("status", (s) => {
  document.getElementById("badge")!.textContent = s;
});
off();
```

`await room.ready()` resolves once the auth handshake completes **and** any auto-schema-registration triggered by `schemas.version > server's` has settled (success or `schemaConflict` — the latter is silently tolerated). Since v3.2 you can read `room.schemaVersion` directly after `await room.ready()` and trust it reflects the post-upload state without polling.

Subscriptions and in-flight ops are automatically restored when the socket reconnects. While reconnecting, new ops are queued and replayed on reconnect.

### Rate-limit telemetry

```ts
room.on("rateLimit", ({ remaining, resetAt }) => {
  console.warn(`rate limit at 80% — ${remaining} ops left until ${new Date(resetAt)}`);
});
```

When a request is denied, the rejected promise is a `RoomError` with `kind: "rateLimit"` and a `rateLimit: { limit, window, remaining, resetAt }` field.

### `RoomError`

Every rejection from a `RoomClient` method is a `RoomError`. Discriminate on `.kind`:

```ts
import { RoomError } from "room-server/client";

try {
  await room.set("meta", value);
} catch (e) {
  if (!(e instanceof RoomError)) throw e;
  switch (e.kind) {
    case "validation":     // e.validationError: { key, schemaPattern, errors[] }
    case "rateLimit":      // e.rateLimit: { limit, window, remaining, resetAt }
    case "auth":           // bad apiKey, auth timeout, etc.
    case "schemaConflict": // e.schemaConflict: { incomingVersion, currentVersion }
    case "transient":      // socket closed, op disconnected before ack — safe to retry
    case "invalid":        // client-side bad usage (reserved key, bad opts, …) — fix the call site
    case "unknown":        // unmapped server error
  }
}
```

`transient` is the only kind that's generally safe to auto-retry; `invalid` and `validation` indicate consumer bugs and `auth`/`schemaConflict` need higher-level handling.

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
// `schemaVersion` (optional) lets the server decide whether to fast-path schema upload.
{ "op": "auth",                 "apiKey": "…", "userId": "…", "persistence": "durable", "schemaVersion": 3, "requestId": "abc" }

{ "op": "set",                  "key": "k", "value": <any>, "ttl": 60,                   "requestId": "abc" }
{ "op": "get",                  "key": "k",                                              "requestId": "abc" }
{ "op": "delete",               "key": "k",                                              "requestId": "abc" }
{ "op": "list",                 "prefix": "users/", "limit": 10, "cursor": "…",          "requestId": "abc" }
{ "op": "count",                "prefix": "users/",                                      "requestId": "abc" }
{ "op": "increment",            "key": "k", "delta": 1,                                  "requestId": "abc" }
{ "op": "set_if",               "key": "k", "value": <any>, "ifValue": <any>, "ttl": 60,  "requestId": "abc" }
{ "op": "set_if",               "key": "k", "value": <any>, "ifRev": 7, "ttl": 60,        "requestId": "abc" }
{ "op": "touch",                "key": "k", "ttl": 60,                                   "requestId": "abc" }
{ "op": "delete_prefix",        "prefix": "votes/",                                      "requestId": "abc" }
{ "op": "snapshot",             "keys": ["…"], "prefixes": ["…/"],                       "requestId": "abc" }
{ "op": "transact",             "ops": [<TransactOp>, …],                                "requestId": "abc" }
// `version` is optional; when present the server rejects with kind:"schemaConflict" if `version <= current`.
{ "op": "register_schemas",     "schemas": { "users/": <JsonSchema>, … }, "replace": false, "version": 3, "requestId": "abc" }

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
{ "op": "set_if",    "key": "k", "value": <any>, "ifValue": <any>, "ttl": 60 }
{ "op": "set_if",    "key": "k", "value": <any>, "ifRev": 7,        "ttl": 60 }
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
{ "op": "ready",                "persistence": "durable", "appId": "key-app1", "roomId": "my-room", "connectionId": "…", "schemaVersion": 3 }
{ "op": "ack",                  "requestId": "abc" }
{ "op": "result",               "requestId": "abc", "key": "k", "value": <any>, "rev": 7 }
{ "op": "list_result",          "requestId": "abc", "prefix": "users/", "entries": {…}, "nextCursor": "…", "truncated": false }
{ "op": "count_result",         "requestId": "abc", "prefix": "users/", "count": 42, "truncated": false }
{ "op": "set_if_result",        "requestId": "abc", "success": true, "current": <any>, "rev": 8 }
{ "op": "delete_prefix_result", "requestId": "abc", "deleted": 12 }
{ "op": "snapshot_result",      "requestId": "abc", "keys": {…}, "prefixes": { "users/": {…} } }
{ "op": "transact_result",      "requestId": "abc", "success": true, "results": [<TransactOpResult>, …] }
{ "op": "snapshot_initial",     "requestId": "abc", "kind": "key" | "prefix", "target": "…", "value": <any>, "rev": 7, "entries": {…} }
{ "op": "schemas_registered",   "requestId": "abc", "count": 3, "schemaVersion": 3 }

{ "op": "change",               "type": "set",    "key": "k", "value": <any>,                        "rev": 8, "originConnId": "conn-id" | null }
{ "op": "change",               "type": "delete", "key": "k", "priorValue": <any> | null,            "rev": 9, "originConnId": "conn-id" | null }
{ "op": "change_batch",         "changes": [<change>, …] }

{ "op": "broadcast_recv",       "channel": "chat", "data": <any> }
{ "op": "rate_limit_warning",   "remaining": 17, "resetAt": 1714500000000 }
{ "op": "error",                "requestId": "abc", "message": "…",
                                "kind": "validation" | "rateLimit" | "auth" | "schemaConflict" | "invalid" | "unknown",
                                "rateLimit":       { "limit": 100, "window": 10000, "remaining": 0, "resetAt": 1714500000000 },
                                "validationError": { "key": "users/alice", "schemaPattern": "users/", "errors": [{ "path": ".name", "message": "…" }] },
                                "schemaConflict":  { "incomingVersion": 2, "currentVersion": 3 } }
```

`originConnId` is `null` for HTTP, alarm-driven, and TTL-sweep changes. The `rateLimit`, `validationError`, and `schemaConflict` fields on `error` are only set when relevant; `kind` is always present in v3.1+ servers and discriminates which payload (if any) is attached.

---

## Migration notes

### Upgrading from v3.1 to v3.2

Fully additive — no consumer code needs to change.

- **`delete` change events now carry `priorValue`.** The field is optional on the wire (`priorValue?: unknown`) and present on the typed event as `priorValue: V | null`. Existing handlers that only read `e.key`/`e.rev`/`e.originConnId` keep working unchanged. New consumers can subscribe to `presence/`-style namespaces and maintain derived state without a side-map. See [`ChangeEvent`](#changeevent) and the [presence-derived-set worked example](#worked-example-derived-setuserid-from-presence).
- **`room.ready()` waits for auto-schema-registration to settle.** If `schemas.version` is higher than the server's current version, `await room.ready()` resolves only after the auto-`register_schemas` ack lands (or fails with `schemaConflict` — the SDK silently tolerates that and resolves anyway). `room.schemaVersion` is now post-upload accurate the moment `ready()` returns. Removes the diagnostic-foot-gun where `console.log(room.schemaVersion)` right after `ready` showed the pre-upload value for an event-loop tick.
- **No wire-protocol breakage.** Older servers that don't include `priorValue` on the wire still work — `e.priorValue` falls back to `null`. Older clients that don't read `priorValue` continue to ignore it.

### Upgrading from v3.0 to v3.1

One breaking change in the constructor; everything else is additive.

- **`schemas` constructor option is now grouped.** v3.0 took a flat `schemas: ClientSchemaMap` (Standard Schema validators); v3.1 takes:

  ```ts
  new RoomClient<TSchema>({
    …,
    schemas: {
      server?: { /* JSON Schema map */ },
      client?: { /* Standard Schema map (was the old top-level value) */ },
      version?: number,
    },
  });
  ```

  Drop-in fix: `schemas: foo` → `schemas: { client: foo }`. The new structure also unlocks server-side enforcement and version-gated handshake registration without a separate `await room.registerSchemas(...)` dance after `ready`.
- **`RoomClient` is now generic.** `new RoomClient<RoomSchema>({ … })` infers value types on every method that takes/returns a key's value (`set`, `get`, `setIf`, `update`, `reserve`, `subscribeKey`, `subscribePrefix`, `subscribeWithSnapshotKey`, `subscribeWithSnapshotPrefix`). Without a generic argument, methods type as `unknown` (same as v3.0). No runtime impact.
- **`reserve` accepts `SetOptions`.** `room.reserve(key, value, { ttl })` now schedules the TTL on a successful reservation. v3.0 had no way to set a TTL on `reserve`.
- **`setIf` accepts a `ttl`** alongside `ifValue`/`ifRev`, applied on success. Mirrors the wire protocol's new field; no impact unless you opt in.
- **`RoomError` has a `kind` discriminator.** Existing `validationError` and `rateLimit` fields are still set; v3.1 also adds `kind: "validation" | "rateLimit" | "auth" | "schemaConflict" | "transient" | "invalid" | "unknown"`. Switching on `.kind` is the recommended pattern. Pre-v3.1 errors that didn't include `kind` are inferred from the message and present optional fields.
- **`schemaConflict` is a new error category.** Returned from `register_schemas` when `version <= currentSchemaVersion`. The SDK's auto-register-on-handshake path catches it silently; manual `room.registerSchemas` callers should now handle `kind: "schemaConflict"`.
- **`AuthMsg`, `ReadyMsg`, `RegisterSchemasMsg`, `SchemasRegisteredMsg`, `ErrorMsg`, `SetIfMsg`, and `TransactOp.set_if` got new optional fields** (`schemaVersion`, `version`, `kind`, `ttl`, etc.). Older clients/servers continue to interoperate at the cost of the corresponding feature.

### Upgrading from v2.x

- **Auth moved out of the URL.** v2 sent `apiKey` and `persistence` as query-string params; v3 sends them as the first WebSocket frame (`{ op: "auth", apiKey, userId?, persistence? }`). The SDK does this automatically — no consumer change required, but custom protocol clients must update.
- **Persistence levels renamed.** `"memory"` → `"ephemeral"`, `"storage"` → `"durable"`. There is no compat alias; existing rooms persisted with the old names will fail to hydrate. Since v2.x was a brief release, this is expected to affect at most one consumer.
- **`get()` returns `{ value, rev }`** instead of `unknown`. Update call sites to destructure.
- **Change events carry `rev`.** Existing handlers continue to work (`event.rev` is just an extra field), but consumers wanting CAS can now read it directly.
- **`setIf` signature changed.** The third argument is now an options object: `setIf(key, value, { ifValue })` or `setIf(key, value, { ifRev })`. The old positional `setIf(key, value, ifValue)` no longer compiles.
- **`set` and `delete` return `{ rev }`.** Callers ignoring the return value continue to work.
- **`list()` filters out expired TTL keys** — closes a v2 correctness gap where expired keys could surface in list results between sweeps.
- **New methods**: `room.update`, `room.transact`, `room.count`, `room.reserve`, `room.subscribeWithSnapshotKey/Prefix`, `room.registerSchemas`. New constructor option `config.userId` and `options.schemas`.
- **`subscribePrefix` and `subscribeKey` accept `batchMs`** for server-side flow control on noisy prefixes.
- **TTL sweep is now O(log n)** via a sorted-by-expiry index — relevant only for rooms with many TTLs in flight.
