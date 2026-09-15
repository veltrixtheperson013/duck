import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "./config.js";
import { getClusterManager } from "./clusters.js";
import { getOperatorState, recordOperatorAction } from "./operator-state.js";

const WORKER_NODE_ID_REGEX = /^child_[a-z0-9]{12}$/;
const CLUSTER_ID_REGEX = /^cluster-\d{2}$/;
const DISCORD_ID_REGEX = /^\d{10,20}$/;

const SUPPORTED_JOB_TYPES = new Set([
  "ai.scan",
  "tts.flux",
  "cache.clear",
  "cache.warm",
  "diagnostic.full",
  "config.sync",
  "config.validate",
  "logs.snapshot",
  "worker.restart",
]);

const CONTROL_PLANE_JOBS = new Set([
  "cache.clear",
  "cache.warm",
  "diagnostic.full",
  "config.sync",
  "config.validate",
  "logs.snapshot",
  "worker.restart",
]);

const STATE_FILE_PATH = path.join(process.cwd(), "data", "children.json");

function cleanString(value, maximumLength = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function isBoundedPlainObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !Object.keys(value).some((key) => ["__proto__", "prototype", "constructor"].includes(key))
  );
}

function createFreshState() {
  return {
    version: 1,
    workers: {},
    enrollments: {},
    clusterWorkers: {},
    diagnostics: {},
  };
}

function loadControlPlaneState() {
  const fileData = loadJsonFile(STATE_FILE_PATH, createFreshState());
  const state = isBoundedPlainObject(fileData) ? fileData : createFreshState();

  state.workers = isBoundedPlainObject(state.workers) ? state.workers : {};
  state.enrollments = isBoundedPlainObject(state.enrollments) ? state.enrollments : {};
  state.clusterWorkers = isBoundedPlainObject(state.clusterWorkers) ? state.clusterWorkers : {};
  state.diagnostics = isBoundedPlainObject(state.diagnostics) ? state.diagnostics : {};

  return state;
}

function persistControlPlaneState(state) {
  saveJsonFile(STATE_FILE_PATH, state);
}

function formatPublicWorker(worker, runtimeMetrics = null) {
  return {
    id: worker.id,
    label: worker.label,
    fingerprint: worker.fingerprint,
    enrolledAt: worker.enrolledAt,
    version: runtimeMetrics?.version || worker.version || "unknown",
    commit: runtimeMetrics?.commit || worker.commit || null,
    lastHeartbeatAt: runtimeMetrics?.receivedAt || worker.lastHeartbeatAt || null,
    status: worker.revokedAt
      ? "revoked"
      : worker.quarantinedAt
      ? "quarantined"
      : runtimeMetrics?.status || "offline",
    quarantinedAt: worker.quarantinedAt || null,
    revokedAt: worker.revokedAt || null,
    address: worker.address || null,
  };
}

function normalizeWorkerMetrics(input = {}) {
  const clampNumber = (key, min, max) =>
    Math.max(min, Math.min(Number(input[key]) || 0, max));

  return {
    cpuPercent: clampNumber("cpuPercent", 0, 100),
    rssMb: clampNumber("rssMb", 0, 1_000_000),
    heapMb: clampNumber("heapMb", 0, 1_000_000),
    diskFreeMb: clampNumber("diskFreeMb", 0, 1_000_000_000),
    eventLoopLagMs: clampNumber("eventLoopLagMs", 0, 60_000),
    queueDepth: clampNumber("queueDepth", 0, 100_000),
    oldestJobMs: clampNumber("oldestJobMs", 0, 86_400_000),
    errorRate: clampNumber("errorRate", 0, 1),
    p95LatencyMs: clampNumber("p95LatencyMs", 0, 600_000),
    cacheHitRate: clampNumber("cacheHitRate", 0, 1),
    cacheItems: clampNumber("cacheItems", 0, 1_000_000),
    restartCount: clampNumber("restartCount", 0, 1_000_000),
    configGeneration: cleanString(input.configGeneration, 80),
    clockMs: Number.isFinite(Number(input.clockMs)) ? Number(input.clockMs) : Date.now(),
    activeJobs: clampNumber("activeJobs", 0, 10_000),
  };
}

