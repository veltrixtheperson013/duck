import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { ChildControlPlane, canonical } from "../src/child-control.js";

function harness() {
  let now = 1_800_000_000_000;
  let state = { version: 1, workers: {}, enrollments: {}, clusterWorkers: {}, diagnostics: {} };
  const statuses = new Map();
  const clusterManager = { count: 2, describeCluster(id) { if (!/^cluster-0[12]$/.test(id)) throw new TypeError("bad cluster"); return { id, status: statuses.get(id) || "normal" }; }, setStatus(id, value) { statuses.set(id, value); return this.describeCluster(id); }, clusterIdForGuild(id) { return BigInt(id) % 2n ? "cluster-02" : "cluster-01"; } };
  const control = new ChildControlPlane({ clusterManager, now: () => now, readStateImpl: () => state, writeStateImpl: (next) => { state = next; }, operatorStateImpl: () => ({ clusterStatuses: {}, clusterAssignments: {} }), auditImpl: () => {} });
  return { control, clusterManager, state: () => state, tick: (ms) => { now += ms; }, now: () => now };
}

function enroll(h) {
  const enrollment = h.control.createEnrollment({ label: "test child" }); const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const worker = h.control.enroll({ token: enrollment.token, label: "test child", publicKey, version: "1.0.0" });
  return { ...worker, keys };
}

function signed(worker, h, pathname, body, nonce = randomBytes(18).toString("base64url")) {
  const timestamp = h.now(); const digest = createHash("sha256").update(canonical(body)).digest("hex"); const message = `POST\n${pathname}\n${timestamp}\n${nonce}\n${digest}`;
  const signature = sign(null, Buffer.from(message), worker.keys.privateKey).toString("base64url");
  return { method: "POST", pathname, body, headers: { "x-duck-child-id": worker.childId, "x-duck-child-time": String(timestamp), "x-duck-child-nonce": nonce, "x-duck-child-signature": signature } };
}

test("child enrollment is one-time and signed requests reject replay", () => {
  const h = harness(); const worker = enroll(h); const request = signed(worker, h, "/internal/children/heartbeat", {});
  assert.equal(h.control.verifyRequest(request).id, worker.childId); assert.throws(() => h.control.verifyRequest(request), /already used/);
  assert.throws(() => h.control.enroll({ token: "wrong", publicKey: "x" }), /invalid or expired/);
});

test("child authentication reports clock skew without widening the replay window", () => {
  const h = harness(); const worker = enroll(h); const request = signed(worker, h, "/internal/children/heartbeat", {});
  h.tick(60_001);
  assert.throws(
    () => h.control.verifyRequest(request),
    (error) => error.status === 401 && error.code === "child_clock_skew" && error.managerTime === h.now(),
  );
});

test("manager assigns allowlisted jobs and accepts leased results", async () => {
  const h = harness(); const worker = enroll(h); h.control.assign("cluster-01", worker.childId);
  h.control.heartbeat(h.state().workers[worker.childId], { metrics: { diskFreeMb: 4096, clockMs: h.now() }, version: "1.0.0" });
  const pending = h.control.dispatchGuild("100000000000000000", "cache.warm", {}, { timeoutMs: 5_000 }); const job = h.control.nextJob(h.state().workers[worker.childId]);
  assert.equal(job.type, "cache.warm"); h.control.submitResult(h.state().workers[worker.childId], { jobId: job.id, ok: true, result: { warmed: 1 }, durationMs: 2 });
  assert.deepEqual(await pending, { warmed: 1 }); assert.throws(() => h.control.createJob("cluster-01", "shell.exec", {}), /Unsupported/);
});

test("diagnostics mark sustained failures as outage and stale heartbeat offline", () => {
  const h = harness(); const worker = enroll(h); h.control.assign("cluster-01", worker.childId);
  h.control.heartbeat(h.state().workers[worker.childId], { metrics: { cpuPercent: 99, rssMb: 5000, diskFreeMb: 4096, clockMs: h.now() }, version: "1.0.0" });
  h.control.runDiagnostics("cluster-01"); h.control.runDiagnostics("cluster-01"); assert.equal(h.clusterManager.describeCluster("cluster-01").status, "outage");
  h.tick(61_000); h.control.runDiagnostics("cluster-01"); assert.equal(h.clusterManager.describeCluster("cluster-01").status, "offline");
});
