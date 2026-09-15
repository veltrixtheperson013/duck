import assert from "node:assert/strict";
import test from "node:test";
import { ClusterManager } from "../src/clusters.js";

function createClusterManager(envOverrides = {}, options = {}) {
  return new ClusterManager({
    env: {
      DUCK_CLUSTER_COUNT: "3",
      ...envOverrides,
    },
    startedAt: 1_000,
    now: () => 121_000,
    ...options,
  });
}

test("ClusterManager - Server ID Determinism & Assignments", async (t) => {
  await t.test("assigns server IDs deterministically and honors ID-only overrides", () => {
    const manager = createClusterManager(
      {
        DUCK_CLUSTER_COUNT: "4",
        DUCK_CLUSTER_ASSIGNMENTS: "123456789012345678=cluster-04",
      },
      { now: () => 61_000 }
    );

    assert.equal(manager.clusterIdForGuild("123456789012345678"), "cluster-04");

    const generated = manager.clusterIdForGuild("223456789012345678");
    assert.match(generated, /^cluster-0[1-4]$/);
    assert.equal(manager.clusterIdForGuild("223456789012345678"), generated);
  });

  await t.test("rejects invalid non-ID server strings on startup and lookup", () => {
    const manager = createClusterManager();

    assert.throws(
      () => manager.clusterIdForGuild("General Server"),
      /Discord server ID/
    );

    assert.throws(
      () =>
        new ClusterManager({
          env: { DUCK_CLUSTER_ASSIGNMENTS: "General=cluster-01" },
        }),
      /server IDs, not names/
    );
  });
});

test("ClusterManager - Health, Status, & Environment Parsing", async (t) => {
  await t.test("tracks server health, metrics, and uptime accurately", () => {
    const manager = createClusterManager({
      DUCK_CLUSTER_COUNT: "3",
      DUCK_CLUSTER_STATUS: "normal",
      DUCK_CLUSTER_STATUS_OVERRIDES: "cluster-02=maintenance,cluster-03=offline",
    });

    const clusters = manager.list(["123456789012345678", "223456789012345678"]);

    assert.deepEqual(
      clusters.map(({ id, status }) => [id, status]),
      [
        ["cluster-01", "normal"],
        ["cluster-02", "maintenance"],
        ["cluster-03", "offline"],
      ]
    );

    assert.equal(clusters[0].uptimeSeconds, 120);
    assert.equal(clusters[2].uptimeSeconds, 0);
    assert.equal(clusters[2].lastHeartbeatAt, null);
    assert.equal(
      clusters.reduce((sum, cluster) => sum + cluster.serverCount, 0),
      2
    );
  });

  await t.test("validates configuration boundary limits and invalid status strings", () => {
    const invalidConfigs = [
      {
        env: { DUCK_CLUSTER_COUNT: "2", DUCK_CLUSTER_STATUS_OVERRIDES: "cluster-03=normal" },
        error: /invalid cluster ID/,
      },
      {
        env: { DUCK_CLUSTER_STATUS: "hacked" },
        error: /must be normal/,
      },
      {
        env: { DUCK_CLUSTER_COUNT: "1000" },
        error: /integer from 1 to 32/,
      },
    ];

    for (const { env, error } of invalidConfigs) {
      assert.throws(() => new ClusterManager({ env }), error);
    }
  });
});

test("ClusterManager - Operator Actions & Runtime Changes", async (t) => {
  await t.test("allows runtime status modifications and assignment overrides", () => {
    const manager = createClusterManager({ DUCK_CLUSTER_COUNT: "3" });

    const statusResult = manager.setStatus("cluster-02", "maintenance");
    assert.equal(statusResult.status, "maintenance");

    const assignResult = manager.setAssignment("123456789012345678", "cluster-03");
    assert.equal(assignResult.id, "cluster-03");

    const clearedResult = manager.clearAssignment("123456789012345678");
    assert.match(clearedResult.id, /^cluster-0[1-3]$/);
  });

  await t.test("prevents operator updates with malformed parameters", () => {
    const manager = createClusterManager({ DUCK_CLUSTER_COUNT: "3" });

    assert.throws(
      () => manager.setAssignment("My Pond", "cluster-01"),
      /server ID/
    );

    assert.throws(
      () => manager.setStatus("cluster-99", "normal"),
      /invalid cluster ID/
    );
  });
});