class ClusterControlPlane {
  constructor({
    clusterManager = getClusterManager(),
    client = null,
    now = () => Date.now(),
    diagnosticIntervalMs = 30 * 60_000,
    readStateImpl = loadControlPlaneState,
    writeStateImpl = persistControlPlaneState,
    operatorStateImpl = getOperatorState,
    auditImpl = recordOperatorAction,
  } = {}) {
    this.clusterManager = clusterManager;
    this.client = client;
    this.now = now;
    this.diagnosticIntervalMs = Math.max(60_000, Number(diagnosticIntervalMs) || 30 * 60_000);
    this.readState = readStateImpl;
    this.writeState = writeStateImpl;
    this.operatorState = operatorStateImpl;
    this.audit = auditImpl;

    this.runtime = new Map();
    this.nonces = new Map();
    this.jobs = new Map();
    this.jobQueues = new Map();
    this.jobWaiters = new Map();
    this.drained = new Set();
    this.diagnosticTimer = null;
    this.lastFullDiagnosticsAt = null;
  }

  configure({ client } = {}) {
    if (client) this.client = client;
    return this;
  }

  start() {
    if (this.diagnosticTimer) return;
    const executeDiagnostics = () => this.runAllDiagnostics().catch(() => {});
    this.diagnosticTimer = setInterval(executeDiagnostics, this.diagnosticIntervalMs);
    this.diagnosticTimer.unref?.();

    const initialTimer = setTimeout(executeDiagnostics, 10_000);
    initialTimer.unref?.();
  }

  stop() {
    if (this.diagnosticTimer) clearInterval(this.diagnosticTimer);
    this.diagnosticTimer = null;
  }

  createEnrollment({ label = "Ubuntu node", expiresMinutes = 15 } = {}) {
    const token = `duck_child_${randomBytes(32).toString("base64url")}`;
    const state = this.readState();
    const enrollmentId = `enroll_${randomBytes(8).toString("hex")}`;

    state.enrollments[enrollmentId] = {
      tokenHash: sha256Hex(token),
      label: cleanString(label, 80) || "Ubuntu node",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(
        this.now() + Math.max(5, Math.min(Number(expiresMinutes) || 15, 60)) * 60_000
      ).toISOString(),
      usedAt: null,
    };

    for (const [key, item] of Object.entries(state.enrollments)) {
      if (Date.parse(item.expiresAt || "") < this.now() - 86_400_000 || item.usedAt) {
        delete state.enrollments[key];
      }
    }

    this.writeState(state);
    return { enrollmentId, token, expiresAt: state.enrollments[enrollmentId].expiresAt };
  }

