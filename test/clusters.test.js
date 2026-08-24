import assert from "node:assert/strict";
import test from "node:test";
import { ClusterManager } from "../src/clusters.js";

test("clusters assign Discord server IDs deterministically and honor ID-only overrides", () => {
  const manager = new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "4", DUCK_CLUSTER_ASSIGNMENTS: "123456789012345678=cluster-04" }, startedAt: 1_000, now: () => 61_000 });
  assert.equal(manager.clusterIdForGuild("123456789012345678"), "cluster-04");
  const generated = manager.clusterIdForGuild("223456789012345678");
  assert.match(generated, /^cluster-0[1-4]$/);
  assert.equal(manager.clusterIdForGuild("223456789012345678"), generated);
  assert.throws(() => manager.clusterIdForGuild("General Server"), /Discord server ID/);
  assert.throws(() => new ClusterManager({ env: { DUCK_CLUSTER_ASSIGNMENTS: "General=cluster-01" } }), /server IDs, not names/);
});

test("cluster health is server-owned, bounded, and reports uptime", () => {
  const manager = new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "3", DUCK_CLUSTER_STATUS: "normal", DUCK_CLUSTER_STATUS_OVERRIDES: "cluster-02=maintenance,cluster-03=offline" }, startedAt: 1_000, now: () => 121_000 });
  const clusters = manager.list(["123456789012345678", "223456789012345678"]);
  assert.deepEqual(clusters.map(({ id, status }) => [id, status]), [["cluster-01", "normal"], ["cluster-02", "maintenance"], ["cluster-03", "offline"]]);
  assert.equal(clusters[0].uptimeSeconds, 120);
  assert.equal(clusters[2].uptimeSeconds, 0);
  assert.equal(clusters[2].lastHeartbeatAt, null);
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.serverCount, 0), 2);
  assert.throws(() => new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "2", DUCK_CLUSTER_STATUS_OVERRIDES: "cluster-03=normal" } }), /invalid cluster ID/);
  assert.throws(() => new ClusterManager({ env: { DUCK_CLUSTER_STATUS: "hacked" } }), /must be normal/);
  assert.throws(() => new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "1000" } }), /integer from 1 to 32/);
});

test("operator cluster changes remain ID-only and runtime bounded", () => {
  const manager = new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "3" } });
  assert.equal(manager.setStatus("cluster-02", "maintenance").status, "maintenance");
  assert.equal(manager.setAssignment("123456789012345678", "cluster-03").id, "cluster-03");
  assert.match(manager.clearAssignment("123456789012345678").id, /^cluster-0[1-3]$/);
  assert.throws(() => manager.setAssignment("My Pond", "cluster-01"), /server ID/);
  assert.throws(() => manager.setStatus("cluster-99", "normal"), /invalid cluster ID/);
});
