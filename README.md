# room-server

Generic PartyKit backend for realtime key/value state.

Use it when you want:
- realtime updates via subscriptions
- atomic key operations
- presence + broadcast
- optional TTL and schema validation

## Quick start

```bash
git clone <this-repo>
cd room-server
npm install
npm run deploy
```

Your server URL will look like:

`https://room-server.<your-username>.partykit.dev`

### Optional: restrict API keys

If you skip this, the server runs in open mode (good for local/dev).

```bash
npx partykit env add ALLOWED_KEYS
# comma-separated, example: key-app1,key-app2
```

## Client install

```bash
npm install github:santistebanc/room-server
```

## Connect

```ts
import { RoomClient } from "room-server/client";

const room = new RoomClient({
  host: "room-server.<your-username>.partykit.dev",
  roomId: "my-room",
  config: {
    apiKey: "key-app1",
    userId: "alice", // optional
    persistence: "durable", // "durable" (default) | "ephemeral"
  },
});

await room.ready();
```

## Features (concise, complete)

- **Core KV:** `set`, `get`, `delete`, `list`, `count`, `deletePrefix`, `snapshot`
- **Atomic ops:** `setIf` (CAS by value/rev), `increment`, `update` (retrying RMW), `reserve`, `transact`
- **TTL:** per-key expiry on writes, plus `touch` to refresh TTL
- **Realtime subscriptions:** key/prefix subscriptions, snapshot+subscribe variants, batching (`batchMs`), optional self-events (`includeSelf`)
- **Presence:** per-connection user presence and helpers for online-user state
- **Broadcast:** pub/sub style room channels via `broadcast` + `onBroadcast`
- **Schema validation:** optional server/client schema registration, versioned schema handshake, conflict protection
- **Connection lifecycle:** auto-reconnect, status events, `disconnect`, `flushAndDisconnect`
- **Persistence modes:** `durable` (default) and `ephemeral`
- **Scheduling:** one-shot and recurring alarm actions
- **Protocol options:** SDK + raw WebSocket wire protocol + REST endpoints
- **Testing:** `MockRoomClient` for deterministic local/unit tests

## API snippets (small + complete)

```ts
// Core KV
await room.set("users/alice", { name: "Alice" });
await room.set("session/abc", { userId: "alice" }, { ttl: 3600 });
const { value, rev } = await room.get("users/alice");
await room.delete("users/alice");
const { entries, nextCursor } = await room.list("users/", { limit: 20 });
const { count } = await room.count("users/");
await room.touch("session/abc", { ttl: 3600 });
await room.deletePrefix("users/");
const snap = await room.snapshot({ keys: ["meta"], prefixes: ["users/"] });

// Atomic ops
const { value: n } = await room.increment("stats/views", 1);
const cas = await room.setIf("lock", "alice", { ifValue: null });
const updated = await room.update<number>("counter", (cur) => (cur ?? 0) + 1);
const won = await room.reserve("meta", { createdAt: Date.now() }, { ttl: 86400 });
const tx = await room.transact([
  { op: "set", key: "users/alice", value: { online: true } },
  { op: "increment", key: "stats/joins", delta: 1 },
]);

// Realtime subscriptions
const offKey = room.subscribeKey("meta", (e) => console.log(e.type, e.value));
const offPrefix = room.subscribePrefix("users/", (e) => console.log(e.key, e.value), { batchMs: 50 });
const { initial: k0, unsubscribe: offSnapKey } = await room.subscribeWithSnapshotKey("meta", () => {});
const { initial: p0, unsubscribe: offSnapPrefix } = await room.subscribeWithSnapshotPrefix("users/", () => {});

// Presence (derived from reserved `presence/` keys)
const offPresence = room.subscribePrefix("presence/", (e) => console.log(e.key, e.value));

// Broadcast
const offChat = room.onBroadcast("chat", (msg) => console.log("chat", msg));
room.broadcast("chat", { text: "hello" });

// Schema registration (optional)
await room.registerSchemas(
  { "users/": { type: "object", properties: { name: { type: "string" } }, additionalProperties: true } },
  { version: 1 }
);

// Scheduled jobs
await room.scheduleAlarm(60, { type: "broadcast", channel: "chat", data: { text: "tick" } });
await room.cancelAlarm();
await room.scheduleRecurring(300, { type: "broadcast", channel: "chat", data: { text: "heartbeat" } });
await room.cancelRecurring();

// Connection lifecycle
const offStatus = room.on("status", (s) => console.log("status", s));
await room.flushAndDisconnect(5000);
room.disconnect();

// cleanup
offKey(); offPrefix(); offSnapKey(); offSnapPrefix(); offPresence(); offChat(); offStatus();
```

## Run locally

```bash
# terminal 1
npm run dev

# terminal 2
cd example
npm install
npm run dev
```

Server: `http://localhost:1999`  
Example app: `http://localhost:5173`

## Notes

- `roomId` isolates data per room.
- `apiKey` isolates app namespaces.
- Auth happens in the first WebSocket message (not in URL query params).