  enroll(input, address = null) {
    if (
      !isBoundedPlainObject(input) ||
      Object.keys(input).some(
        (key) => !["token", "label", "publicKey", "version", "commit"].includes(key)
      )
    ) {
      throw Object.assign(new Error("Invalid worker enrollment request."), { status: 400 });
    }

    const state = this.readState();
    const tokenHash = sha256Hex(input.token);
    const enrollment = Object.values(state.enrollments).find(
      (item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > this.now()
    );

    if (!enrollment) {
      throw Object.assign(new Error("Worker enrollment token is invalid or expired."), {
        status: 403,
      });
    }

    const publicKey = String(input.publicKey || "");
    if (publicKey.length < 40 || publicKey.length > 1_000) {
      throw Object.assign(new Error("Worker public key is invalid."), { status: 400 });
    }

    let parsedKey;
    try {
      parsedKey = createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      throw Object.assign(new Error("Worker public key could not be parsed."), { status: 400 });
    }

    if (parsedKey.asymmetricKeyType !== "ed25519") {
      throw Object.assign(new Error("Worker identity must use Ed25519."), { status: 400 });
    }

    const workerId = `child_${randomBytes(9)
      .toString("base64url")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .padEnd(12, "0")
      .slice(0, 12)}`;

    enrollment.usedAt = new Date(this.now()).toISOString();

    state.workers[workerId] = {
      id: workerId,
      label: cleanString(input.label || enrollment.label, 80) || enrollment.label,
      publicKey,
      fingerprint: sha256Hex(publicKey).slice(0, 16),
      version: cleanString(input.version, 40) || "unknown",
      commit: /^[a-f0-9]{7,40}$/.test(String(input.commit || ""))
        ? String(input.commit)
        : null,
      address: cleanString(address, 100) || null,
      enrolledAt: enrollment.usedAt,
      lastHeartbeatAt: null,
      quarantinedAt: null,
      revokedAt: null,
    };

    this.writeState(state);
    this.audit("worker.enrolled", {
      actorId: workerId,
      target: workerId,
      reason: `Worker node ${state.workers[workerId].label} enrolled`,
    });

    return {
      childId: workerId,
      managerTime: this.now(),
      heartbeatIntervalMs: 15_000,
      protocolVersion: 1,
    };
  }

  verifyRequest({ method, pathname, headers, body }) {
    const workerId = String(headers["x-duck-child-id"] || "");
    const timestamp = Number(headers["x-duck-child-time"]);
    const nonce = String(headers["x-duck-child-nonce"] || "");
    const signature = String(headers["x-duck-child-signature"] || "");

    if (
      !WORKER_NODE_ID_REGEX.test(workerId) ||
      !Number.isSafeInteger(timestamp) ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(nonce) ||
      !/^[A-Za-z0-9_-]{40,200}$/.test(signature)
    ) {
      throw Object.assign(new Error("Worker request authentication failed."), {
        status: 401,
        code: "child_auth_malformed",
      });
    }

    if (Math.abs(this.now() - timestamp) > 60_000) {
      throw Object.assign(new Error("Worker request clock is out of sync."), {
        status: 401,
        code: "child_clock_skew",
        managerTime: this.now(),
      });
    }

    const state = this.readState();
    const worker = state.workers[workerId];
    if (!worker || worker.revokedAt || worker.quarantinedAt) {
      throw Object.assign(new Error("Worker node is not active."), { status: 403 });
    }

    let seenNonces = this.nonces.get(workerId);
    if (!seenNonces) {
      seenNonces = new Map();
      this.nonces.set(workerId, seenNonces);
    }

    for (const [key, usedAt] of seenNonces) {
      if (usedAt < this.now() - 120_000) seenNonces.delete(key);
    }

    if (seenNonces.has(nonce)) {
      throw Object.assign(new Error("Worker request nonce already used."), { status: 409 });
    }

    const payloadDigest = sha256Hex(canonicalize(body));
    const signingMessage = `${String(method).toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${payloadDigest}`;

    let isValidSignature = false;
    try {
      isValidSignature = verifySignature(
        null,
        Buffer.from(signingMessage),
        createPublicKey({
          key: Buffer.from(worker.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(signature, "base64url")
      );
    } catch {
      isValidSignature = false;
    }

    if (!isValidSignature) {
      throw Object.assign(new Error("Worker request signature is invalid."), {
        status: 401,
        code: "child_signature_invalid",
      });
    }

    seenNonces.set(nonce, this.now());
    return worker;
  }

  heartbeat(worker, input) {
    if (
      !isBoundedPlainObject(input) ||
      Object.keys(input).some(
        (key) => !["metrics", "version", "commit", "startedAt", "configGeneration"].includes(key)
      )
    ) {
      throw Object.assign(new Error("Invalid heartbeat payload."), { status: 400 });
    }

    const metrics = normalizeWorkerMetrics({ ...input.metrics, configGeneration: input.configGeneration });
    const receivedAt = new Date(this.now()).toISOString();
    const previous = this.runtime.get(worker.id);

    this.runtime.set(worker.id, {
      metrics,
      receivedAt,
      status: "online",
      version: cleanString(input.version, 40) || worker.version,
      commit: /^[a-f0-9]{7,40}$/.test(String(input.commit || ""))
        ? String(input.commit)
        : worker.commit,
      startedAt: cleanString(input.startedAt, 40),
      lastLatencyMs: Math.abs(this.now() - metrics.clockMs),
      heartbeatCount: (previous?.heartbeatCount || 0) + 1,
    });

    return {
      ok: true,
      managerTime: this.now(),
      nextHeartbeatMs: 15_000,
      assignedClusters: this.assignedClusters(worker.id),
      drainedClusters: [...this.drained].filter((id) => this.workerForCluster(id)?.id === worker.id),
    };
  }

  listWorkers() {
    const state = this.readState();
    return Object.values(state.workers).map((worker) =>
      formatPublicWorker(worker, this.runtime.get(worker.id))
    );
  }

  workerForCluster(clusterId) {
    if (!CLUSTER_ID_REGEX.test(String(clusterId || ""))) {
      throw new TypeError("Provide a valid cluster ID.");
    }
    const state = this.readState();
    const worker = state.workers[state.clusterWorkers[clusterId]];
    return worker && !worker.revokedAt && !worker.quarantinedAt
      ? formatPublicWorker(worker, this.runtime.get(worker.id))
      : null;
  }

  assignedClusters(workerId) {
    const state = this.readState();
    return Object.entries(state.clusterWorkers)
      .filter(([, id]) => id === workerId)
      .map(([clusterId]) => clusterId);
  }

  assign(clusterId, workerId) {
    this.clusterManager.describeCluster(clusterId);
    if (!WORKER_NODE_ID_REGEX.test(String(workerId || ""))) {
      throw new TypeError("Provide a valid worker ID.");
    }

    const state = this.readState();
    const worker = state.workers[workerId];
    if (!worker || worker.revokedAt || worker.quarantinedAt) {
      throw new TypeError("Selected worker node is not active.");
    }

    state.clusterWorkers[clusterId] = workerId;
    this.writeState(state);
    return { clusterId, worker: formatPublicWorker(worker, this.runtime.get(workerId)) };
  }

  unassign(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    const state = this.readState();
    const existed = Boolean(state.clusterWorkers[clusterId]);
    delete state.clusterWorkers[clusterId];
    this.writeState(state);
    return { clusterId, removed: existed };
  }

  quarantine(workerId, reason = "Operator action") {
    const state = this.readState();
    const worker = state.workers[workerId];
    if (!worker) throw new TypeError("Worker node was not found.");

    worker.quarantinedAt = new Date(this.now()).toISOString();
    worker.quarantineReason = cleanString(reason, 240);

    for (const [clusterId, id] of Object.entries(state.clusterWorkers)) {
      if (id === workerId) delete state.clusterWorkers[clusterId];
    }

    this.writeState(state);
    return formatPublicWorker(worker, this.runtime.get(workerId));
  }

  revoke(workerId, reason = "Operator action") {
    const state = this.readState();
    const worker = state.workers[workerId];
    if (!worker) throw new TypeError("Worker node was not found.");

    worker.revokedAt = new Date(this.now()).toISOString();
    worker.revokeReason = cleanString(reason, 240);

    for (const [clusterId, id] of Object.entries(state.clusterWorkers)) {
      if (id === workerId) delete state.clusterWorkers[clusterId];
    }

    this.writeState(state);
    this.runtime.delete(workerId);
    return formatPublicWorker(worker);
  }

  queueFor(workerId) {
    let queue = this.jobQueues.get(workerId);
    if (!queue) {
      queue = [];
      this.jobQueues.set(workerId, queue);
    }
    return queue;
  }

  createJob(clusterId, type, payload = {}, { timeoutMs = 30_000, waitForResult = false } = {}) {
    this.clusterManager.describeCluster(clusterId);
    if (!SUPPORTED_JOB_TYPES.has(type)) throw new TypeError("Unsupported cluster job type.");
    if (!isBoundedPlainObject(payload) || Buffer.byteLength(canonicalize(payload)) > 256 * 1024) {
      throw new TypeError("Job payload is invalid or exceeds 256KB.");
    }

    if (this.drained.has(clusterId) && !CONTROL_PLANE_JOBS.has(type)) return null;

    const worker = this.workerForCluster(clusterId);
    if (!worker || !["online", "degraded"].includes(worker.status)) return null;

    const queue = this.queueFor(worker.id);
    if (queue.length >= 100) {
      throw Object.assign(new Error("Worker node job queue is full."), { status: 429 });
    }

    const job = {
      id: `job_${randomBytes(12).toString("hex")}`,
      workerId: worker.id,
      clusterId,
      type,
      payload,
      createdAt: new Date(this.now()).toISOString(),
      deadlineAt: new Date(
        this.now() + Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 120_000))
      ).toISOString(),
      status: "queued",
      attempts: 0,
      leaseUntil: null,
    };

    this.jobs.set(job.id, job);
    queue.push(job.id);

    if (!waitForResult) return { ...job, payload: undefined };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobWaiters.delete(job.id);
        job.status = "expired";
        reject(Object.assign(new Error("Worker job timed out."), { code: "child_timeout" }));
      }, timeoutMs);

      timer.unref?.();
      this.jobWaiters.set(job.id, { resolve, reject, timer });
    });
  }

  dispatchGuild(guildId, type, payload, options = {}) {
    if (!DISCORD_ID_REGEX.test(String(guildId || ""))) {
      throw new TypeError("Guild ID must be a valid Discord server ID.");
    }
    return this.createJob(
      this.clusterManager.clusterIdForGuild(guildId),
      type,
      payload,
      { ...options, waitForResult: true }
    );
  }

  nextJob(worker) {
    const queue = this.queueFor(worker.id);
    const now = this.now();

    for (const job of this.jobs.values()) {
      if (
        job.workerId === worker.id &&
        job.status === "leased" &&
        Date.parse(job.leaseUntil) <= now &&
        job.attempts < 3
      ) {
        job.status = "queued";
        queue.push(job.id);
      }
    }

    while (queue.length) {
      const id = queue.shift();
      const job = this.jobs.get(id);

      if (!job || job.status !== "queued" || Date.parse(job.deadlineAt) <= now) continue;

      job.status = "leased";
      job.attempts += 1;
      job.leaseUntil = new Date(now + 30_000).toISOString();

      return {
        id: job.id,
        clusterId: job.clusterId,
        type: job.type,
        payload: job.payload,
        deadlineAt: job.deadlineAt,
        attempt: job.attempts,
      };
    }

    return null;
  }

  submitResult(worker, input) {
    if (
      !isBoundedPlainObject(input) ||
      Object.keys(input).some(
        (key) => !["jobId", "ok", "result", "error", "durationMs"].includes(key)
      )
    ) {
      throw Object.assign(new Error("Invalid job completion input."), { status: 400 });
    }

    const job = this.jobs.get(String(input.jobId || ""));
    if (!job || job.workerId !== worker.id || job.status !== "leased") {
      throw Object.assign(new Error("Job missing or lease expired."), { status: 409 });
    }

    const waiter = this.jobWaiters.get(job.id);
    job.status = input.ok === true ? "completed" : "failed";
    job.completedAt = new Date(this.now()).toISOString();
    job.durationMs = Math.max(0, Math.min(Number(input.durationMs) || 0, 600_000));
    job.error = cleanString(input.error, 300) || null;

    if (waiter) {
      clearTimeout(waiter.timer);
      this.jobWaiters.delete(job.id);
      if (input.ok === true) {
        waiter.resolve(input.result);
      } else {
        waiter.reject(
          Object.assign(new Error(job.error || "Worker job failed."), { code: "child_failed" })
        );
      }
    }

    if (this.jobs.size > 2_000) {
      for (const [id, item] of this.jobs) {
        if (["completed", "failed", "expired", "canceled"].includes(item.status)) {
          this.jobs.delete(id);
          if (this.jobs.size <= 1_500) break;
        }
      }
    }

    return { accepted: true };
  }

  drain(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    this.drained.add(clusterId);
    return { clusterId, drained: true };
  }

  resume(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    this.drained.delete(clusterId);
    return { clusterId, drained: false };
  }

  cancelExpired(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    let canceled = 0;
    const now = this.now();

    for (const job of this.jobs.values()) {
      if (
        job.clusterId === clusterId &&
        ["queued", "leased"].includes(job.status) &&
        Date.parse(job.deadlineAt) <= now
      ) {
        job.status = "canceled";
        canceled += 1;
      }
    }

    return { clusterId, canceled };
  }

  retryFailed(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    let retried = 0;

    for (const job of this.jobs.values()) {
      if (
        job.clusterId === clusterId &&
        CONTROL_PLANE_JOBS.has(job.type) &&
        job.status === "failed" &&
        job.attempts < 3
      ) {
        job.status = "queued";
        this.queueFor(job.workerId).push(job.id);
        retried += 1;
      }
    }

    return { clusterId, retried };
  }

  diagnosticChecks(clusterId) {
    const worker = this.workerForCluster(clusterId);
    const runtime = worker ? this.runtime.get(worker.id) : null;
    const metrics = runtime?.metrics || {};
    const heartbeatAgeMs = runtime ? this.now() - Date.parse(runtime.receivedAt) : Infinity;

    const clusterJobs = [...this.jobs.values()].filter((job) => job.clusterId === clusterId);
    const queuedJobs = clusterJobs.filter((job) => ["queued", "leased"].includes(job.status));
    const completedJobs = clusterJobs.filter((job) => ["completed", "failed"].includes(job.status));
    const failures = completedJobs.filter((job) => job.status === "failed").length;

    const checks = [
      ["worker_assignment", Boolean(worker), "No worker assigned; fallback active"],
      [
        "heartbeat",
        heartbeatAgeMs < 45_000,
        Number.isFinite(heartbeatAgeMs) ? `${Math.round(heartbeatAgeMs)}ms old` : "No heartbeat",
      ],
      [
        "manager_latency",
        (runtime?.lastLatencyMs || 0) < 5_000,
        `${runtime?.lastLatencyMs || 0}ms clock delta`,
      ],
      ["cpu", (metrics.cpuPercent || 0) < 90, `${metrics.cpuPercent || 0}%`],
      ["memory", (metrics.rssMb || 0) < 1_800, `${metrics.rssMb || 0} MB RSS`],
      ["heap", (metrics.heapMb || 0) < 1_400, `${metrics.heapMb || 0} MB heap`],
      ["disk", !worker || (metrics.diskFreeMb || 0) > 256, `${metrics.diskFreeMb || 0} MB free`],
      ["event_loop", (metrics.eventLoopLagMs || 0) < 500, `${metrics.eventLoopLagMs || 0}ms lag`],
      [
        "queue_depth",
        queuedJobs.length < 80 && (metrics.queueDepth || 0) < 80,
        `${queuedJobs.length + (metrics.queueDepth || 0)} queued`,
      ],
      ["oldest_job", (metrics.oldestJobMs || 0) < 60_000, `${metrics.oldestJobMs || 0}ms`],
      [
        "job_errors",
        completedJobs.length < 5 || failures / completedJobs.length < 0.35,
        `${failures}/${completedJobs.length} recent failures`,
      ],
      ["p95_latency", (metrics.p95LatencyMs || 0) < 30_000, `${metrics.p95LatencyMs || 0}ms`],
      ["cache_health", (metrics.cacheItems || 0) < 100_000, `${metrics.cacheItems || 0} cached items`],
      [
        "clock_sync",
        Math.abs((metrics.clockMs || this.now()) - this.now()) < 30_000,
        `${Math.round(Math.abs((metrics.clockMs || this.now()) - this.now()))}ms drift`,
      ],
      ["version", !worker || worker.version !== "unknown", worker?.version || "host fallback"],
      ["restart_stability", (metrics.restartCount || 0) < 10, `${metrics.restartCount || 0} restarts`],
      [
        "config_sync",
        !metrics.configGeneration ||
          metrics.configGeneration ===
            sha256Hex(canonicalize(this.operatorState().clusterAssignments)).slice(0, 16),
        metrics.configGeneration || "not reported",
      ],
      [
        "stuck_leases",
        !clusterJobs.some(
          (job) => job.status === "leased" && Date.parse(job.leaseUntil) < this.now()
        ),
        "Lease scan complete",
      ],
    ].map(([id, ok, detail]) => ({ id, ok: Boolean(ok), detail: cleanString(detail, 160) }));

    const hardFailure = !worker ? false : heartbeatAgeMs >= 60_000;
    const issueCount = checks.filter((check) => !check.ok && check.id !== "worker_assignment").length;

    return {
      clusterId,
      worker,
      checkedAt: new Date(this.now()).toISOString(),
      checks,
      issueCount,
      hardFailure,
      queuedJobs: queuedJobs.length,
      drained: this.drained.has(clusterId),
    };
  }

  runDiagnostics(clusterId, { automatic = false } = {}) {
    const report = this.diagnosticChecks(clusterId);
    const state = this.readState();
    const previous = state.diagnostics[clusterId] || {};

    const failing = report.hardFailure || report.issueCount >= 2;
    const consecutiveFailures = failing ? (Number(previous.consecutiveFailures) || 0) + 1 : 0;
    const consecutivePasses = failing ? 0 : (Number(previous.consecutivePasses) || 0) + 1;

    const manualStatus = this.operatorState().clusterStatuses[clusterId];
    let automaticStatus = previous.automaticStatus || "normal";

    if (!manualStatus) {
      if (report.hardFailure) automaticStatus = "offline";
      else if (consecutiveFailures >= 2) automaticStatus = "outage";
      else if (consecutivePasses >= 2) automaticStatus = "normal";

      this.clusterManager.setStatus(clusterId, automaticStatus);
    }

    state.diagnostics[clusterId] = {
      ...report,
      consecutiveFailures,
      consecutivePasses,
      automaticStatus,
      automatic,
      history: [
        {
          checkedAt: report.checkedAt,
          issueCount: report.issueCount,
          status: manualStatus || automaticStatus,
        },
        ...(Array.isArray(previous.history) ? previous.history : []),
      ].slice(0, 48),
    };

    this.writeState(state);

    if ((previous.automaticStatus || "normal") !== automaticStatus) {
      this.audit("cluster.automatic-status", {
        actorId: "diagnostic-engine",
        target: clusterId,
        reason: `Status changed to ${automaticStatus} after ${report.issueCount} issue(s)`,
      });
    }

    return state.diagnostics[clusterId];
  }

  async runAllDiagnostics() {
    const reports = [];
    for (let index = 0; index < this.clusterManager.count; index += 1) {
      const clusterId = `cluster-${String(index + 1).padStart(2, "0")}`;
      reports.push(this.runDiagnostics(clusterId, { automatic: true }));
    }
    this.lastFullDiagnosticsAt = new Date(this.now()).toISOString();
    return reports;
  }

  diagnostics(clusterId) {
    this.clusterManager.describeCluster(clusterId);
    return this.readState().diagnostics[clusterId] || this.runDiagnostics(clusterId);
  }

  overview() {
    const state = this.readState();
    return {
      workers: this.listWorkers(),
      clusterWorkers: state.clusterWorkers,
      diagnostics: state.diagnostics,
      drainedClusters: [...this.drained],
      queuedJobs: [...this.jobs.values()].filter((job) =>
        ["queued", "leased"].includes(job.status)
      ).length,
      lastFullDiagnosticsAt: this.lastFullDiagnosticsAt,
      intervalMs: this.diagnosticIntervalMs,
    };
  }
}

let controlPlaneInstance = null;

function getChildControl(options = {}) {
  controlPlaneInstance ??= new ClusterControlPlane(options);
  if (options.client) controlPlaneInstance.configure(options);
  return controlPlaneInstance;
}

export {
  WORKER_NODE_ID_REGEX as CHILD_ID,
  CONTROL_PLANE_JOBS as CONTROL_JOBS,
  ClusterControlPlane as ChildControlPlane,
  SUPPORTED_JOB_TYPES as JOB_TYPES,
  canonicalize as canonical,
  getChildControl,
  normalizeWorkerMetrics as safeMetrics,
};