import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { SETTING_ACTIONS, SETTING_ACTION_BY_NAME, discoverSettingActions, settingWireValue } from "../src/setting-actions.js";
import { getPublicGuildSettings, WRITABLE_SETTINGS, makeSettingsPatch } from "../src/dashboard-config.js";
import { MANAGEMENT_TOOLS, prepareManagementAction, executeManagementAction } from "../src/server-management.js";
import { shouldAutoExecuteAction, planModerationToolFromText, validateAiActionToolCall, AI_TOOL_DEFINITIONS, parseAiToolArguments, serializeAiToolResult, makePlannerResponseFormat, chatWithOpenAiCompatible } from "../src/core.js";
import { getGuildSettings } from "../src/config.js";
import { profileRequest, prepareProfileAction, executeProfileAction } from "../src/bot-profile.js";
import { Collection } from "discord.js";

const guildId = "123456789012345678";
function fixture() {
  let settings = {}; let admin = true;
  const bot = { id: "323456789012345678", roles: { highest: { position: 10 } }, permissions: { has: () => true } };
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => new Map() }, roles: { cache: new Map(), fetch: async () => new Map() } };
  const member = { id: "223456789012345678", guild, permissions: { has: () => admin } };
  guild.members = { cache: new Map(), fetchMe: async () => bot, fetch: async () => member };
  return { guild, member, bot, store: { read: () => settings, write: (_, patch) => { settings = { ...settings, ...patch }; } }, setAdmin: value => { admin = value; } };
}

test("every writable setting and all four profile fields have unique typed dedicated actions and mandatory approval", () => {
  assert.equal(SETTING_ACTIONS.length, WRITABLE_SETTINGS.size + 4);
  assert.equal(new Set(SETTING_ACTIONS.map(a => a.name)).size, SETTING_ACTIONS.length);
  const current = { subscription: { tier: "plus", status: "active", provider: "owner" } };
  const defaults = getPublicGuildSettings(current);
  for (const action of SETTING_ACTIONS) {
    assert.ok(MANAGEMENT_TOOLS.includes(action.name));
    assert.ok(action.valueSchema.type, action.key);
    assert.equal(action.approval, "always");
    assert.equal(action.requiredPermission, "Administrator");
    assert.match(action.nativeDefinition.function.description, /approval/);
    assert.equal(shouldAutoExecuteAction(guildId, { tool: action.name, risk: "low" }).autoExecute, false);
    assert.equal(shouldAutoExecuteAction(guildId, { tool: "bulk_actions", actions: [{ tool: action.name, risk: "low" }] }).autoExecute, false);
    if (WRITABLE_SETTINGS.has(action.key)) {
      // Every published default can round-trip through its dedicated action's validator.
      const value = settingWireValue(action.key, defaults[action.key]);
      const patch = makeSettingsPatch(current, { [action.key]: value }).patch;
      assert.deepEqual(settingWireValue(action.key, getPublicGuildSettings({ ...current, ...patch })[action.key]), value, action.key);
    }
  }
  assert.ok(SETTING_ACTION_BY_NAME.has("set_profile_banner"));
});

