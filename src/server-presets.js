import { createHash, randomUUID } from "node:crypto";
import { ChannelType, PermissionsBitField } from "discord.js";
import { getGuildSettings, updateGuildSettings, flushJsonWrites } from "./config.js";

const locks = new Set();
const DAY = 86_400_000;
export const HOLIDAYS = Object.freeze({ halloween: "10-31", christmas: "12-25", "new-year": "01-01", valentine: "02-14" });
export const PRESET_TEMPLATES = Object.freeze([
  { id: "community", name: "Community starter", operations: [{ kind: "create_category", key: "community", name: "Community" }, { kind: "create_text", name: "general", parentKey: "community" }, { kind: "create_voice", name: "Lounge", parentKey: "community" }] },
  { id: "halloween", name: "Halloween", operations: [{ kind: "create_category", key: "holiday", name: "Halloween" }, { kind: "create_text", name: "spooky-chat", parentKey: "holiday" }, { kind: "create_voice", name: "Haunted lounge", parentKey: "holiday" }] },
  { id: "christmas", name: "Christmas", operations: [{ kind: "create_category", key: "holiday", name: "Christmas" }, { kind: "create_text", name: "festive-chat", parentKey: "holiday" }, { kind: "create_voice", name: "Winter lounge", parentKey: "holiday" }] },
  { id: "new-year", name: "New Year", operations: [{ kind: "create_category", key: "holiday", name: "New Year" }, { kind: "create_text", name: "new-year-plans", parentKey: "holiday" }] },
]);
const kinds = new Set(["create_category", "create_text", "create_voice", "rename", "delete"]);
const ownObject = value => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => !["__proto__", "constructor", "prototype"].includes(key));
export const presetDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function checkedId(value) { if (typeof value !== "string" || !/^\d{10,20}$/.test(value)) throw new TypeError("Use an exact channel or category ID from this server."); return value; }
function checkedName(value) { if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\r\n\x00-\x1f]/.test(value)) throw new TypeError("Names must contain 1-100 characters on one line."); return value.trim(); }
export function normalizePreset(input) {
  if (!ownObject(input)) throw new TypeError("A preset must be an object.");
  const id = String(input.id || "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new TypeError("Preset IDs use up to 40 lowercase letters, digits, and hyphens.");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 25) throw new TypeError("A preset needs 1-25 operations.");
  const keys = new Set(); const targets = new Set();
  const operations = input.operations.map(raw => {
    if (!ownObject(raw) || !kinds.has(raw.kind)) throw new TypeError("Unsupported preset operation.");
    const op = { kind: raw.kind };
    if (raw.kind === "rename" || raw.kind === "delete") { op.channelId = checkedId(raw.channelId); if (targets.has(op.channelId)) throw new TypeError("A preset can target each existing channel only once."); targets.add(op.channelId); }
    if (raw.kind !== "delete") op.name = checkedName(raw.name);
    if (raw.parentId) op.parentId = checkedId(raw.parentId);
    if (raw.parentKey) { if (!keys.has(raw.parentKey)) throw new TypeError("Create the referenced category before its children."); op.parentKey = raw.parentKey; }
    if ((op.parentId || op.parentKey) && !["create_text", "create_voice"].includes(raw.kind)) throw new TypeError("Only new text or voice channels can specify a parent.");
    if (op.parentId && op.parentKey) throw new TypeError("Choose one parent category.");
    if (raw.kind === "create_category") { const key = raw.key || `category-${keys.size + 1}`; if (!/^[a-z0-9-]{1,40}$/.test(key) || keys.has(key)) throw new TypeError("Category keys must be unique lowercase names."); keys.add(key); op.key = key; }
    return op;
  });
  let schedule = null;
  if (input.schedule?.enabled) {
    if (!ownObject(input.schedule)) throw new TypeError("Invalid holiday schedule.");
    const monthDay = HOLIDAYS[input.schedule.holiday] || input.schedule.monthDay;
    if (!/^\d{2}-\d{2}$/.test(String(monthDay))) throw new TypeError("Choose a holiday or a custom MM-DD date.");
    const date = new Date(`2024-${monthDay}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(5, 10) !== monthDay) throw new TypeError("Invalid holiday date.");
    const durationDays = input.schedule.durationDays;
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) throw new TypeError("Holiday duration must be 1-30 days.");
    if (operations.some(op => op.kind === "delete")) throw new TypeError("Holiday presets cannot delete existing channels: deleted messages cannot be restored. Use a manual preset for deletion.");
    schedule = { enabled: true, monthDay, durationDays, automatic: input.schedule.automatic === true, channelId: checkedId(input.schedule.channelId) };
  }
  return { id, name: checkedName(input.name), operations, schedule };
}
export function holidayWindow(schedule, now = Date.now()) {
  if (!schedule?.enabled) return null;
  const year = new Date(now).getUTCFullYear();
  for (const y of [year - 1, year]) { const start = Date.parse(`${y}-${schedule.monthDay}T00:00:00Z`); if (!Number.isFinite(start) || new Date(start).toISOString().slice(5, 10) !== schedule.monthDay) continue; const end = start + schedule.durationDays * DAY; if (now >= start && now < end) return { key: `${y}-${schedule.monthDay}`, start, end }; }
  return null;
}
export function assertPresetAdmin(member) { if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator)) throw new Error("Administrator permission is required for server presets."); }
async function resources(guild, member) {
  assertPresetAdmin(member);
  if (member.guild?.id !== guild.id) throw new Error("Administrator membership must belong to this server.");
  const bot = await guild.members.fetchMe({ force: true });
  if (!bot.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error("Duck needs Manage Channels for server presets.");
  return { bot, channels: await guild.channels.fetch() };
}
function assertEditable(channel, guild, member, bot) {
  if (!channel || channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(channel.type)) throw new Error("Target must be a text channel, voice channel, or category in this server.");
  for (const actor of [member, bot]) if (!channel.permissionsFor(actor)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageChannels])) throw new Error("Both you and Duck must be able to view and manage every target.");
}
export async function preparePreset(guild, member, input) {
  const preset = normalizePreset(input); const { bot, channels } = await resources(guild, member);
  const expected = {};
  for (const op of preset.operations) {
    if (op.channelId) { const channel = channels.get(op.channelId); assertEditable(channel, guild, member, bot); if (op.kind === "delete" && channel.type === ChannelType.GuildCategory && [...channels.values()].some(c => c?.parentId === channel.id)) throw new Error("Only empty categories can be deleted."); expected[channel.id] = { name: channel.name, parentId: channel.parentId, type: channel.type }; }
    if (op.parentId) { const parent = channels.get(op.parentId); assertEditable(parent, guild, member, bot); if (parent.type !== ChannelType.GuildCategory) throw new Error("Parent must be a category."); expected[parent.id] = { name: parent.name, parentId: parent.parentId, type: parent.type }; }
  }
  if (preset.schedule) { const channel = channels.get(preset.schedule.channelId); if (!channel?.isTextBased() || channel.guildId !== guild.id || !channel.permissionsFor(bot)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]) || !channel.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel)) throw new Error("Choose a visible notification channel where Duck can send approvals."); }
  return { preset, expected, summary: preset.operations.map((op, i) => `${i + 1}. ${op.kind.replaceAll("_", " ")}: ${op.channelId ? `#${channels.get(op.channelId).name} (${op.channelId})` : "new channel"}${op.name ? ` → ${op.name}` : " (permanent; messages cannot be restored)"}`).join("\n") };
}
export function listPresets(guildId, read = getGuildSettings) { return read(guildId).serverPresets || []; }
async function durableWrite(guildId, patch, store) { await store.write(guildId, patch); if (store.write === updateGuildSettings) await flushJsonWrites(); }
const defaultStore = { read: getGuildSettings, write: updateGuildSettings };
export async function runPreset(guild, member, prepared, { now = Date.now(), store = defaultStore } = {}) {
  if (locks.has(guild.id)) throw new Error("A preset is already running for this server.");
  locks.add(guild.id);
  try {
    const fresh = await preparePreset(guild, member, prepared.preset);
    if (presetDigest(fresh.expected) !== presetDigest(prepared.expected)) throw new Error("Channels changed since this preview. Prepare a new approval.");
    const runs = { ...(store.read(guild.id).presetRuns || {}) };
    if (runs[fresh.preset.id]?.entries?.length || runs[fresh.preset.id]?.status === "running") throw new Error("Restore the active preset before applying it again.");
    const run = { id: randomUUID(), presetId: fresh.preset.id, startedAt: now, expiresAt: fresh.preset.schedule ? now + fresh.preset.schedule.durationDays * DAY : null, approvedBy: member.id, status: "running", entries: [] };
    runs[fresh.preset.id] = run;
    const persist = () => durableWrite(guild.id, { presetRuns: runs }, store);
    await persist(); const parents = new Map();
    try {
      for (const op of fresh.preset.operations) {
        // Refresh permission and membership before every mutation, including long runs.
        member = await guild.members.fetch({ user: member.id, force: true });
        const { bot, channels } = await resources(guild, member); const reason = `Duck preset ${fresh.preset.name}, approved by ${member.id}`;
        if (op.kind.startsWith("create_")) {
          const parent = op.parentId || parents.get(op.parentKey);
          if (parent) assertEditable(channels.get(parent), guild, member, bot);
          const created = await guild.channels.create({ name: op.name, type: op.kind === "create_category" ? ChannelType.GuildCategory : op.kind === "create_voice" ? ChannelType.GuildVoice : ChannelType.GuildText, ...(parent ? { parent } : {}), reason });
          if (op.key) parents.set(op.key, created.id);
          run.entries.push({ kind: "created", channelId: created.id, appliedName: created.name, parentId: created.parentId ?? null, type: created.type });
        } else {
          const channel = channels.get(op.channelId); assertEditable(channel, guild, member, bot);
          if (presetDigest({ name: channel.name, parentId: channel.parentId, type: channel.type }) !== presetDigest(fresh.expected[channel.id])) throw new Error("A target changed during execution; remaining operations stopped.");
          if (op.kind === "rename") { const originalName = channel.name; await channel.setName(op.name, reason); run.entries.push({ kind: "renamed", channelId: channel.id, originalName, appliedName: channel.name, parentId: channel.parentId ?? null, type: channel.type }); }
          else { if (channel.type === ChannelType.GuildCategory && [...channels.values()].some(c => c?.parentId === channel.id)) throw new Error("Category is no longer empty."); await channel.delete(reason); run.entries.push({ kind: "deleted", channelId: channel.id, originalName: channel.name }); }
        }
        await persist();
      }
      run.status = "active"; await persist();
      return `Applied ${fresh.preset.name}: ${run.entries.length} operations. Deleted channels/messages cannot be recovered. Restore only removes empty created channels and restores unchanged names.`;
    } catch (error) { run.status = "needs_attention"; await persist(); throw new Error(`Preset stopped after ${run.entries.length} operations: ${error.message}. Use restore to undo safe changes.`); }
  } finally { locks.delete(guild.id); }
}
export async function restorePreset(guild, member, presetId, { store = defaultStore } = {}) {
  assertPresetAdmin(member);
  if (locks.has(guild.id)) throw new Error("A preset is already running for this server.");
  locks.add(guild.id);
  try {
    const runs = { ...(store.read(guild.id).presetRuns || {}) }; const run = runs[presetId];
    if (!run) throw new Error("That preset has no active run.");
    const kept = []; let restored = 0;
    for (const entry of [...run.entries].reverse()) {
      try {
        member = await guild.members.fetch({ user: member.id, force: true });
        const { bot, channels } = await resources(guild, member); const channel = channels.get(entry.channelId);
        if (entry.kind === "deleted" || !channel) continue;
        assertEditable(channel, guild, member, bot);
        if (channel.name !== entry.appliedName || (channel.parentId ?? null) !== entry.parentId || channel.type !== entry.type) { kept.unshift(entry); continue; }
        if (entry.kind === "renamed") await channel.setName(entry.originalName, "Duck preset restore");
        else {
          if (channel.type === ChannelType.GuildCategory && [...channels.values()].some(c => c?.parentId === channel.id)) { kept.unshift(entry); continue; }
          if (channel.type === ChannelType.GuildVoice && channel.members?.size) { kept.unshift(entry); continue; }
          if (channel.type === ChannelType.GuildText && (await channel.messages.fetch({ limit: 1 })).size) { kept.unshift(entry); continue; }
          await channel.delete("Duck preset restore: empty channel created by this preset");
        }
        restored++;
      } catch { kept.unshift(entry); }
    }
    if (kept.length) runs[presetId] = { ...run, status: "needs_attention", entries: kept, expiresAt: null };
    else delete runs[presetId];
    await durableWrite(guild.id, { presetRuns: runs }, store);
    return `Restored ${restored} changes. Preserved ${kept.length} changed, occupied, nonempty, or inaccessible channels. Deleted messages cannot be restored.`;
  } finally { locks.delete(guild.id); }
}
let schedulerBusy = false;
export async function tickPresets(client, requestApproval, now = Date.now(), store = defaultStore) {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      for (const raw of listPresets(guild.id, store.read)) {
        try {
          const preset = normalizePreset(raw); const current = store.read(guild.id);
          const window = holidayWindow(preset.schedule, now);
          const run = current.presetRuns?.[preset.id];
          if (!(run?.expiresAt && now >= run.expiresAt) && (!window || run || current.presetSeasons?.[preset.id] === window.key)) continue;
          const member = await guild.members.fetch({ user: raw.approvedBy, force: true }).catch(() => null);
          assertPresetAdmin(member);
          if (run?.expiresAt && now >= run.expiresAt && !locks.has(guild.id)) { await restorePreset(guild, member, preset.id, { store }); continue; }
          if (!window || run || current.presetSeasons?.[preset.id] === window.key) continue;
          const prepared = await preparePreset(guild, member, preset);
          if (preset.schedule.automatic) {
            // Saved approval authorizes only this exact preset; no later edits bypass review.
            if (raw.approvedDigest !== presetDigest(preset)) continue;
            await runPreset(guild, member, prepared, { now: window.start, store });
          } else await requestApproval(guild, member, prepared);
          await durableWrite(guild.id, { presetSeasons: { ...(store.read(guild.id).presetSeasons || {}), [preset.id]: window.key } }, store);
        } catch { /* Keep other servers running; failed/partial runs remain available for review. */ }
      }
    }
  } finally { schedulerBusy = false; }
}
export function startPresetScheduler(client, requestApproval) {
  const timer = setInterval(() => tickPresets(client, requestApproval).catch(() => {}), 60_000); timer.unref?.();
  tickPresets(client, requestApproval).catch(() => {}); return timer;
}
