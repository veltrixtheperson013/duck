import { createHash } from "node:crypto";
import { PermissionsBitField } from "discord.js";
import { getPublicGuildSettings, makeSettingsPatch } from "./dashboard-config.js";
import { getGuildSettings, updateGuildSettings } from "./config.js";
import { isSafeSelfAssignableRole } from "./community.js";

const locks = new Set();
const defaultStore = { read: getGuildSettings, write: updateGuildSettings };
function digest(settings) { const publicSettings = getPublicGuildSettings(settings); return createHash("sha256").update(JSON.stringify([publicSettings.levelsEnabled, publicSettings.levelRewards])).digest("hex"); }
export function normalizeLevelReward(input) {
  const roleName = typeof input.roleName === "string" ? input.roleName.trim() : "";
  if (!roleName || roleName.length > 100 || /[\r\n\x00-\x1f]/.test(roleName) || /^@?(?:everyone|here)$/i.test(roleName) || /\b(?:when you|give it to|make a role|create a role)\b/i.test(roleName)) throw new TypeError("Supply only the exact role name, such as risen, rather than the whole instruction.");
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 100) throw new TypeError("Choose a reward level from 1 to 100.");
  return { roleName, level: input.level, includeExisting: input.includeExisting === true };
}
async function roleAccess(guild, member) {
  if (member?.guild?.id !== guild.id || !member.permissions.has(PermissionsBitField.Flags.Administrator)) throw new Error("A current server Administrator must approve level rewards.");
  const bot = await guild.members.fetchMe({ force: true });
  if (!bot.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw new Error("Duck needs Manage Roles to configure this reward.");
  return guild.roles.fetch();
}
export async function prepareLevelReward(guild, member, input, store = defaultStore) {
  const reward = normalizeLevelReward(input); const current = store.read(guild.id); const roles = await roleAccess(guild, member);
  const matches = [...roles.values()].filter(role => role.name.toLocaleLowerCase() === reward.roleName.toLocaleLowerCase());
  if (matches.length > 1) throw new Error("Several roles have that name. Give the reward role a unique name first.");
  const existing = matches[0];
  if (existing && !isSafeSelfAssignableRole(existing)) throw new Error("That existing role is managed, above Duck, or grants sensitive permissions. Choose a safe reward role.");
  const rewards = getPublicGuildSettings(current).levelRewards;
  if (rewards.some(item => item.level === reward.level && item.roleId !== existing?.id)) throw new Error("That level already has a different reward. Review or remove the existing reward before replacing it.");
  makeSettingsPatch(current, { levelsEnabled: true, levelRewards: [...rewards.filter(item => item.level !== reward.level), { level: reward.level, roleId: existing?.id || "123456789012345678" }] });
  const eligible = Object.entries(current.levelProfiles || {}).filter(([id, profile]) => /^\d{10,20}$/.test(id) && Number(profile?.xp) >= reward.level ** 2 * 100).slice(0, 5000);
  return { ...reward, expectedRoleId: existing?.id || null, beforeDigest: digest(current), summary: `${existing ? "Use existing" : "Create a new, permission-free"} role @${reward.roleName}. Enable levels and award this role automatically at level ${reward.level}.${reward.includeExisting ? ` Also queue grants for ${eligible.length} existing eligible member(s); each member is rechecked before the role is added.` : " Existing members are not backfilled; future qualifying level-ups receive it."} Administrator approval is required.` };
}
export async function executeLevelReward(guild, member, action, store = defaultStore) {
  if (locks.has(guild.id)) throw new Error("A level-reward change is already in progress."); locks.add(guild.id);
  let created = null;
  try {
    const fresh = await prepareLevelReward(guild, member, action, store);
    if (fresh.beforeDigest !== action.beforeDigest || fresh.expectedRoleId !== action.expectedRoleId) throw new Error("The reward settings or matching roles changed. Prepare a new approval.");
    let role = fresh.expectedRoleId ? await guild.roles.fetch(fresh.expectedRoleId) : null;
    if (!role) { role = await guild.roles.create({ name: fresh.roleName, permissions: [], mentionable: false, reason: `Duck level ${fresh.level} reward approved by ${member.id}` }); created = role; }
    if (!isSafeSelfAssignableRole(role)) throw new Error("The role cannot safely be awarded by Duck.");
    const current = store.read(guild.id);
    if (digest(current) !== action.beforeDigest) throw new Error("Level settings changed during role creation. Prepare a new approval.");
    const rewards = getPublicGuildSettings(current).levelRewards.filter(item => item.level !== fresh.level);
    const { patch } = makeSettingsPatch(current, { levelsEnabled: true, levelRewards: [...rewards, { level: fresh.level, roleId: role.id }] });
    const pending = fresh.includeExisting ? Object.entries(current.levelProfiles || {}).filter(([id, profile]) => /^\d{10,20}$/.test(id) && Number(profile?.xp) >= fresh.level ** 2 * 100).slice(0, 5000).map(([id]) => id) : [];
    const backfills = (current.levelRewardBackfills || []).filter(job => job.roleId !== role.id).slice(-9);
    if (pending.length) backfills.push({ roleId: role.id, level: fresh.level, approvedBy: member.id, pending, attempts: {} });
    await store.write(guild.id, { ...patch, levelRewardBackfills: backfills });
    return `${created ? "Created" : "Reused"} role @${role.name} (${role.id}) and configured it as the level ${fresh.level} reward. Levels are enabled. ${pending.length ? `${pending.length} eligible members are queued for bounded background grants.` : "Future qualifying level-ups will receive it."}`;
  } catch (error) {
    if (created) { try { await created.delete("Duck: roll back an unconfigured level-reward role"); } catch { throw new Error(`${error.message} The new role ${created.id} remains and needs manual review.`); } }
    throw error;
  } finally { locks.delete(guild.id); }
}
let backfillBusy = false;
export async function runLevelRewardBackfills(client, store = defaultStore) {
  if (backfillBusy) return; backfillBusy = true;
  try {
    let budget = 50;
    for (const guild of client.guilds.cache.values()) {
      const current = store.read(guild.id); if (!current.levelRewardBackfills?.length) continue;
      const jobs = structuredClone(current.levelRewardBackfills).slice(0, 10); let changed = false;
      for (const job of jobs) {
        if (!budget || !job.pending?.length) continue;
        const member = await guild.members.fetch({ user: job.approvedBy, force: true }).catch(() => null);
        try {
          const roles = await roleAccess(guild, member); const role = roles.get(job.roleId); const settings = getPublicGuildSettings(store.read(guild.id));
          if (!settings.levelsEnabled || !settings.levelRewards.some(r => r.roleId === job.roleId && r.level === job.level) || !isSafeSelfAssignableRole(role)) continue;
          for (let n = 0; n < 25 && job.pending.length && budget; n++) {
            const latest = getPublicGuildSettings(store.read(guild.id));
            if (!latest.levelsEnabled || !latest.levelRewards.some(r => r.roleId === job.roleId && r.level === job.level)) break;
            budget--; changed = true; const id = job.pending.shift();
            const target = await guild.members.fetch({ user: id, force: true }).catch(() => null);
            if (!target || !(Number(store.read(guild.id).levelProfiles?.[id]?.xp) >= job.level ** 2 * 100) || target.roles.cache.has(role.id)) continue;
            try { await target.roles.add(role, `Duck level ${job.level} reward backfill approved by ${job.approvedBy}`); }
            catch { job.attempts[id] = (job.attempts[id] || 0) + 1; if (job.attempts[id] < 3) job.pending.push(id); }
          }
        } catch { /* Pause if authorizer or bot permissions have been revoked. */ }
      }
      if (changed) {
        // Preserve jobs added while Discord requests were in flight.
        const latest = store.read(guild.id).levelRewardBackfills || [];
        const originals = new Map(current.levelRewardBackfills.map(job => [job.roleId, JSON.stringify(job)]));
        const merged = latest.flatMap(job => JSON.stringify(job) === originals.get(job.roleId) ? jobs.filter(updated => updated.roleId === job.roleId && updated.pending.length) : [job]);
        await store.write(guild.id, { levelRewardBackfills: merged });
      }
      if (!budget) break;
    }
  } finally { backfillBusy = false; }
}