test("discovery is bounded, advertises every action, and returns usable values and schemas", () => {
  const catalog = discoverSettingActions({ includeCatalog: true });
  assert.equal(catalog.catalog.length, SETTING_ACTIONS.length);
  assert.equal(catalog.actions.length, 8);
  assert.ok(AI_TOOL_DEFINITIONS.length + 32 < 128);
  for (const action of SETTING_ACTIONS) {
    const discovered = discoverSettingActions({ keys: [action.key] });
    assert.equal(discovered.actions.length, 1, action.key);
    assert.equal(discovered.actions[0].function, action.nativeName);
    assert.deepEqual(discovered.actions[0].valueSchema, action.valueSchema);
  }
  const colors = discoverSettingActions({ keys: ["starboardColor"] });
  assert.match(colors.actions[0].currentValue, /^#[0-9a-f]{6}$/);
  const serialized = JSON.parse(serializeAiToolResult(catalog));
  assert.equal(serialized.catalog.length, SETTING_ACTIONS.length);
  assert.equal(serialized.truncated, undefined);
  assert.ok(makePlannerResponseFormat("json_schema").json_schema.schema.properties.value);
});

test("Agent mode never auto-executes settings, profile, reward, or mixed bulk changes", () => {
  const settings = getGuildSettings(guildId); const previous = settings.capabilityMode;
  try {
    settings.capabilityMode = "agent";
    assert.equal(shouldAutoExecuteAction(guildId, { tool: "purge_messages", risk: "low" }).autoExecute, true);
    for (const tool of MANAGEMENT_TOOLS) {
      assert.equal(shouldAutoExecuteAction(guildId, { tool, risk: "low" }).autoExecute, false, tool);
      assert.equal(shouldAutoExecuteAction(guildId, { tool: "bulk_actions", actions: [{ tool }, { tool: "purge_messages", risk: "low" }] }).autoExecute, false, tool);
    }
  } finally { if (previous === undefined) delete settings.capabilityMode; else settings.capabilityMode = previous; }
});

test("large typed proposals are bounded separately from read tools", () => {
  const value = Array.from({ length: 10 }, (_, i) => ({ id: `post-${i}`, message: "a".repeat(800) }));
  const argumentsText = JSON.stringify({ value });
  assert.deepEqual(parseAiToolArguments({ function: { name: "propose_set_scheduled_posts", arguments: argumentsText } }).value, value);
  assert.throws(() => parseAiToolArguments({ function: { name: "inspect_server_configuration", arguments: argumentsText } }), /too large/);
});

test("native AI discovers a setting, receives its dedicated function, and produces an unexecuted proposal", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body); calls++;
    const names = (body.tools || []).map(tool => tool.function.name);
    assert.ok(names.length < 128);
    const response = (name, args) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (calls === 1) { assert.ok(names.includes("discover_setting_actions")); assert.ok(!names.includes("propose_set_automod_enabled")); return response("discover_setting_actions", { keys: ["automodEnabled"] }); }
    if (calls === 2) { assert.ok(names.includes("propose_set_automod_enabled")); return response("propose_set_automod_enabled", { value: false, reason: "Administrator requested it." }); }
    assert.equal(JSON.parse(body.messages.at(-1).content).accepted, true);
    return Response.json({ choices: [{ message: { role: "assistant", content: "Ready for Administrator approval." } }] });
  });
  const f = fixture(); const message = { guild: null, guildId, channelId: "423456789012345678", id: "523456789012345678", author: { id: f.member.id, tag: "requester" }, member: f.member, content: "Disable AutoMod", cleanContent: "Disable AutoMod", createdAt: new Date(), attachments: new Map() };
  const before = getGuildSettings(guildId).automodEnabled;
  const answer = await chatWithOpenAiCompatible(message, { baseUrl: "https://mock.invalid/v1", apiKey: "test-key", model: "test", providerName: "test" });
  assert.equal(calls, 3); assert.equal(answer.plan.tool, "set_automod_enabled"); assert.equal(answer.plan.value, false);
  assert.equal(answer.plan.mandatoryApproval, true); assert.equal(getGuildSettings(guildId).automodEnabled, before);
});

test("logging channel aliases receive same-server and stale-approval checks", async () => {
  const f = fixture(); const id = "423456789012345678";
  await assert.rejects(prepareManagementAction(f.guild, f.member, { tool: "set_log_channel_id", value: id }, f.store), /Every channel/);
  f.guild.channels.fetch = async () => new Map([[id, { id, guildId, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) }]]);
  const action = await prepareManagementAction(f.guild, f.member, { tool: "set_log_channel_id", value: id }, f.store);
  f.store.write(guildId, { entryChannels: { logChannelId: "523456789012345678" } });
  await assert.rejects(executeManagementAction(f.guild, f.member, action, f.store), /changed since/);
});

