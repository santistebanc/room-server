// Compile-time type-inference smoke test for v3.1.
// `npx tsc --noEmit scripts/smoke-v3.1-types.ts` should report 0 errors.
// The negative cases below are commented out; uncomment them and the file
// should fail to compile with the expected diagnostics.

import { MockRoomClient } from "../src/mock.js";

interface Meta { title: string; version: number }
interface Settings { tally: "borda" | "copeland" }
interface Vote { voterId: string; option: string }

interface Schema {
  meta: Meta;
  settings: Settings;
  "votes/": Vote;
}

async function check() {
  const client = new MockRoomClient<Schema>({
    roomId: "r",
    config: { apiKey: "k" },
  });
  await client.ready();

  await client.set("meta", { title: "P", version: 1 });
  await client.set("settings", { tally: "borda" });
  await client.set("votes/v1", { voterId: "u1", option: "A" });

  const m = await client.get("meta");
  const t: string = m.value?.title ?? "";
  void t;

  await client.update("meta", (current) => ({
    title: current?.title ?? "Default",
    version: (current?.version ?? 0) + 1,
  }));

  client.subscribeKey("meta", (e) => {
    if (e.type === "set") {
      const v: Meta = e.value;
      void v;
    }
  });

  client.subscribePrefix("votes/", (e) => {
    if (e.type === "set") {
      const v: Vote = e.value;
      void v;
    }
  });

  await client.reserve("meta", { title: "X", version: 1 }, { ttl: 30 });

  await client.setIf("votes/v2", { voterId: "u", option: "B" }, { ifRev: 0, ttl: 60 });

  // Negative cases (should all be type errors if uncommented):
  // await client.set("meta", { title: 42 } as unknown as Meta); // wrong shape
  // await client.set("metaa", { title: "x", version: 1 });       // typo: not in schema (would be `unknown`, OK)
  // client.subscribeKey("meta", (e) => { if (e.type === "set") { const v: Vote = e.value; void v; } }); // wrong narrow
}

void check;
