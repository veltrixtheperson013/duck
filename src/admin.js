import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteGuildSettings, flushJsonWrites, getGuildSettings, loadSettings, updateGuildSettings } from "./config.js";
import { getClusterManager } from "./clusters.js";
import { clearWebsiteBanner, getOperatorState, recordOperatorAction, removePlatformBlock, scheduleMaintenance, setClusterAssignmentOverride, setClusterStatusOverride, setPlatformBlock, setWebsiteBanner, updateMaintenance } from "./operator-state.js";
import { logError, logInfo } from "./logging.js";

const LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DISCORD_ID = /^\d{10,20}$/;
const adminDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "admin-public");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/admin.css", ["admin.css", "text/css; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
]);
const assetCache = new Map([...assets.values()].map(([file]) => [file, fs.readFileSync(path.join(adminDirectory, file))]));

function headers(type) {
  return { "Content-Type": type, "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };
}

function send(res, status, type, body, method = "GET") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...headers(type), "Content-Length": payload.length });
  res.end(method === "HEAD" ? undefined : payload);
}

function json(res, status, body, method) { send(res, status, "application/json; charset=utf-8", JSON.stringify(body), method); }
function digest(value) { return createHash("sha256").update(String(value || "")).digest(); }
function authorized(req, token) { const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); return supplied.length >= 32 && timingSafeEqual(digest(supplied), digest(token)); }
function validId(value, label = "Discord ID") { const id = String(value || ""); if (!DISCORD_ID.test(id)) throw new TypeError(`${label} must contain 10 to 20 digits.`); return id; }
function safeObject(input) { return input && typeof input === "object" && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype && !Object.keys(input).some((key) => ["__proto__", "prototype", "constructor"].includes(key)); }

async function readJson(req, maximum = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maximum) throw Object.assign(new Error("Request is too large."), { status: 413 }); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("Request must be valid JSON."), { status: 400 }); }
  if (!safeObject(value)) throw Object.assign(new Error("Request must be a safe JSON object."), { status: 400 });
  return value;
}

function publicOperatorState(state) {
  return { blockedUsers: state.blockedUsers, clusterStatuses: state.clusterStatuses, clusterAssignments: state.clusterAssignments, websiteBanner: state.websiteBanner, maintenance: state.maintenance, auditLog: state.auditLog.slice(0, 100) };
}

function grantPlus(guildId, level, expiresAt, getSettings, updateSettings) {
  const allowed = new Set(["plus", "plus_2", "plus_3", "plus_6", "plus_12"]);
  if (!allowed.has(level)) throw new TypeError("Choose a valid Plus tier.");
  const current = getSettings(guildId);
  if (current.subscription?.provider === "stripe" && ["active", "trialing"].includes(current.subscription.status)) throw Object.assign(new Error("This server has an active Stripe subscription. Manage it through Stripe instead of overwriting it."), { status: 409 });
  let normalizedExpiry = null;
  if (expiresAt) { const date = new Date(expiresAt); if (Number.isNaN(date.valueOf()) || date.valueOf() <= Date.now()) throw new TypeError("Plus expiry must be in the future."); normalizedExpiry = date.toISOString(); }
  const subscription = { provider: "operator", tier: "plus", status: "active", levelOverride: level, startedAt: new Date().toISOString(), expiresAt: normalizedExpiry, grantedAt: new Date().toISOString() };
  updateSettings(guildId, { subscription });
  return subscription;
}