test("dedicated settings preview is read-only, preserves unrelated fields, and refuses stale or revoked approvals", async () => {
  const f = fixture(); f.store.write(guildId, { welcomeMessage: "untouched" });
  const action = await prepareManagementAction(f.guild, f.member, { tool: "set_automod_enabled", value: false }, f.store);
  assert.equal(f.store.read().automodEnabled, undefined);
  await executeManagementAction(f.guild, f.member, action, f.store);
  assert.equal(f.store.read().automodEnabled, false);
  assert.equal(f.store.read().welcomeMessage, "untouched");
  const stale = await prepareManagementAction(f.guild, f.member, { tool: "set_command_prefix", value: "!" }, f.store);
  f.store.write(guildId, { commandPrefix: "$" });
  await assert.rejects(executeManagementAction(f.guild, f.member, stale, f.store), /changed since/);
  f.setAdmin(false);
  await assert.rejects(executeManagementAction(f.guild, f.member, action, f.store), /Administrator/);
  await assert.rejects(prepareManagementAction(f.guild, f.member, { tool: "set_automod_enabled", value: "true" }, f.store), /Administrator/);
});

test("hex colors retain their input representation through preview and normalize once when applied", async () => {
  const f = fixture();
  const action = await prepareManagementAction(f.guild, f.member, { tool: "set_color_role_accent", value: "#123456" }, f.store);
  assert.equal(action.settings.colorRoleAccent, "#123456");
  await executeManagementAction(f.guild, f.member, action, f.store);
  assert.equal(f.store.read().colorRoleAccent, 0x123456);
});

test("AI plans the exact level reward request and rejects using the sentence as a plain role name", () => {
  const f = fixture(); const content = "hey when you reach level 5 make a role named risen and give it to level 5 people";
  const message = { guildId, guild: f.guild, member: f.member, content, mentions: { members: new Collection() } };
  const plan = planModerationToolFromText(message, content);
  assert.equal(plan.tool, "create_level_reward"); assert.equal(plan.roleName, "risen"); assert.equal(plan.level, 5); assert.equal(plan.includeExisting, true);
  const result = validateAiActionToolCall(message, { function: { name: "propose_role_actions", arguments: JSON.stringify({ actions: [{ tool: "create_role", roleName: content }] }) } }, { members: [], channels: [], roles: [] });
  assert.match(result.error, /level-reward/);
});

test("obsolete saved themes migrate to standard while XP remains available", async () => {
  const source = await readFile(new URL("../public/theme-init.js", import.meta.url), "utf8");
  for (const saved of ["dark", "matrix", "galaxy", "gradient", "windows-xp", "classic", null]) {
    const dataset = {}; const values = new Map([["duck-theme", saved]]);
    vm.runInNewContext(source, { document: { documentElement: { dataset } }, localStorage: { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) } });
    assert.equal(dataset.theme, saved === "windows-xp" ? "windows-xp" : "classic");
  }
});

test("profile actions require entitlement and snapshot only request-attached Discord images", async () => {
  const f = fixture(); const spec = SETTING_ACTION_BY_NAME.get("set_profile_avatar");
  assert.throws(() => profileRequest({ attachments: new Map() }, spec, "999999999999999999"), /attached/);
  await assert.rejects(prepareProfileAction(f.guild, spec, { value: null }, {}), /paid Duck Plus/);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const attachmentId = "423456789012345678";
  const request = profileRequest({ attachments: new Map([[attachmentId, { url: `https://cdn.discordapp.com/attachments/${guildId}/${attachmentId}/image.png`, contentType: "image/png", name: "image.png", size: png.length }]]) }, spec, attachmentId);
  const settings = { subscription: { tier: "plus", status: "active", provider: "owner" } };
  const action = await prepareProfileAction(f.guild, spec, request, settings, async () => new Response(png));
  assert.equal(action.image.sizeBytes, png.length); assert.match(action.image.sha256, /^[0-9a-f]{64}$/); assert.doesNotMatch(action.summary, /base64/);
  let body; f.guild.client = { rest: { patch: async (_, options) => { body = options.body; } } };
  await executeProfileAction(f.guild, f.member, action, settings); assert.ok(body.avatar.startsWith("data:image/png;base64,"));
  f.bot.avatar = "another-avatar";
  await assert.rejects(executeProfileAction(f.guild, f.member, action, settings), /changed since/);
  await assert.rejects(prepareProfileAction(f.guild, spec, { ...request, profileAttachment: { ...request.profileAttachment, url: "http://127.0.0.1/private" } }, settings), /Discord attachment/);
});
