import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLevelReward, prepareLevelReward, executeLevelReward, runLevelRewardBackfills } from "../src/level-rewards.js";

function fixture() {
  const guild = { id: "123456789012345678" }; let admin = true; let manage = true; let stored = {}; const calls = []; const roles = new Map();
  const member = { id: "223456789012345678", guild, permissions: { has: () => admin } };
  const bot = { permissions: { has: () => manage } }; const targets = new Map();
  guild.members = { fetchMe: async () => bot, fetch: async ({ user }) => user === member.id ? member : targets.get(user) };
  function addRole(id = "323456789012345678", name = "risen") {
    const role = { id, name, guild, editable: true, managed: false, permissions: { any: () => false }, async delete() { roles.delete(id); calls.push("delete"); } };
    roles.set(id, role); return role;
  }
  guild.roles = { fetch: async id => id ? roles.get(id) : roles, create: async input => { calls.push(input); return addRole(undefined, input.name); } };
  const store = { read: () => stored, write: (_, patch) => { stored = structuredClone({ ...stored, ...patch }); } };
  return { guild, member, calls, roles, targets, addRole, store, setAdmin: v => { admin = v; }, setManage: v => { manage = v; } };
}

test("level rewards validate exact names and thresholds and preview without creating roles", async () => {
  const f = fixture();
  assert.throws(() => normalizeLevelReward({ roleName: "when you reach level 5 make a role named risen", level: 5 }), /exact role name/);
  assert.throws(() => normalizeLevelReward({ roleName: "risen", level: 0 }), /1 to 100/);
  const action = await prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5 }, f.store);
  assert.equal(f.calls.length, 0); assert.match(action.summary, /permission-free/);
  await executeLevelReward(f.guild, f.member, action, f.store);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].permissions, []);
  assert.equal(f.store.read().levelsEnabled, true);
  assert.deepEqual(f.store.read().levelRewards, [{ level: 5, roleId: "323456789012345678" }]);
});

test("existing safe rewards are reused and grants recheck each member's current XP", async () => {
  const f = fixture(); const role = f.addRole(); const ids = ["423456789012345678", "523456789012345678", "623456789012345678"]; const granted = [];
  for (const id of ids) f.targets.set(id, { id, roles: { cache: new Map(), add: async () => granted.push(id) } });
  f.store.write(f.guild.id, { levelProfiles: Object.fromEntries(ids.map(id => [id, { xp: 2500 }])) });
  const action = await prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5, includeExisting: true }, f.store);
  await executeLevelReward(f.guild, f.member, action, f.store);
  assert.equal(f.calls.length, 0); assert.equal(f.store.read().levelRewardBackfills[0].pending.length, 3);
  f.store.write(f.guild.id, { levelProfiles: { [ids[0]]: { xp: 2500 }, [ids[1]]: { xp: 2499 } } });
  await runLevelRewardBackfills({ guilds: { cache: new Map([[f.guild.id, f.guild]]) } }, f.store);
  assert.deepEqual(granted, [ids[0]]); assert.deepEqual(f.store.read().levelRewardBackfills, []); assert.equal(role.name, "risen");
});

test("changed rewards, unsafe roles, or revoked permissions prevent application", async () => {
  const f = fixture(); const role = f.addRole(); const action = await prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5 }, f.store);
  f.store.write(f.guild.id, { levelsEnabled: true });
  await assert.rejects(executeLevelReward(f.guild, f.member, action, f.store), /changed/);
  role.permissions.any = () => true;
  await assert.rejects(prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5 }, f.store), /sensitive/);
  role.permissions.any = () => false; f.setAdmin(false);
  await assert.rejects(executeLevelReward(f.guild, f.member, action, f.store), /Administrator/);
  f.setAdmin(true); f.setManage(false);
  await assert.rejects(prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5 }, f.store), /Manage Roles/); assert.equal(f.calls.length, 0);
});

test("failed configuration writes roll back newly created roles", async () => {
  const f = fixture(); const action = await prepareLevelReward(f.guild, f.member, { roleName: "risen", level: 5 }, f.store);
  f.store.write = () => { throw Error("disk unavailable"); };
  await assert.rejects(executeLevelReward(f.guild, f.member, action, f.store), /disk unavailable/);
  assert.equal(f.roles.size, 0); assert.equal(f.calls.at(-1), "delete");
});

test("backfills pause after authorizer revocation and stop when the reward is removed", async () => {
  const f = fixture(); const role = f.addRole(); const id = "423456789012345678"; let grants = 0;
  f.targets.set(id, { id, roles: { cache: new Map(), add: async () => grants++ } });
  f.store.write(f.guild.id, { levelsEnabled: true, levelRewards: [{ level: 5, roleId: role.id }], levelProfiles: { [id]: { xp: 2500 } }, levelRewardBackfills: [{ roleId: role.id, level: 5, approvedBy: f.member.id, pending: [id], attempts: {} }] });
  const client = { guilds: { cache: new Map([[f.guild.id, f.guild]]) } };
  f.setAdmin(false); await runLevelRewardBackfills(client, f.store); assert.equal(grants, 0);
  f.setAdmin(true); f.store.write(f.guild.id, { levelRewards: [] }); await runLevelRewardBackfills(client, f.store); assert.equal(grants, 0);
});
