import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { getGuildSettings } from "./config.js";
import { getOperatorState, recordOperatorAction, setClusterStatusOverride, setDeploymentState } from "./operator-state.js";

const execFile = promisify(execFileCallback);
const SAFE_GIT_REMOTE = /^(?!-)[A-Za-z0-9._-]{1,50}$/;
const SAFE_GIT_BRANCH = /^(?![-/])(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;
const TERMINAL_STATES = new Set(["restart_required", "restarting", "completed", "failed"]);

function enabled(value) { return /^(1|true|yes|on)$/i.test(String(value || "false")); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cleanOutput(value, maximum = 4_000) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum); }

function deploymentConfig(env = process.env) {
  const remote = String(env.DUCK_ADMIN_DEPLOY_REMOTE || "origin").trim();
  const branch = String(env.DUCK_ADMIN_DEPLOY_BRANCH || "master").trim();
  if (!SAFE_GIT_REMOTE.test(remote) || !SAFE_GIT_BRANCH.test(branch)) throw new TypeError("Deployment Git remote or branch is invalid.");
  return { enabled: enabled(env.DUCK_ADMIN_DEPLOY_ENABLED), autoRestart: enabled(env.DUCK_ADMIN_DEPLOY_AUTO_RESTART), remote, branch, delayMs: Math.max(500, Math.min(Number(env.DUCK_ADMIN_DEPLOY_CLUSTER_DELAY_MS) || 3_000, 60_000)) };
}

