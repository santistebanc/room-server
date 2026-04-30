// Quick smoke test for v3.1 APIs against MockRoomClient.
// Run with: npx tsx scripts/smoke-v3.1.ts

import { MockRoomClient, resetMockRooms } from "../src/mock.js";
import { RoomError } from "../src/client.js";
import type { JsonSchema } from "../src/types.js";

interface Meta { title: string; version: number }
interface Vote { voterId: string; option: string }

interface Schema {
  meta: Meta;
  "votes/": Vote;
}

const META_SCHEMA: JsonSchema = {
  type: "object",
  required: ["title", "version"],
  properties: {
    title: { type: "string" },
    version: { type: "number" },
  },
};

const VOTE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["voterId", "option"],
  properties: {
    voterId: { type: "string" },
    option: { type: "string" },
  },
};

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log("ok  ", name); }
  else    { fail++; console.error("FAIL", name, detail ?? ""); }
}

async function main() {
  // Test 1: typed schema map narrows value types.
  resetMockRooms();
  const client1 = new MockRoomClient<Schema>({
    roomId: "r1",
    config: { apiKey: "k1" },
    schemas: {
      server: { meta: META_SCHEMA, "votes/": VOTE_SCHEMA },
      version: 1,
    },
  });
  await client1.ready();

  // Wait one tick for the auto-register handshake.
  await new Promise((r) => setTimeout(r, 10));
  check("auto-register sets schemaVersion", client1.schemaVersion === 1);

  // Test 2: reserve with TTL goes through.
  const reserved = await client1.reserve("meta", { title: "Poll", version: 1 }, { ttl: 60 });
  check("reserve(meta, ttl=60) → true", reserved === true);

  const reserved2 = await client1.reserve("meta", { title: "Other", version: 1 });
  check("reserve(meta) again → false", reserved2 === false);

  // Test 3: get returns typed value.
  const m = await client1.get("meta");
  check("get(meta).value.title", (m.value as Meta).title === "Poll");
  check("get(meta).rev > 0", m.rev > 0);

  // Test 4: schema conflict on stale version.
  const client2 = new MockRoomClient<Schema>({
    roomId: "r1",
    config: { apiKey: "k1" },
    schemas: {
      server: { meta: META_SCHEMA },
      version: 1,
    },
  });
  await client2.ready();
  await new Promise((r) => setTimeout(r, 10));
  // Trying to manually re-register at same version → schemaConflict.
  let conflictKind: string | null = null;
  try {
    await client2.registerSchemas({ meta: META_SCHEMA }, { version: 1 });
  } catch (e) {
    if (e instanceof RoomError) conflictKind = e.kind;
  }
  check("manual register at v1 (current=1) throws schemaConflict", conflictKind === "schemaConflict");

  // Test 5: bumping to v2 succeeds.
  const r = await client2.registerSchemas({ meta: META_SCHEMA, "votes/": VOTE_SCHEMA }, { version: 2 });
  check("register at v2 (current=1) succeeds", r.schemaVersion === 2);

  // Test 6: invalid validation throws RoomError.kind === "validation".
  let validationKind: string | null = null;
  try {
    await client1.set("meta", { title: 42, version: 1 } as unknown as Meta);
  } catch (e) {
    if (e instanceof RoomError) validationKind = e.kind;
  }
  check("set with bad schema throws kind=validation", validationKind === "validation");

  // Test 7: setIf with ttl on a fresh key.
  const ok = await client1.setIf("votes/v1", { voterId: "u1", option: "A" }, { ifRev: 0, ttl: 30 });
  check("setIf(votes/v1, ifRev=0, ttl=30) succeeds", ok.success === true);

  // Test 8: subscribeKey gets typed events.
  let lastChange: unknown = null;
  const unsub = client1.subscribeKey("meta", (e) => {
    if (e.type === "set") lastChange = e.value;
  }, { includeSelf: true });
  await client1.set("meta", { title: "Updated", version: 2 });
  await new Promise((r) => setTimeout(r, 10));
  check("subscribeKey delivers typed value", (lastChange as Meta)?.title === "Updated");
  unsub();

  // Test 9: subscribeWithSnapshotPrefix returns initial entries.
  await client1.set("votes/v2", { voterId: "u2", option: "B" });
  const result = await client1.subscribeWithSnapshotPrefix("votes/", () => {}, {});
  check("subscribeWithSnapshotPrefix returns initial", Object.keys(result.initial.entries).length >= 1);

  // Test 10: error kinds propagate from invalid usage.
  let kindCheck: string | null = null;
  try {
    await client1.setIf("meta", { title: "X", version: 1 }, { ifValue: { x: 1 }, ifRev: 0 });
  } catch (e) {
    if (e instanceof RoomError) kindCheck = e.kind;
  }
  check("setIf with both ifValue+ifRev → kind=invalid", kindCheck === "invalid");

  client1.disconnect();
  client2.disconnect();
  resetMockRooms();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
