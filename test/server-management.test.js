import assert from "node:assert/strict";
import test from "node:test";
import { PermissionsBitField } from "discord.js";
import { holidayWindow, normalizePreset, preparePreset, presetDigest, runPreset, restorePreset, tickPresets } from "../src/server-presets.js";
import { prepareSettings, prepareManagementAction, executeManagementAction } from "../src/server-management.js";
import { claimTrial, trialAvailable, PLUS_TRIAL_MS } from "../src/plus-trial.js";
import { hasPlusEntitlement, hasMaturePlusEntitlement } from "../src/dashboard-config.js";
import { shouldAutoExecuteAction, validateAiActionToolCall, executeAiReadTool } from "../src/core.js";
import { createChatActivity, handleChatActivity } from "../src/chat-activity.js";

function fixture() {
  const guild = { id: "123456789012345678" }; let admin = true; let botAllowed = true; let stored = {}; let next = 700000000000000000n;
  const member = { id: "223456789012345678", guild, permissions: { has: () => admin } };
  const bot = { id: "323456789012345678", permissions: { has: () => botAllowed }, roles: { highest: { position: 10 } } };
  const channels = new Map(); const calls = [];
  const add = (id, name, type = 0, parentId = null) => {
    const channel = { id, name, type, parentId, guildId: guild.id, isTextBased: () => type === 0, permissionsFor: () => ({ has: () => botAllowed }), members: new Map(), messages: { fetch: async () => new Map() }, async setName(value) { calls.push(["rename", id]); channel.name = value; return channel; }, async delete() { calls.push(["delete", id]); channels.delete(id); } };
    channels.set(id, channel); return channel;
  };
  guild.channels = { cache: channels, fetch: async id => id ? channels.get(id) : channels, create: async input => { calls.push(["create", input.name]); return add(String(++next), input.name, input.type, input.parent ?? null); } };
  guild.members = { fetch: async () => member, fetchMe: async () => bot }; guild.roles = { fetch: async () => new Map() };
  const store = { read: () => stored, write: (_, patch) => { stored = structuredClone({ ...stored, ...patch }); } };
  return { guild, member, channels, calls, add, store, setAdmin: value => { admin = value; }, setBotAllowed: value => { botAllowed = value; } };
}

test("preset normalization rejects foreign-shaped data, duplicate targets, and irreversible holiday deletion", () => {
  const base = { id: "test", name: "Test", operations: [{ kind: "create_text", name: "chat" }] };
  assert.throws(() => normalizePreset({ ...base, id: "__proto__" }));
  assert.throws(() => normalizePreset({ ...base, operations: [{ kind: "rename", channelId: "123", name: "bad" }] }));
  assert.throws(() => normalizePreset({ ...base, operations: [{ kind: "create_text", name: "chat", parentKey: "missing" }] }));
  assert.throws(() => normalizePreset({ ...base, schedule: { enabled: true, monthDay: "02-30", durationDays: 7, channelId: "123456789012345678" } }));
  assert.throws(() => normalizePreset({ ...base, operations: [{ kind: "delete", channelId: "123456789012345678" }], schedule: { enabled: true, holiday: "halloween", durationDays: 7, channelId: "123456789012345678" } }), /cannot delete/);
  assert.throws(() => normalizePreset({ ...base, operations: Array(26).fill(base.operations[0]) }), /1-25/);
});

test("annual holiday windows handle year boundaries and expiry", () => {
  const schedule = { enabled: true, monthDay: "12-25", durationDays: 10 };
  const window = holidayWindow(schedule, Date.parse("2027-01-02T00:00:00Z"));
  assert.equal(window.key, "2026-12-25");
  assert.equal(holidayWindow(schedule, window.end), null);
  assert.equal(holidayWindow(schedule, Date.parse("2026-12-24T23:59:59Z")), null);
  assert.equal(holidayWindow({ enabled: true, monthDay: "02-29", durationDays: 7 }, Date.parse("2027-03-01T00:00:00Z")), null);
});

test("holiday scheduling asks once per season, executes only an approved exact plan, and restores on expiry", async () => {
  const f = fixture(); const notification = f.add("423456789012345678", "staff");
  const preset = normalizePreset({ id: "holiday", name: "Holiday", operations: [{ kind: "create_text", name: "holiday-chat" }], schedule: { enabled: true, holiday: "halloween", durationDays: 2, automatic: false, channelId: notification.id } });
  f.store.write(f.guild.id, { serverPresets: [{ ...preset, approvedBy: f.member.id, approvedDigest: presetDigest(preset) }] });
  const client = { guilds: { cache: new Map([[f.guild.id, f.guild]]) } }; let prompts = 0;
  const now = Date.parse("2026-10-31T12:00:00Z");
  await tickPresets(client, async () => { prompts++; }, now, f.store);
  await tickPresets(client, async () => { prompts++; }, now, f.store);
  assert.equal(prompts, 1); assert.equal(f.calls.length, 0);
  const automatic = { ...preset, schedule: { ...preset.schedule, automatic: true } };
  f.store.write(f.guild.id, { serverPresets: [{ ...automatic, approvedBy: f.member.id, approvedDigest: "stale-digest" }], presetSeasons: {} });
  await tickPresets(client, async () => {}, now, f.store); assert.equal(f.calls.length, 0);
  f.store.write(f.guild.id, { serverPresets: [{ ...automatic, approvedBy: f.member.id, approvedDigest: presetDigest(automatic) }] });
  await tickPresets(client, async () => {}, now, f.store); assert.equal(f.calls.length, 1);
  await tickPresets(client, async () => {}, now, f.store); assert.equal(f.calls.length, 1);
  await tickPresets(client, async () => {}, Date.parse("2026-11-02T00:00:00Z"), f.store);
  assert.equal(f.store.read().presetRuns.holiday, undefined); assert.equal(f.channels.size, 1);
});