async function defaultGit(args, cwd) {
  const result = await execFile("git", args, { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 512 * 1024 });
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function githubRemote(url) { return /^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(String(url || "").trim()); }

class DeploymentManager {
  constructor({ client, clusterManager, getSettings = getGuildSettings, env = process.env, cwd = process.cwd(), git = defaultGit, waitImpl = wait, restartImpl, getDeployment, setDeployment, audit, setStatusOverride } = {}) {
    this.client = client; this.clusterManager = clusterManager; this.getSettings = getSettings; this.env = env; this.cwd = cwd; this.git = git; this.wait = waitImpl;
    this.restart = restartImpl || (() => { const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 1_500); timer.unref(); });
    this.getDeployment = getDeployment || (() => getOperatorState().deployment || null);
    this.setDeployment = setDeployment || setDeploymentState;
    this.audit = audit || recordOperatorAction;
    this.setStatusOverride = setStatusOverride || setClusterStatusOverride;
    this.active = null;
  }

  snapshot() { return this.getDeployment(); }
  async waitForIdle() { await this.active; return this.snapshot(); }

  start(actorId = "local-operator") {
    const config = deploymentConfig(this.env);
    if (!config.enabled) throw Object.assign(new Error("Gradual deployment is disabled. Set DUCK_ADMIN_DEPLOY_ENABLED=true after configuring your process supervisor."), { status: 503 });
    const previous = this.snapshot(); const previousUpdatedAt = Date.parse(previous?.updatedAt || "");
    if (this.active || (previous && !TERMINAL_STATES.has(previous.status) && previousUpdatedAt > Date.now() - 30 * 60_000)) throw Object.assign(new Error("A deployment is already running."), { status: 409 });
    if (previous && !TERMINAL_STATES.has(previous.status)) { this.setDeployment({ ...previous, status: "failed", completedAt: new Date().toISOString(), message: "A stale deployment lock was recovered after Duck restarted." }); this.audit("deployment.stale-recovered", { actorId, target: previous.id, reason: "Deployment had no heartbeat for 30 minutes" }); }
    const id = `deploy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const initial = this.setDeployment({ id, status: "preflight", actorId, startedAt: new Date().toISOString(), totalClusters: this.clusterManager.count, completedClusters: 0, message: "Checking repository and deployment safety.", restartMode: config.autoRestart ? "automatic" : "manual" });
    this.audit("deployment.started", { actorId, target: `${config.remote}/${config.branch}`, reason: "Gradual rollout requested" });
    this.active = this.run(initial, config).catch(() => {}).finally(() => { this.active = null; });
    return initial;
  }

  async notifyCluster(clusterId, targetCommit) {
    const guilds = this.client?.guilds?.cache ? [...this.client.guilds.cache.values()].filter((guild) => this.clusterManager.clusterIdForGuild(guild.id) === clusterId) : [];
    let delivered = 0;
    for (let index = 0; index < guilds.length; index += 5) {
      await Promise.all(guilds.slice(index, index + 5).map(async (guild) => {
        const channelId = this.getSettings(guild.id)?.entryChannels?.logChannelId;
        const channel = channelId ? guild.channels?.cache?.get(channelId) : null;
        if (!channel?.isTextBased?.() || typeof channel.send !== "function") return;
        await channel.send({ content: `**Duck cluster update**\nYour server's cluster (\`${clusterId}\`) is entering maintenance for a Duck update. Some Duck features may be briefly unavailable. Target release: \`${targetCommit.slice(0, 12)}\`.`, allowedMentions: { parse: [] } });
        delivered += 1;
      }));
    }
    return { guilds: guilds.length, delivered };
  }

  async restoreStatuses(statuses) {
    for (const [clusterId, status] of statuses) { this.clusterManager.setStatus(clusterId, status); this.setStatusOverride(clusterId, status); }
  }

  async run(initial, config) {
    const ref = `${config.remote}/${config.branch}`; const originalStatuses = new Map();
    try {
      const remoteUrl = cleanOutput((await this.git(["remote", "get-url", config.remote], this.cwd)).stdout, 500);
      if (!githubRemote(remoteUrl)) throw new Error("Deployment remote must be a GitHub repository URL.");
      const tracked = cleanOutput((await this.git(["status", "--porcelain", "--untracked-files=no"], this.cwd)).stdout);
      if (tracked) throw new Error("Tracked files have local changes. Commit or restore them before deploying.");
      await this.git(["fetch", "--prune", "--no-tags", config.remote, config.branch], this.cwd);
      const fromCommit = cleanOutput((await this.git(["rev-parse", "HEAD"], this.cwd)).stdout);
      const toCommit = cleanOutput((await this.git(["rev-parse", ref], this.cwd)).stdout);
      if (!/^[a-f0-9]{40}$/.test(fromCommit) || !/^[a-f0-9]{40}$/.test(toCommit)) throw new Error("Git returned an invalid release commit.");
      try { await this.git(["merge-base", "--is-ancestor", "HEAD", ref], this.cwd); } catch { throw new Error("The remote release is not a fast-forward update. Manual review is required."); }
      if (fromCommit === toCommit) { this.setDeployment({ ...initial, status: "completed", fromCommit, toCommit, completedAt: new Date().toISOString(), message: "Duck is already on the newest release." }); this.audit("deployment.no-change", { actorId: initial.actorId, target: toCommit, reason: "Repository already current" }); return; }
      const clusters = this.clusterManager.list(this.client?.guilds?.cache ? [...this.client.guilds.cache.keys()] : []);
      for (let index = 0; index < clusters.length; index += 1) {
        const cluster = clusters[index]; originalStatuses.set(cluster.id, cluster.status); this.clusterManager.setStatus(cluster.id, "maintenance"); this.setStatusOverride(cluster.id, "maintenance");
        const delivery = await this.notifyCluster(cluster.id, toCommit);
        this.setDeployment({ ...initial, status: "staging", fromCommit, toCommit, currentCluster: cluster.id, completedClusters: index + 1, totalClusters: clusters.length, message: `Notified ${delivery.delivered} of ${delivery.guilds} configured server logs for ${cluster.id}.` });
        this.audit("deployment.cluster-staged", { actorId: initial.actorId, target: cluster.id, reason: `${delivery.delivered} log notices delivered` });
        await this.wait(config.delayMs);
      }
      this.setDeployment({ ...initial, status: "updating", fromCommit, toCommit, completedClusters: clusters.length, totalClusters: clusters.length, message: `Applying fast-forward release ${toCommit.slice(0, 12)}.` });
      const finalTrackedCheck = cleanOutput((await this.git(["status", "--porcelain", "--untracked-files=no"], this.cwd)).stdout);
      if (finalTrackedCheck) throw new Error("Tracked files changed while the rollout was staging. The release was not applied.");
      await this.git(["merge", "--ff-only", ref], this.cwd);
      await this.restoreStatuses(originalStatuses);
      if (config.autoRestart) {
        this.setDeployment({ ...initial, status: "restarting", fromCommit, toCommit, completedClusters: clusters.length, totalClusters: clusters.length, message: "Release applied. Duck is restarting through the configured process supervisor.", restartMode: "automatic" });
        this.audit("deployment.restart-requested", { actorId: initial.actorId, target: toCommit, reason: "Fast-forward release applied" }); this.restart();
      } else {
        this.setDeployment({ ...initial, status: "restart_required", fromCommit, toCommit, completedClusters: clusters.length, totalClusters: clusters.length, message: "Release applied. Restart Duck from Wispbyte to load the new code.", restartMode: "manual" });
        this.audit("deployment.restart-required", { actorId: initial.actorId, target: toCommit, reason: "Automatic restart is disabled" });
      }
    } catch (error) {
      if (originalStatuses.size) await this.restoreStatuses(originalStatuses).catch(() => {});
      const message = cleanOutput(error?.message || "Deployment failed.", 300);
      this.setDeployment({ ...initial, status: "failed", completedAt: new Date().toISOString(), message });
      this.audit("deployment.failed", { actorId: initial.actorId, target: initial.currentCluster || "Duck", reason: message });
      throw error;
    }
  }
}

let defaultManager = null;
function getDeploymentManager(options = {}) { defaultManager ??= new DeploymentManager(options); return defaultManager; }

export { DeploymentManager, deploymentConfig, getDeploymentManager, githubRemote };