function startOperatorMaintenance(clusterManager) {
  const apply = () => {
    const state = getOperatorState(); const now = Date.now(); let changed = false;
    for (const [guildId, clusterId] of Object.entries(state.clusterAssignments)) { try { clusterManager.setAssignment(guildId, clusterId); } catch { /* Invalid persisted data is ignored. */ } }
    for (const [clusterId, status] of Object.entries(state.clusterStatuses)) { try { clusterManager.setStatus(clusterId, status); } catch { /* Invalid persisted data is ignored. */ } }
    for (const item of state.maintenance) {
      const start = Date.parse(item.startsAt); const end = Date.parse(item.endsAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (now >= start && now < end) { try { clusterManager.setStatus(item.clusterId, "maintenance"); } catch { /* Ignore removed clusters. */ } }
      else if (now >= end && !item.completedAt) { item.completedAt = new Date(now).toISOString(); changed = true; try { clusterManager.setStatus(item.clusterId, state.clusterStatuses[item.clusterId] || "normal"); } catch { /* Ignore removed clusters. */ } }
    }
    if (changed) updateMaintenance(state.maintenance);
  };
  apply(); const timer = setInterval(apply, 15_000); timer.unref(); return timer;
}

function createDuckOperatorServer(options = {}) {
  const client = options.client; const clusterManager = options.clusterManager || getClusterManager(); const token = String(options.token || process.env.DUCK_ADMIN_TOKEN || ""); const port = Math.max(1, Math.min(Number(options.port || process.env.DUCK_ADMIN_PORT) || 9590, 65_535)); const getSettings = options.getGuildSettings || getGuildSettings; const updateSettings = options.updateGuildSettings || updateGuildSettings; const deleteSettings = options.deleteGuildSettings || deleteGuildSettings;
  if (token.length < 32) throw new Error("DUCK_ADMIN_TOKEN must contain at least 32 characters.");
  const mutationTimes = [];
  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, async (req, res) => {
    const method = req.method || "GET"; const remote = req.socket.remoteAddress; const host = String(req.headers.host || "").toLowerCase();
    if (!LOOPBACKS.has(remote) || !/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host)) return send(res, 403, "text/plain; charset=utf-8", "Loopback access only.", method);
    let pathname; try { pathname = new URL(req.url || "/", `http://${host}`).pathname; } catch { return send(res, 400, "text/plain; charset=utf-8", "Bad request.", method); }
    if (assets.has(pathname) && ["GET", "HEAD"].includes(method)) { const [file, type] = assets.get(pathname); return send(res, 200, type, assetCache.get(file), method); }
    if (!pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." }, method);
    if (!authorized(req, token)) return json(res, 401, { error: "Enter your operator token." }, method);
    if (!["GET", "HEAD"].includes(method)) {
      const origin = String(req.headers.origin || ""); if (origin && origin !== `http://${host}`) return json(res, 403, { error: "Cross-origin operator requests are blocked." }, method);
      const now = Date.now(); while (mutationTimes[0] < now - 60_000) mutationTimes.shift(); if (mutationTimes.length >= 60) return json(res, 429, { error: "Too many operator changes. Slow down." }, method); mutationTimes.push(now);
    }
    try {
      if (pathname === "/api/overview" && method === "GET") {
        const guilds = client?.guilds?.cache ? [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: String(guild.name || "Unknown server").slice(0, 100), members: Number(guild.memberCount) || 0, cluster: clusterManager.describeGuild(guild.id) })) : [];
        return json(res, 200, { service: { startedAt: new Date(Date.now() - Math.max(0, Number(process.uptime()) * 1000)).toISOString(), uptimeSeconds: Math.floor(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024), node: process.version }, guilds, clusters: clusterManager.list(guilds.map(({ id }) => id)), operator: publicOperatorState(getOperatorState()), database: { guildProfiles: Object.keys(loadSettings().guilds || {}).length } }, method);
      }
      const guildMatch = pathname.match(/^\/api\/database\/guilds\/(\d{10,20})$/);
      if (guildMatch && method === "GET") return json(res, 200, { guildId: guildMatch[1], settings: getSettings(guildMatch[1]) }, method);
      if (pathname === "/api/database/export" && method === "GET") return json(res, 200, { exportedAt: new Date().toISOString(), settings: loadSettings(), operator: publicOperatorState(getOperatorState()) }, method);
      if (pathname === "/api/action" && method === "POST") {
        const input = await readJson(req); const action = String(input.action || ""); let result;
        if (action === "cluster.status") { result = clusterManager.setStatus(String(input.clusterId), String(input.status)); setClusterStatusOverride(String(input.clusterId), String(input.status)); }
        else if (action === "cluster.assign") { const guildId = validId(input.guildId, "Server ID"); result = clusterManager.setAssignment(guildId, String(input.clusterId)); setClusterAssignmentOverride(guildId, String(input.clusterId)); }
        else if (action === "cluster.unassign") { const guildId = validId(input.guildId, "Server ID"); result = clusterManager.clearAssignment(guildId); setClusterAssignmentOverride(guildId, null); }
        else if (action === "maintenance.schedule") result = scheduleMaintenance(input);
        else if (action === "platform.block") result = setPlatformBlock(validId(input.userId, "User ID"), input.reason);
        else if (action === "platform.unblock") result = { removed: removePlatformBlock(validId(input.userId, "User ID")) };
        else if (action === "plus.grant") { const guildId = validId(input.guildId, "Server ID"); result = grantPlus(guildId, String(input.level), input.expiresAt, getSettings, updateSettings); }
        else if (action === "plus.revoke") { const guildId = validId(input.guildId, "Server ID"); const current = getSettings(guildId); if (current.subscription?.provider !== "operator") throw Object.assign(new Error("Only operator-granted Plus can be revoked here."), { status: 409 }); updateSettings(guildId, { subscription: { provider: "operator", tier: "free", status: "revoked", revokedAt: new Date().toISOString() } }); result = { revoked: true }; }
        else if (action === "banner.set") result = setWebsiteBanner(input);
        else if (action === "banner.clear") { clearWebsiteBanner(); result = { cleared: true }; }
        else if (action === "database.flush") { flushJsonWrites(); result = { flushed: true }; }
        else if (action === "database.delete-guild") { const guildId = validId(input.guildId, "Server ID"); if (String(input.confirmation) !== guildId) throw new TypeError("Type the exact server ID to confirm deletion."); result = { deleted: deleteSettings(guildId) }; }
        else throw Object.assign(new Error("Unknown operator action."), { status: 400 });
        recordOperatorAction(action, { target: input.guildId || input.userId || input.clusterId || "Duck", reason: input.reason || "Operator request" });
        return json(res, 200, { ok: true, result }, method);
      }
      return json(res, 405, { error: "Method not allowed." }, method);
    } catch (error) {
      const status = error.status || (error instanceof TypeError ? 400 : 500); if (status === 500) logError("operator.request-failed", error, { pathname }); return json(res, status, { error: status === 500 ? "Operator action failed. Check Duck's logs." : error.message }, method);
    }
  });
  server.operatorPort = port; server.operatorMaintenanceTimer = startOperatorMaintenance(clusterManager); return server;
}

function startDuckOperatorServer(options = {}) {
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DUCK_ADMIN_ENABLED || "false"))) return null;
  const server = createDuckOperatorServer(options); server.listen(server.operatorPort, "127.0.0.1", () => logInfo("operator.ready", { address: "127.0.0.1", port: server.operatorPort })); return server;
}

export { createDuckOperatorServer, grantPlus, startDuckOperatorServer };