test("preset preview makes no mutations and apply rejects changed targets or revoked permissions", async () => {
  const f = fixture(); const channel = f.add("423456789012345678", "general");
  const prepared = await preparePreset(f.guild, f.member, { id: "season", name: "Season", operations: [{ kind: "rename", channelId: channel.id, name: "spooky" }] });
  assert.equal(f.calls.length, 0);
  channel.name = "staff-edit";
  await assert.rejects(runPreset(f.guild, f.member, prepared, { store: f.store }), /changed since/);
  channel.name = "general"; f.setAdmin(false);
  await assert.rejects(runPreset(f.guild, f.member, prepared, { store: f.store }), /Administrator/);
  assert.equal(f.calls.length, 0);
  f.setAdmin(true); f.setBotAllowed(false);
  await assert.rejects(preparePreset(f.guild, f.member, prepared.preset), /Manage Channels/);
});

test("preset targets cannot cross guilds, and populated categories cannot be deleted", async () => {
  const f = fixture(); const channel = f.add("423456789012345678", "foreign"); channel.guildId = "999999999999999999";
  await assert.rejects(preparePreset(f.guild, f.member, { id: "bad", name: "Bad", operations: [{ kind: "delete", channelId: channel.id }] }), /this server/);
  const category = f.add("523456789012345678", "category", 4); f.add("623456789012345678", "child", 0, category.id);
  await assert.rejects(preparePreset(f.guild, f.member, { id: "bad", name: "Bad", operations: [{ kind: "delete", channelId: category.id }] }), /empty categories/);
  assert.equal(f.calls.length, 0);
});

test("apply records creations and renames, refuses duplicate application, and safely restores", async () => {
  const f = fixture(); const original = f.add("423456789012345678", "general");
  const prepared = await preparePreset(f.guild, f.member, { id: "event", name: "Event", operations: [{ kind: "create_category", key: "event", name: "Event" }, { kind: "create_text", parentKey: "event", name: "event-chat" }, { kind: "rename", channelId: original.id, name: "festive" }] });
  await runPreset(f.guild, f.member, prepared, { store: f.store });
  assert.equal(f.store.read().presetRuns.event.entries.length, 3);
  await assert.rejects(runPreset(f.guild, f.member, await preparePreset(f.guild, f.member, prepared.preset), { store: f.store }), /Restore/);
  await restorePreset(f.guild, f.member, "event", { store: f.store });
  assert.equal(original.name, "general"); assert.equal(f.channels.size, 1); assert.equal(f.store.read().presetRuns.event, undefined);
});

test("restore preserves newly populated channels and subsequent moderator edits", async () => {
  const f = fixture(); const original = f.add("423456789012345678", "general");
  const prepared = await preparePreset(f.guild, f.member, { id: "event", name: "Event", operations: [{ kind: "create_text", name: "new-chat" }, { kind: "rename", channelId: original.id, name: "festive" }] });
  await runPreset(f.guild, f.member, prepared, { store: f.store });
  original.name = "staff-update";
  const created = [...f.channels.values()].find(c => c.id !== original.id); created.messages.fetch = async () => new Map([["message", {}]]);
  const result = await restorePreset(f.guild, f.member, "event", { store: f.store });
  assert.match(result, /Preserved 2/); assert.equal(f.channels.size, 2); assert.equal(original.name, "staff-update");
});

test("settings use the dashboard allowlist and reject billing, prototype keys, and Plus bypasses", () => {
  assert.deepEqual(prepareSettings({}, { automodEnabled: true }).patch, { automodEnabled: true });
  for (const input of [{ subscription: { tier: "plus" } }, { plusTrialUsedAt: null }, JSON.parse('{"__proto__":{"admin":true}}'), { automodMentionLimit: -1 }, { aiPersonality: "custom" }]) assert.throws(() => prepareSettings({}, input));
  assert.deepEqual(prepareSettings({}, { automodCustomWords: ["spam"] }).patch.automodCustomWords, ["spam"]);
});

