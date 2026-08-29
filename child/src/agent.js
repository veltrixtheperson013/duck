import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createManagerClock, fetchWithDeadline, readManagerJson, retryDelay, sleep } from "./protocol.js";

const manager = new URL(String(process.env.DUCK_MANAGER_URL || ""));
if (manager.protocol !== "https:" && !(manager.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(manager.hostname))) throw new Error("DUCK_MANAGER_URL must use HTTPS (HTTP is allowed only for localhost testing).");
const dataDir = path.resolve(process.env.DUCK_CHILD_DATA_DIR || "child-data");
const identityPath = path.join(dataDir, "identity.json");
const cache = new Map(); const startedAt = Date.now(); const recentDurations = []; let activeJobs = 0; let errors = 0; let completed = 0;
const managerClock = createManagerClock();

function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function hash(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
function loadIdentity() { try { const value = JSON.parse(readFileSync(identityPath, "utf8")); if (value.childId && value.privateKey && value.publicKey) return value; } catch { /* First boot enrolls below. */ } return null; }
function saveIdentity(value) { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); writeFileSync(identityPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
async function enroll() { const token = String(process.env.DUCK_CHILD_ENROLLMENT_TOKEN || "").trim(); if (!token) throw new Error("Set DUCK_CHILD_ENROLLMENT_TOKEN for the first start."); const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64"); const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"); const response = await fetchWithDeadline(new URL("/internal/children/enroll", manager), { method: "POST", headers: { accept: "application/json", "cache-control": "no-cache", "content-type": "application/json", "user-agent": "DuckChild/1.0.0" }, body: JSON.stringify({ token, label: String(process.env.DUCK_CHILD_LABEL || os.hostname()).slice(0, 80), publicKey: publicDer, version: "1.0.0", commit: /^[a-f0-9]{7,40}$/.test(process.env.DUCK_CHILD_COMMIT || "") ? process.env.DUCK_CHILD_COMMIT : undefined }) }); const result = await readManagerJson(response, 16 * 1024); const identity = { childId: result.childId, publicKey: publicDer, privateKey: privateDer, enrolledAt: new Date().toISOString() }; saveIdentity(identity); return identity; }
let identity = loadIdentity() || await enroll();
async function signedPost(pathname, body) {
  const timestamp = managerClock.now();
  const nonce = randomBytes(18).toString("base64url");
  const message = `POST\n${pathname}\n${timestamp}\n${nonce}\n${hash(canonical(body))}`;
  const signature = sign(null, Buffer.from(message), { key: Buffer.from(identity.privateKey, "base64"), format: "der", type: "pkcs8" }).toString("base64url");
  const response = await fetchWithDeadline(new URL(pathname, manager), {
    method: "POST",
    headers: { accept: "application/json", "cache-control": "no-cache", "content-type": "application/json", "user-agent": "DuckChild/1.0.0", "x-duck-child-id": identity.childId, "x-duck-child-time": String(timestamp), "x-duck-child-nonce": nonce, "x-duck-child-signature": signature },
    body: JSON.stringify(body),
  });
  try {
    const result = await readManagerJson(response);
    managerClock.observe(result?.managerTime);
    return result;
  } catch (error) {
    if (error?.managerTime) managerClock.observe(error.managerTime, { immediate: error.code === "child_clock_skew" });
    throw error;
  }
}
function metrics() { let diskFreeMb = 0; try { const disk = statfsSync(dataDir); diskFreeMb = Math.round(Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024); } catch { /* Diagnostic reports zero. */ } const memory = process.memoryUsage(); const p95 = [...recentDurations].sort((a, b) => a - b)[Math.max(0, Math.ceil(recentDurations.length * .95) - 1)] || 0; return { cpuPercent: Math.min(100, Math.round(os.loadavg()[0] / Math.max(1, os.cpus().length) * 100)), rssMb: Math.round(memory.rss / 1024 / 1024), heapMb: Math.round(memory.heapUsed / 1024 / 1024), diskFreeMb, eventLoopLagMs: 0, queueDepth: 0, oldestJobMs: 0, errorRate: completed ? errors / completed : 0, p95LatencyMs: p95, cacheHitRate: 0, cacheItems: cache.size, restartCount: 0, clockMs: Date.now(), activeJobs } }
function safeText(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
async function aiScan(payload) { const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim(); if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on this child."); if (!payload || typeof payload !== "object" || !/^[a-z0-9._:/-]{3,100}$/i.test(payload.model || "")) throw new Error("AI scan payload is invalid."); const response = await fetchWithDeadline("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json", "HTTP-Referer": process.env.OPENROUTER_SITE_URL || manager.origin, "X-OpenRouter-Title": "Duck child safety scanner" }, body: JSON.stringify({ model: payload.model, temperature: 0, max_tokens: 160, messages: [{ role: "system", content: safeText(payload.system, 7_000) }, { role: "user", content: safeText(payload.content, 1_500) }] }) }, 30_000); const value = await readManagerJson(response, 256 * 1024, "OpenRouter"); return { content: safeText(value?.choices?.[0]?.message?.content, 4_000) }; }
async function fluxTts(payload) { const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim(); if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on this child."); const input = safeText(payload?.text, 200); if (!input) throw new Error("TTS text is empty."); const response = await fetch("https://openrouter.ai/api/v1/audio/speech", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, accept: "audio/mpeg", "content-type": "application/json", "HTTP-Referer": process.env.OPENROUTER_SITE_URL || manager.origin, "X-OpenRouter-Title": "Duck child TTS" }, body: JSON.stringify({ model: "deepgram/flux-tts:free", input, voice: "flux-cole-en", response_format: "mp3" }) }); const bytes = Buffer.from(await response.arrayBuffer()); if (!response.ok || !bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error(`Flux TTS failed with HTTP ${response.status}.`); return { audio: bytes.toString("base64"), contentType: "audio/mpeg" }; }
const handlers = {
  "ai.scan": aiScan, "tts.flux": fluxTts,
  "cache.clear": async () => ({ cleared: cache.size, after: (cache.clear(), 0) }),
  "cache.warm": async () => { cache.set("worker-ready", { at: Date.now(), expiresAt: Date.now() + 300_000 }); return { warmed: 1 }; },
  "diagnostic.full": async () => ({ metrics: metrics(), platform: os.platform(), release: os.release(), cpus: os.cpus().length, uptimeSeconds: Math.floor(os.uptime()) }),
  "config.sync": async () => ({ accepted: true, generation: "manager-authoritative" }),
  "config.validate": async () => ({ valid: true, manager: manager.origin, identity: identity.childId, arbitraryExecution: false }),
  "logs.snapshot": async () => ({ lines: [`Worker ${identity.childId} is online.`, `${completed} jobs completed; ${errors} failed.`, `${cache.size} bounded cache entries.`] }),
  "worker.restart": async () => { if (!/^(1|true|yes)$/i.test(process.env.DUCK_CHILD_ALLOW_RESTART || "false")) throw new Error("Worker restart is disabled on this child."); return { restarting: true }; },
};
async function execute(job) { const handler = handlers[job?.type]; if (!handler || !/^job_[a-f0-9]{24}$/.test(job?.id || "")) throw new Error("Manager supplied an unsupported job."); const began = Date.now(); activeJobs += 1; try { const result = await handler(job.payload || {}); completed += 1; if (job.type === "worker.restart") setTimeout(() => process.exit(0), 750).unref(); return { jobId: job.id, ok: true, result, durationMs: Date.now() - began }; } catch (error) { errors += 1; completed += 1; return { jobId: job.id, ok: false, error: safeText(error.message, 300), durationMs: Date.now() - began }; } finally { activeJobs -= 1; recentDurations.push(Date.now() - began); if (recentDurations.length > 100) recentDurations.shift(); } }
async function heartbeat() { await signedPost("/internal/children/heartbeat", { metrics: metrics(), version: "1.0.0", startedAt: new Date(startedAt).toISOString(), configGeneration: "" }); }
async function poll() { const response = await signedPost("/internal/children/jobs/next", {}); if (response.job) await signedPost("/internal/children/jobs/result", await execute(response.job)); }
console.log(`Duck child ${identity.childId} connected to ${manager.origin}`);
let stopping = false;
const lastErrors = new Map();
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

function reportLoopError(kind, error, failures) {
  const message = safeText(error?.message || error, 500);
  const previous = lastErrors.get(kind);
  const shouldLog = failures === 1 || message !== previous || (failures & (failures - 1)) === 0;
  lastErrors.set(kind, message);
  if (shouldLog) console.error(`${kind}: ${message} (failure ${failures}; retrying with backoff)`);
}

function reportRecovery(kind, failures) {
  if (failures > 0) console.log(`${kind}: manager connection recovered after ${failures} failure${failures === 1 ? "" : "s"}.`);
  lastErrors.delete(kind);
}

async function heartbeatLoop() {
  let failures = 0;
  while (!stopping) {
    try {
      await heartbeat();
      reportRecovery("heartbeat", failures);
      failures = 0;
      await sleep(15_000);
    } catch (error) {
      failures += 1;
      reportLoopError("heartbeat", error, failures);
      await sleep(retryDelay(failures, { baseMs: 5_000, maximumMs: 60_000, retryAfterMs: error?.retryAfterMs }));
    }
  }
}

async function pollLoop() {
  let failures = 0;
  while (!stopping) {
    try {
      await poll();
      reportRecovery("poll", failures);
      failures = 0;
      await sleep(1_000);
    } catch (error) {
      failures += 1;
      reportLoopError("poll", error, failures);
      await sleep(retryDelay(failures, { baseMs: 1_000, maximumMs: 30_000, retryAfterMs: error?.retryAfterMs }));
    }
  }
}

await Promise.all([heartbeatLoop(), pollLoop()]);
