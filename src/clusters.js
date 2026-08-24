const CLUSTER_STATUSES = Object.freeze({
  normal: "Normal",
  outage: "Outage",
  maintenance: "Maintenance",
  offline: "Offline",
});

const DISCORD_ID = /^\d{10,20}$/;
const CLUSTER_ID = /^cluster-(\d{2})$/;

function boundedClusterCount(value) {
  if (value == null || String(value).trim() === "") return 4;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new TypeError("DUCK_CLUSTER_COUNT must be an integer from 1 to 32.");
  return count;
}

function formatClusterId(index) {
  return `cluster-${String(index + 1).padStart(2, "0")}`;
}

function parsePairs(value, field, maximum = 10_000) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.length > 64 * 1024) throw new TypeError(`${field} is too large.`);
  const pairs = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (pairs.length > maximum) throw new TypeError(`${field} has too many entries.`);
  return pairs.map((entry) => {
    const match = /^([^:=\s]+)\s*[:=]\s*([^:=\s]+)$/.exec(entry);
    if (!match) throw new TypeError(`${field} must use key=cluster-value pairs.`);
    return [match[1], match[2]];
  });
}

function validateClusterId(value, count, field) {
  const match = CLUSTER_ID.exec(String(value || ""));
  const index = match ? Number(match[1]) - 1 : -1;
  if (index < 0 || index >= count || formatClusterId(index) !== value) throw new TypeError(`${field} contains an invalid cluster ID.`);
  return value;
}

class ClusterManager {
  constructor({ env = process.env, startedAt = Date.now(), now = () => Date.now() } = {}) {
    this.count = boundedClusterCount(env.DUCK_CLUSTER_COUNT);
    this.startedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
    this.now = now;
    this.defaultStatus = String(env.DUCK_CLUSTER_STATUS || "normal").trim().toLowerCase();
    if (!(this.defaultStatus in CLUSTER_STATUSES)) throw new TypeError("DUCK_CLUSTER_STATUS must be normal, outage, maintenance, or offline.");
    this.assignments = new Map();
    this.statuses = new Map();

    for (const [guildId, clusterId] of parsePairs(env.DUCK_CLUSTER_ASSIGNMENTS, "DUCK_CLUSTER_ASSIGNMENTS")) {
      if (!DISCORD_ID.test(guildId)) throw new TypeError("DUCK_CLUSTER_ASSIGNMENTS keys must be Discord server IDs, not names.");
      validateClusterId(clusterId, this.count, "DUCK_CLUSTER_ASSIGNMENTS");
      if (this.assignments.has(guildId)) throw new TypeError("DUCK_CLUSTER_ASSIGNMENTS contains a duplicate server ID.");
      this.assignments.set(guildId, clusterId);
    }
    for (const [clusterId, statusValue] of parsePairs(env.DUCK_CLUSTER_STATUS_OVERRIDES, "DUCK_CLUSTER_STATUS_OVERRIDES", 32)) {
      validateClusterId(clusterId, this.count, "DUCK_CLUSTER_STATUS_OVERRIDES");
      const status = statusValue.toLowerCase();
      if (!(status in CLUSTER_STATUSES)) throw new TypeError("DUCK_CLUSTER_STATUS_OVERRIDES contains an invalid status.");
      if (this.statuses.has(clusterId)) throw new TypeError("DUCK_CLUSTER_STATUS_OVERRIDES contains a duplicate cluster ID.");
      this.statuses.set(clusterId, status);
    }
  }

  clusterIdForGuild(guildId) {
    const id = String(guildId || "");
    if (!DISCORD_ID.test(id)) throw new TypeError("Guild ID must be a Discord server ID.");
    const explicit = this.assignments.get(id);
    if (explicit) return explicit;
    const index = Number((BigInt(id) >> 22n) % BigInt(this.count));
    return formatClusterId(index);
  }

  statusForCluster(clusterId) {
    validateClusterId(clusterId, this.count, "Cluster status request");
    return this.statuses.get(clusterId) || this.defaultStatus;
  }

  describeCluster(clusterId, serverCount = 0) {
    const status = this.statusForCluster(clusterId);
    const now = this.now();
    const online = status !== "offline";
    return Object.freeze({
      id: clusterId,
      status,
      statusLabel: CLUSTER_STATUSES[status],
      uptimeSeconds: online ? Math.max(0, Math.floor((now - this.startedAt) / 1_000)) : 0,
      startedAt: online ? new Date(this.startedAt).toISOString() : null,
      lastHeartbeatAt: online ? new Date(now).toISOString() : null,
      serverCount: Math.max(0, Number(serverCount) || 0),
    });
  }

  describeGuild(guildId) {
    const id = this.clusterIdForGuild(guildId);
    const cluster = this.describeCluster(id);
    return Object.freeze({ id: cluster.id, status: cluster.status, statusLabel: cluster.statusLabel });
  }

  list(guildIds = []) {
    const counts = new Map();
    for (const guildId of guildIds) {
      if (!DISCORD_ID.test(String(guildId || ""))) continue;
      const clusterId = this.clusterIdForGuild(guildId);
      counts.set(clusterId, (counts.get(clusterId) || 0) + 1);
    }
    return Array.from({ length: this.count }, (_, index) => {
      const clusterId = formatClusterId(index);
      return this.describeCluster(clusterId, counts.get(clusterId) || 0);
    });
  }
}

let defaultManager = null;
function getClusterManager() {
  defaultManager ??= new ClusterManager();
  return defaultManager;
}

export { CLUSTER_STATUSES, ClusterManager, formatClusterId, getClusterManager };