test("settings proposals require live Administrator permission and stale approvals are rejected", async () => {
  const f = fixture();
  const action = await prepareManagementAction(f.guild, f.member, { tool: "update_server_settings", settings: { automodEnabled: true } }, f.store);
  assert.equal(f.store.read().automodEnabled, undefined);
  f.store.write(f.guild.id, { automodEnabled: true });
  await assert.rejects(executeManagementAction(f.guild, f.member, action, f.store), /changed since/);
  f.setAdmin(false);
  await assert.rejects(prepareManagementAction(f.guild, f.member, { tool: "update_server_settings", settings: { automodEnabled: true } }, f.store), /Administrator/);
});

test("saving and applying a custom preset is one explicit approved action", async () => {
  const f = fixture();
  const action = await prepareManagementAction(f.guild, f.member, { tool: "save_server_preset", applyNow: true, preset: { id: "event", name: "Event", operations: [{ kind: "create_text", name: "event-chat" }] } }, f.store);
  assert.match(action.summary, /Save and apply now/); assert.equal(f.calls.length, 0);
  await executeManagementAction(f.guild, f.member, action, f.store);
  assert.equal(f.calls.length, 1); assert.equal(f.store.read().serverPresets.length, 1);
  assert.equal(f.store.read().presetRuns.event.status, "active");
});

test("settings reject cross-server channel IDs at preview time", async () => {
  const f = fixture();
  await assert.rejects(prepareManagementAction(f.guild, f.member, { tool: "update_server_settings", settings: { welcomeChannelId: "999999999999999999" } }, f.store), /Every channel/);
});

test("management always requires approval, including mixed bulk actions", () => {
  for (const tool of ["update_server_settings", "save_server_preset", "apply_server_preset", "restore_server_preset", "delete_server_preset"]) {
    assert.equal(shouldAutoExecuteAction("123456789012345678", { tool, risk: "low" }).autoExecute, false);
    assert.equal(shouldAutoExecuteAction("123456789012345678", { tool: "bulk_actions", actions: [{ tool, risk: "low" }, { tool: "purge_messages", risk: "low" }] }).autoExecute, false);
  }
});

test("AI exposes mixed bulk proposals and refuses configuration reads to non-admins", async () => {
  const f = fixture(); const channel = f.add("423456789012345678", "general");
  const message = { guild: f.guild, guildId: f.guild.id, member: f.member, channel, channelId: channel.id, content: "Set slowmode to 5 and enable AutoMod" };
  const result = validateAiActionToolCall(message, { function: { name: "propose_bulk_actions", arguments: JSON.stringify({ actions: [{ tool: "set_slowmode", channelId: channel.id, seconds: 5 }, { tool: "update_server_settings", settings: { automodEnabled: true } }] }) } }, { members: [], channels: [{ id: channel.id, name: channel.name }], roles: [] });
  assert.equal(result.error, undefined); assert.equal(result.actions.length, 2);
  f.setAdmin(false);
  await assert.rejects(executeAiReadTool(message, { function: { name: "inspect_server_configuration", arguments: "{}" } }), /Administrator/);
});

test("Plus trial lasts exactly seven days, cannot repeat, and does not grant paid loyalty", () => {
  const now = Date.parse("2026-10-24T00:00:00Z"); const trial = claimTrial({}, "123456789012345678", now);
  assert.equal(Date.parse(trial.subscription.expiresAt) - now, PLUS_TRIAL_MS);
  assert.equal(hasPlusEntitlement(trial, now + PLUS_TRIAL_MS - 1), true);
  assert.equal(hasPlusEntitlement(trial, now + PLUS_TRIAL_MS), false);
  assert.equal(hasMaturePlusEntitlement(trial, now), false);
  assert.equal(trialAvailable(trial, now + PLUS_TRIAL_MS), false);
  assert.throws(() => claimTrial(trial, "other", now + PLUS_TRIAL_MS), /already used/);
  assert.throws(() => claimTrial({ subscription: { tier: "plus", status: "active", provider: "stripe" } }, "user", now));
});

test("progress updates during provider waits and stops cleanly before the final response", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); let now = 0; const updates = [];
  const activity = createChatActivity("user", async payload => updates.push(payload), () => now);
  await activity.start(); const initial = updates.length;
  now = 2500; t.mock.timers.tick(2500); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, initial + 1); assert.match(updates.at(-1).embeds[0].description, /3s/);
  await activity.stop(); now = 5000; t.mock.timers.tick(2500); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, initial + 1);
  activity.finish({ content: "Done" }); t.mock.timers.reset();
});

test("progress heartbeat preserves an outstanding approval instead of replacing its buttons", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); let now = 0; let panel; let updates = 0;
  const activity = createChatActivity("owner", async payload => { panel = payload; updates++; }, () => now);
  await activity.start(); const decision = activity.approveWeb("https://example.org/");
  await new Promise(resolve => setImmediate(resolve)); const initial = updates;
  const customId = panel.components[0].toJSON().components[1].custom_id;
  now = 5000; t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates, initial);
  assert.equal(panel.components[0].toJSON().components[1].custom_id, customId);
  await handleChatActivity({ customId, user: { id: "owner" }, update: async () => {} });
  assert.equal(await decision, false); await activity.stop(); t.mock.timers.reset();
});
