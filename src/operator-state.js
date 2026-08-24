import path from "node:path";
import { loadJsonFile, saveJsonFile } from "./config.js";

const operatorStatePath = path.join(process.cwd(), "data", "operator.json");
const DISCORD_ID = /^\d{10,20}$/;
const MAX_AUDIT = 500;

function cleanText(value, maximum = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function freshState() {
  return { version: 1, blockedUsers: {}, clusterStatuses: {}, clusterAssignments: {}, websiteBanner: null, maintenance: [], auditLog: [] };
}

function getOperatorState() {
  const state = loadJsonFile(operatorStatePath, freshState());
  if (!state || typeof state !== "object" || Array.isArray(state)) return freshState();
  state.blockedUsers = state.blockedUsers && typeof state.blockedUsers === "object" && !Array.isArray(state.blockedUsers) ? state.blockedUsers : {};
  state.clusterStatuses = state.clusterStatuses && typeof state.clusterStatuses === "object" && !Array.isArray(state.clusterStatuses) ? state.clusterStatuses : {};
  state.clusterAssignments = state.clusterAssignments && typeof state.clusterAssignments === "object" && !Array.isArray(state.clusterAssignments) ? state.clusterAssignments : {};
  state.maintenance = Array.isArray(state.maintenance) ? state.maintenance.slice(0, 100) : [];
  state.auditLog = Array.isArray(state.auditLog) ? state.auditLog.slice(0, MAX_AUDIT) : [];
  return state;
}

function saveOperatorState(state) {
  saveJsonFile(operatorStatePath, state, { immediate: true });
}

function recordOperatorAction(action, details = {}) {
  const state = getOperatorState();
  const safeDetails = Object.fromEntries(Object.entries(details).slice(0, 12).map(([key, value]) => [cleanText(key, 40), cleanText(value, 300)]));
  state.auditLog = [{ id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, action: cleanText(action, 80), details: safeDetails, at: new Date().toISOString() }, ...state.auditLog].slice(0, MAX_AUDIT);
  saveOperatorState(state);
  return state.auditLog[0];
}

function isPlatformBlocked(userId) {
  const id = String(userId || "");
  if (!DISCORD_ID.test(id)) return false;
  return Boolean(getOperatorState().blockedUsers[id]);
}

function setPlatformBlock(userId, reason) {
  const id = String(userId || "");
  if (!DISCORD_ID.test(id)) throw new TypeError("User ID must be a Discord ID.");
  const state = getOperatorState();
  state.blockedUsers[id] = { reason: cleanText(reason, 300) || "Blocked by the Duck operator", createdAt: new Date().toISOString() };
  saveOperatorState(state);
  return state.blockedUsers[id];
}

function removePlatformBlock(userId) {
  const id = String(userId || "");
  if (!DISCORD_ID.test(id)) throw new TypeError("User ID must be a Discord ID.");
  const state = getOperatorState();
  const existed = Boolean(state.blockedUsers[id]);
  delete state.blockedUsers[id];
  saveOperatorState(state);
  return existed;
}

function setWebsiteBanner(input) {
  const message = cleanText(input?.message, 280);
  if (!message) throw new TypeError("Banner message is required.");
  const tone = ["info", "maintenance", "warning", "success"].includes(input?.tone) ? input.tone : "info";
  const linkLabel = cleanText(input?.linkLabel, 40);
  let linkUrl = null;
  if (input?.linkUrl) {
    const url = new URL(String(input.linkUrl));
    if (url.protocol !== "https:") throw new TypeError("Banner links must use HTTPS.");
    linkUrl = url.toString().slice(0, 500);
  }
  const startsAt = input?.startsAt ? new Date(input.startsAt) : new Date();
  const endsAt = input?.endsAt ? new Date(input.endsAt) : null;
  if (Number.isNaN(startsAt.valueOf()) || (endsAt && Number.isNaN(endsAt.valueOf()))) throw new TypeError("Banner dates are invalid.");
  if (endsAt && endsAt <= startsAt) throw new TypeError("Banner end must be after its start.");
  const state = getOperatorState();
  state.websiteBanner = { message, tone, linkLabel: linkUrl ? linkLabel || "Learn more" : null, linkUrl, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null };
  saveOperatorState(state);
  return state.websiteBanner;
}

function clearWebsiteBanner() {
  const state = getOperatorState();
  state.websiteBanner = null;
  saveOperatorState(state);
}

function getActiveWebsiteBanner(now = Date.now()) {
  const banner = getOperatorState().websiteBanner;
  if (!banner) return null;
  const startsAt = Date.parse(banner.startsAt || "");
  const endsAt = Date.parse(banner.endsAt || "");
  if (!Number.isFinite(startsAt) || startsAt > now || (Number.isFinite(endsAt) && endsAt <= now)) return null;
  return { message: banner.message, tone: banner.tone, linkLabel: banner.linkLabel, linkUrl: banner.linkUrl, endsAt: banner.endsAt };
}

function scheduleMaintenance({ clusterId, startsAt, endsAt }) {
  if (!/^cluster-\d{2}$/.test(String(clusterId || ""))) throw new TypeError("Choose a valid cluster.");
  const start = new Date(startsAt); const end = new Date(endsAt);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) throw new TypeError("Maintenance requires a valid start and later end.");
  if (end.valueOf() <= Date.now()) throw new TypeError("Maintenance must end in the future.");
  const state = getOperatorState();
  const item = { id: `maint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, clusterId, startsAt: start.toISOString(), endsAt: end.toISOString(), completedAt: null };
  state.maintenance = [item, ...state.maintenance].slice(0, 100);
  saveOperatorState(state);
  return item;
}

function updateMaintenance(items) {
  const state = getOperatorState();
  state.maintenance = items.slice(0, 100);
  saveOperatorState(state);
}

function setClusterStatusOverride(clusterId, status) {
  const state = getOperatorState();
  state.clusterStatuses[clusterId] = status;
  saveOperatorState(state);
}

function setClusterAssignmentOverride(guildId, clusterId) {
  const state = getOperatorState();
  if (clusterId) state.clusterAssignments[guildId] = clusterId;
  else delete state.clusterAssignments[guildId];
  saveOperatorState(state);
}

export { clearWebsiteBanner, getActiveWebsiteBanner, getOperatorState, isPlatformBlocked, recordOperatorAction, removePlatformBlock, scheduleMaintenance, setClusterAssignmentOverride, setClusterStatusOverride, setPlatformBlock, setWebsiteBanner, updateMaintenance };
