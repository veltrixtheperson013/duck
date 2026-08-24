import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createDuckOperatorServer, grantPlus } from "../src/admin.js";
import { ClusterManager } from "../src/clusters.js";

async function withOperator(run) {
  const token = "test_operator_token_that_is_longer_than_32_characters";
  const client = { guilds: { cache: new Map([["123456789012345678", { id: "123456789012345678", name: "Test Pond", memberCount: 42 }]]) } };
  const server = createDuckOperatorServer({ client, token, clusterManager: new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "2" } }), getGuildSettings: () => ({}), updateGuildSettings() {}, deleteGuildSettings() {} });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, token); }
  finally { clearInterval(server.operatorMaintenanceTimer); server.close(); await once(server, "close"); }
}

test("operator deck requires a strong token and protects every API", async () => {
  assert.throws(() => createDuckOperatorServer({ token: "too-short" }), /32 characters/);
  await withOperator(async (origin, token) => {
    const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /Duck Operator Deck/);
    assert.equal((await fetch(`${origin}/api/overview`)).status, 401);
    const overview = await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(overview.status, 200); const body = await overview.json(); assert.equal(body.guilds[0].id, "123456789012345678"); assert.equal(body.guilds[0].cluster.id.startsWith("cluster-"), true);
  });
});

test("operator Plus grants cannot overwrite active Stripe billing", () => {
  const updates = [];
  assert.throws(() => grantPlus("123456789012345678", "plus_3", null, () => ({ subscription: { provider: "stripe", tier: "plus", status: "active" } }), () => {}), /Stripe subscription/);
  const granted = grantPlus("123456789012345678", "plus_6", null, () => ({}), (id, patch) => updates.push([id, patch]));
  assert.equal(granted.levelOverride, "plus_6"); assert.equal(updates[0][0], "123456789012345678");
});
