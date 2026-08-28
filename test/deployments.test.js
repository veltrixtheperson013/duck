import assert from "node:assert/strict";
import test from "node:test";
import { ClusterManager } from "../src/clusters.js";
import { DeploymentManager, deploymentConfig, githubRemote } from "../src/deployments.js";

function deploymentFixture(remoteUrl = "https://github.com/example/duck.git") {
  const notices = []; const audits = []; const gitCalls = []; let state = null;
  const ids = ["123456789012345678", "223456789012345678"];
  const clusterManager = new ClusterManager({ env: { DUCK_CLUSTER_COUNT: "2", DUCK_CLUSTER_ASSIGNMENTS: `${ids[0]}=cluster-01,${ids[1]}=cluster-02` } });
  const guild = (id) => ({ id, channels: { cache: new Map([[`3${id.slice(1)}`, { isTextBased: () => true, send: async (payload) => { notices.push([id, payload]); } }]]) } });
  const client = { guilds: { cache: new Map(ids.map((id) => [id, guild(id)])) } };
  const oldCommit = "1".repeat(40); const newCommit = "2".repeat(40);
  const git = async (args) => { gitCalls.push(args); if (args[0] === "remote") return { stdout: remoteUrl }; if (args[0] === "status") return { stdout: "" }; if (args[0] === "rev-parse") return { stdout: `${args[1] === "HEAD" ? oldCommit : newCommit}\n` }; return { stdout: "" }; };
  const manager = new DeploymentManager({ client, clusterManager, getSettings: (id) => ({ entryChannels: { logChannelId: `3${id.slice(1)}` } }), env: { DUCK_ADMIN_DEPLOY_ENABLED: "true", DUCK_ADMIN_DEPLOY_BRANCH: "master", DUCK_ADMIN_DEPLOY_REMOTE: "origin", DUCK_ADMIN_DEPLOY_CLUSTER_DELAY_MS: "500", DUCK_ADMIN_DEPLOY_AUTO_RESTART: "false" }, git, waitImpl: async () => {}, getDeployment: () => state, setDeployment: (next) => { state = { ...next, updatedAt: new Date().toISOString() }; return state; }, audit: (...entry) => audits.push(entry), setStatusOverride() {} });
  return { manager, notices, audits, gitCalls, getState: () => state };
}

test("gradual deployments use fixed Git arguments, notify each cluster, and stop for a supervised restart", async () => {
  const fixture = deploymentFixture();
  fixture.manager.start("1138897388694687834"); await fixture.manager.waitForIdle();
  assert.equal(fixture.getState().status, "restart_required"); assert.equal(fixture.getState().completedClusters, 2); assert.equal(fixture.notices.length, 2);
  assert.ok(fixture.gitCalls.some((args) => args.join(" ") === "fetch --prune --no-tags origin master")); assert.ok(fixture.gitCalls.some((args) => args.join(" ") === "merge --ff-only origin/master"));
  assert.ok(fixture.audits.some(([action]) => action === "deployment.cluster-staged")); assert.match(fixture.notices[0][1].content, /briefly unavailable/); assert.deepEqual(fixture.notices[0][1].allowedMentions, { parse: [] });
});

test("gradual deployments fail closed for non-GitHub remotes and unsafe configuration", async () => {
  assert.equal(githubRemote("https://github.com/example/duck.git"), true); assert.equal(githubRemote("https://evil.example/duck.git"), false);
  assert.throws(() => deploymentConfig({ DUCK_ADMIN_DEPLOY_ENABLED: "true", DUCK_ADMIN_DEPLOY_BRANCH: "--upload-pack=evil" }), /invalid/);
  assert.throws(() => deploymentConfig({ DUCK_ADMIN_DEPLOY_ENABLED: "true", DUCK_ADMIN_DEPLOY_REMOTE: "--exec" }), /invalid/);
  const fixture = deploymentFixture("https://evil.example/duck.git"); fixture.manager.start("1138897388694687834"); await fixture.manager.waitForIdle();
  assert.equal(fixture.getState().status, "failed"); assert.match(fixture.getState().message, /GitHub repository/); assert.equal(fixture.notices.length, 0);
});
