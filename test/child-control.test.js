import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { ChildControlPlane, canonical } from "../src/child-control.js";


function createHarness() {
  let now = 1_800_000_000_000;
  let state = { version: 1, workers: {}, enrollments: {}, clusterWorkers: {}, diagnostics: {} };
  const statuses = new Map();

  const clusterManager = {
    count: 2,
    describeCluster(id) {
      if (!/^cluster-0[12]$/.test(id)) {
        throw new TypeError("bad cluster");
      }
      return { id, status: statuses.get(id) || "normal" };
    },
    setStatus(id, value) {
      statuses.set(id, value);
      return this.describeCluster(id);
    },
    clusterIdForGuild(id) {
      return BigInt(id) % 2n ? "cluster-02" : "cluster-01";
    },
  };

  const control = new ChildControlPlane({
    clusterManager,
    now: () => now,
    readStateImpl: () => state,
    writeStateImpl: (next) => {
      state = next;
    },
    operatorStateImpl: () => ({ clusterStatuses: {}, clusterAssignments: {} }),
    auditImpl: () => {},
  });

  return {
    control,
    clusterManager,
    getState: () => state,
    tick: (ms) => {
      now += ms;
    },
    getNow: () => now,
  };
}

function createEnrolledWorker(ctx, label = "test child") {
  const enrollment = ctx.control.createEnrollment({ label });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

  const worker = ctx.control.enroll({
    token: enrollment.token,
    label,
    publicKey,
    version: "1.0.0",
  });

  assert.match(worker.childId, /^child_[a-z0-9]{12}$/);
  assert.ok(ctx.getState().workers[worker.childId]);
  return { ...worker, keys };
}

/**
 * Generates an Ed25519-signed API request using the enrollment response.
 */
function createSignedRequest(
  worker,
  ctx,
  pathname,
  body,
  nonce = randomBytes(18).toString("base64url")
) {
  const timestamp = ctx.getNow();
  const digest = createHash("sha256").update(canonical(body)).digest("hex");
  const message = `POST\n${pathname}\n${timestamp}\n${nonce}\n${digest}`;
  
  const signature = sign(
    null,
    Buffer.from(message),
    worker.keys.privateKey
  ).toString("base64url");

  return {
    method: "POST",
    pathname,
    body,
    headers: {
      "x-duck-child-id": worker.childId,
      "x-duck-child-time": String(timestamp),
      "x-duck-child-nonce": nonce,
      "x-duck-child-signature": signature,
    },
  };
}

test("Child Control Plane - Security & Authentication", async (t) => {
  await t.test("enforces one-time enrollment and prevents request replays", () => {
    const ctx = createHarness();
    const worker = createEnrolledWorker(ctx);
    const request = createSignedRequest(worker, ctx, "/internal/children/heartbeat", {});

    assert.equal(ctx.control.verifyRequest(request).id, worker.childId);

    assert.throws(
      () => ctx.control.verifyRequest(request),
      /already used/
    );

    assert.throws(
      () => ctx.control.enroll({ token: "invalid-token", publicKey: "x" }),
      /invalid or expired/
    );
  });

  await t.test("reports clock skew without widening the replay window", () => {
    const ctx = createHarness();
    const worker = createEnrolledWorker(ctx);
    const request = createSignedRequest(worker, ctx, "/internal/children/heartbeat", {});

    ctx.tick(60_001);

    assert.throws(
      () => ctx.control.verifyRequest(request),
      (error) => 
        error.status === 401 &&
        error.code === "child_clock_skew" &&
        error.managerTime === ctx.getNow()
    );
  });
});

test("Child Control Plane - Job Management & Execution", async (t) => {
  await t.test("assigns allowlisted jobs and resolves leased results", async () => {
    const ctx = createHarness();
    const worker = createEnrolledWorker(ctx);

    ctx.control.assign("cluster-01", worker.childId);
    ctx.control.heartbeat(ctx.getState().workers[worker.childId], {
      metrics: { diskFreeMb: 4096, clockMs: ctx.getNow() },
      version: "1.0.0",
    });

    const pendingResult = ctx.control.dispatchGuild(
      "100000000000000000",
      "cache.warm",
      {},
      { timeoutMs: 5_000 }
    );

    const job = ctx.control.nextJob(ctx.getState().workers[worker.childId]);
    assert.equal(job.type, "cache.warm");

    ctx.control.submitResult(ctx.getState().workers[worker.childId], {
      jobId: job.id,
      ok: true,
      result: { warmed: 1 },
      durationMs: 2,
    });

    assert.deepEqual(await pendingResult, { warmed: 1 });

    assert.throws(
      () => ctx.control.createJob("cluster-01", "shell.exec", {}),
      /Unsupported/
    );
  });
});

test("Child Control Plane - Cluster Diagnostics & Status Reporting", async (t) => {
  await t.test("transitions status to outage on sustained failures and offline on stale heartbeats", () => {
    const ctx = createHarness();
    const worker = createEnrolledWorker(ctx);

    ctx.control.assign("cluster-01", worker.childId);
    ctx.control.heartbeat(ctx.getState().workers[worker.childId], {
      metrics: { cpuPercent: 99, rssMb: 5000, diskFreeMb: 4096, clockMs: ctx.getNow() },
      version: "1.0.0",
    });

    ctx.control.runDiagnostics("cluster-01");
    ctx.control.runDiagnostics("cluster-01");
    assert.equal(ctx.clusterManager.describeCluster("cluster-01").status, "outage");

    ctx.tick(61_000);
    ctx.control.runDiagnostics("cluster-01");
    assert.equal(ctx.clusterManager.describeCluster("cluster-01").status, "offline");
  });
});