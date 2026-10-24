import { PermissionsBitField } from "discord.js";
import { getPublicGuildSettings, getPublicModelCatalog, makeSettingsPatch, WRITABLE_SETTINGS } from "./dashboard-config.js";
import { getGuildSettings, updateGuildSettings } from "./config.js";
import { assertPresetAdmin, listPresets, preparePreset, presetDigest, runPreset, restorePreset, PRESET_TEMPLATES } from "./server-presets.js";

export const MANAGEMENT_TOOLS = ["update_server_settings", "save_server_preset", "apply_server_preset", "restore_server_preset", "delete_server_preset"];
const channelKeys = ["modChannelId", "welcomeChannelId", "logChannelId", "automodHoneypotChannelId", "aiScanFlagChannelId", "aiScanRulesChannelId", "reactionRoleChannelId", "ticketPanelChannelId", "levelAnnouncementChannelId", "suggestionChannelId", "starboardChannelId", "colorRoleChannelId"];
async function validateTargets(guild, member, patch) {
  const bot = await guild.members.fetchMe({ force: true }); const channels = await guild.channels.fetch(); const roles = await guild.roles.fetch();
  const channelIds = [...channelKeys.map(key => patch[key]), ...(patch.aiScanChannelIds || []), ...(patch.levelIgnoredChannelIds || []), ...(patch.automodChannelSlowmodes || []).map(item => item.channelId), ...(patch.scheduledPosts || []).map(item => item.channelId), ...(patch.customActions || []).map(item => item.channelId)].filter(Boolean);
  for (const id of channelIds) { const c = channels.get(id); if (!c || c.guildId !== guild.id || !c.isTextBased() || !c.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel) || !c.permissionsFor(bot)?.has(PermissionsBitField.Flags.ViewChannel)) throw new TypeError("Every channel must be visible to you and Duck in this server."); }
  if (patch.ticketCategoryId) { const c = channels.get(patch.ticketCategoryId); if (!c || c.guildId !== guild.id || c.type !== 4) throw new TypeError("Ticket category must belong to this server."); }
  const roleIds = [patch.ticketSupportRoleId, patch.ticketAdminRoleId, patch.colorRoleRequiredRoleId, ...(patch.autoroleRoleIds || []), ...(patch.reactionRoleOptions || []).map(item => item.roleId), ...(patch.levelRewards || []).map(item => item.roleId), ...(patch.colorRoleOptions || []).map(item => item.roleId), ...(patch.customActions || []).map(item => item.roleId)].filter(Boolean);
  for (const id of roleIds) { const role = roles.get(id); if (!role || role.guild.id !== guild.id || role.id === guild.id || role.managed || role.position >= bot.roles.highest.position || role.permissions.has(PermissionsBitField.Flags.Administrator)) throw new TypeError("Every role must be a safe, manageable role in this server."); }
}
function settingsDigest(current, patch) { const publicSettings = getPublicGuildSettings(current); return presetDigest(Object.fromEntries(Object.keys(patch).sort().map(key => [key, publicSettings[key]]))); }
export function prepareSettings(current, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length < 1 || Object.keys(input).length > 20 || JSON.stringify(input).length > 1800) throw new TypeError("Propose 1-20 settings at a time, with at most 1,800 characters of values for a readable approval.");
  const { patch } = makeSettingsPatch(current, input, process.env.OPENROUTER_MODEL);
  return { patch, beforeDigest: settingsDigest(current, patch), summary: `Change server settings (approval required):\n${JSON.stringify(patch, null, 2)}` };
}
export function configurationForAi(guildId, options = {}) {
  const current = getPublicGuildSettings(getGuildSettings(guildId));
  const keys = Array.isArray(options.settingKeys) ? options.settingKeys.slice(0, 20).filter(key => WRITABLE_SETTINGS.has(key)) : [...WRITABLE_SETTINGS].filter(key => !Array.isArray(current[key]) && typeof current[key] !== "object");
  const catalog = getPublicModelCatalog();
  return { writableSettings: [...WRITABLE_SETTINGS], instruction: "Use propose_server_actions for settings/presets, or propose_bulk_actions for mixed changes. Every proposal requires Administrator approval. Billing/subscription are not AI-editable. To inspect complex settings, call again with settingKeys; to inspect a full saved preset, use presetId. Do not claim execution.", settings: Object.fromEntries(keys.map(key => [key, current[key]])), presets: listPresets(guildId).filter(p => !options.presetId || p.id === options.presetId).map(p => options.presetId ? p : { id: p.id, name: p.name, schedule: p.schedule }), templates: PRESET_TEMPLATES, models: { ai: catalog.ai.map(({ id, label, tier }) => ({ id, label, tier })).slice(0, 30), tts: catalog.tts }, scheduleTimeZone: "UTC" };
}
export async function prepareManagementAction(guild, member, raw, store = { read: getGuildSettings, write: updateGuildSettings }) {
  assertPresetAdmin(member);
  if (member.guild?.id !== guild.id) throw new Error("Administrator membership must belong to this server.");
  if (!MANAGEMENT_TOOLS.includes(raw.tool)) throw new TypeError("Unsupported server-management action.");
  const base = { tool: raw.tool, risk: "critical", mandatoryApproval: true };
  const current = store.read(guild.id);
  if (raw.tool === "update_server_settings") { const prepared = prepareSettings(current, raw.settings); await validateTargets(guild, member, prepared.patch); return { ...base, settings: prepared.patch, beforeDigest: prepared.beforeDigest, summary: prepared.summary }; }
  const id = String(raw.presetId || raw.preset?.id || "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new TypeError("Choose an exact preset ID.");
  const saved = listPresets(guild.id, store.read).find(p => p.id === id);
  const existingDigest = presetDigest(saved || null);
  if (raw.tool === "restore_server_preset") { if (!current.presetRuns?.[id]) throw new Error("No active run exists for that preset."); return { ...base, presetId: id, summary: `Restore safe changes made by preset ${id}. Nonempty, occupied, or edited channels will be preserved.` }; }
  if (raw.tool === "delete_server_preset") { if (!saved) throw new Error("Preset not found."); if (current.presetRuns?.[id]) throw new Error("Restore the active run before removing its saved preset."); return { ...base, presetId: id, existingDigest, summary: `Remove saved preset ${id} and its future schedule. Existing channels are preserved; restore an active run first if needed.` }; }
  const input = raw.tool === "save_server_preset" ? raw.preset : saved || PRESET_TEMPLATES.find(p => p.id === id);
  if (!input) throw new Error("Preset not found. Read server configuration to list templates and saved presets.");
  if (raw.tool === "save_server_preset" && !saved && listPresets(guild.id, store.read).length >= 10) throw new Error("Each server supports up to 10 saved presets.");
  const prepared = await preparePreset(guild, member, input);
  if (prepared.summary.length > 1700) throw new Error("Split this preset into smaller presets so its complete preview fits in an approval.");
  const schedule = prepared.preset.schedule;
  return { ...base, presetId: id, prepared, existingDigest, applyNow: raw.tool === "save_server_preset" && raw.applyNow === true, summary: `${raw.tool === "save_server_preset" ? raw.applyNow === true ? "Save and apply now" : "Save" : "Apply"} preset ${prepared.preset.name}:\n${prepared.summary}${schedule ? `\nAnnual ${schedule.monthDay}, ${schedule.durationDays} days, UTC. ${schedule.automatic ? "This approval authorizes these exact operations automatically each year and safe restoration after the holiday." : "Ask for a fresh Discord approval each holiday."}` : "\nManual application; no automatic expiry."}` };
}
export async function executeManagementAction(guild, member, action, store = { read: getGuildSettings, write: updateGuildSettings }) {
  member = await guild.members.fetch({ user: member.id, force: true });
  assertPresetAdmin(member);
  if (member.guild?.id !== guild.id) throw new Error("Administrator membership must belong to this server.");
  const current = store.read(guild.id);
  if (action.tool === "update_server_settings") {
    if (settingsDigest(current, action.settings) !== action.beforeDigest) throw new Error("These settings changed since the preview. Ask for a fresh proposal.");
    const prepared = prepareSettings(current, action.settings); await validateTargets(guild, member, prepared.patch);
    if (settingsDigest(store.read(guild.id), action.settings) !== action.beforeDigest) throw new Error("These settings changed while the proposal was being checked. Ask for a fresh proposal.");
    store.write(guild.id, prepared.patch); return `Updated ${Object.keys(prepared.patch).join(", ")}.`;
  }
  if (action.tool === "restore_server_preset") return restorePreset(guild, member, action.presetId, { store });
  const presets = listPresets(guild.id, store.read); const existing = presets.find(p => p.id === action.presetId);
  if (presetDigest(existing || null) !== action.existingDigest) throw new Error("The saved preset changed since this proposal. Ask for a new preview.");
  if (action.tool === "delete_server_preset") { if (store.read(guild.id).presetRuns?.[action.presetId]) throw new Error("Restore the active run before removing this saved preset."); store.write(guild.id, { serverPresets: presets.filter(p => p.id !== action.presetId) }); return `Removed saved preset ${action.presetId}.`; }
  if (action.tool === "save_server_preset") {
    const fresh = await preparePreset(guild, member, action.prepared.preset);
    if (presetDigest(fresh.expected) !== presetDigest(action.prepared.expected)) throw new Error("Preset targets changed since the preview.");
    const latestPresets = listPresets(guild.id, store.read);
    if (presetDigest(latestPresets.find(p => p.id === action.presetId) || null) !== action.existingDigest) throw new Error("The preset changed while the proposal was being checked.");
    if (!existing && latestPresets.length >= 10) throw new Error("Preset limit reached.");
    const saved = { ...fresh.preset, approvedBy: member.id, approvedDigest: presetDigest(fresh.preset) };
    store.write(guild.id, { serverPresets: [...latestPresets.filter(p => p.id !== saved.id), saved], presetSeasons: { ...(store.read(guild.id).presetSeasons || {}), [saved.id]: null } });
    if (action.applyNow) return `Saved ${saved.name}. ${await runPreset(guild, member, fresh, { store })}`;
    return `Saved ${saved.name}. ${saved.schedule ? "Holiday scheduling is enabled for the approved operations." : "Apply it manually whenever you are ready."}`;
  }
  return runPreset(guild, member, action.prepared, { store });
}
