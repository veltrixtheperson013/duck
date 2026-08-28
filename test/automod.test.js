import assert from "node:assert/strict";
import test from "node:test";
import { customActionMatches, detectViolation, handleHoneypot, includesTerm, normalizedHoneypotStats } from "../src/automod.js";
import { trimWarningStore } from "../src/config.js";

test("AutoMod term matching uses normalized whole words and phrases", () => {
  assert.equal(includesTerm("This is PORN!", ["porn"]), true);
  assert.equal(includesTerm("that is a spoiler alert", ["spoiler alert"]), true);
  assert.equal(includesTerm("a class assignment", ["ass"]), false);
});

test("AutoMod checks enabled text and attachment-name filters", () => {
  const base = { content: "ordinary message", attachments: new Map() };
  assert.equal(detectViolation({ ...base, content: "a porn link" }, { automodNsfwFilter: true }), "Sexual or NSFW content");
  assert.equal(detectViolation({ ...base, attachments: new Map([["1", { name: "nudes.zip" }]]) }, { automodNsfwFilter: true }), "Sexual or NSFW content");
  assert.equal(detectViolation({ ...base, content: "hidden pond phrase" }, { automodCustomWords: ["pond phrase"] }), "Custom blocked phrase");
  assert.equal(detectViolation(base, { automodSwearFilter: false, automodNsfwFilter: false }), null);
});

test("AutoMod detects invite links, mention spam, and excessive caps locally", () => {
  const base = { attachments: new Map(), mentions: { users: new Map() } };
  assert.equal(detectViolation({ ...base, content: "join https://discord.gg/example" }, { automodInviteFilter: true }), "Discord invite link");
  assert.match(detectViolation({ ...base, content: "hello", mentions: { users: new Map([["1", {}], ["2", {}], ["3", {}]]) } }, { automodMentionLimit: 2 }), /Too many/);
  assert.equal(detectViolation({ ...base, content: "THIS MESSAGE IS VERY LOUD" }, { automodCapsFilter: true }), "Excessive capital letters");
});

test("custom actions match only allowlisted server-side conditions", () => {
  const botId = "323456789012345678";
  const message = { content: "Hello Duck! https://duck.example", channelId: "123456789012345678", author: { id: "223456789012345678" }, attachments: new Map([["1", {}]]), client: { user: { id: botId } }, mentions: { users: new Map([[botId, {}]]) } };
  const base = { enabled: true, channelId: null, userId: null, triggerType: "contains", triggerValue: "hello duck" };
  assert.equal(customActionMatches(base, message), true);
  assert.equal(customActionMatches({ ...base, channelId: "999999999999999999" }, message), false);
  assert.equal(customActionMatches({ ...base, userId: "999999999999999999" }, message), false);
  assert.equal(customActionMatches({ ...base, triggerType: "starts_with", triggerValue: "duck" }, message), false);
  assert.equal(customActionMatches({ ...base, triggerType: "ends_with", triggerValue: "duck.example" }, message), true);
  assert.equal(customActionMatches({ ...base, triggerType: "equals", triggerValue: message.content }, message), true);
  assert.equal(customActionMatches({ ...base, triggerType: "has_link" }, message), true);
  assert.equal(customActionMatches({ ...base, triggerType: "has_attachment" }, message), true);
  assert.equal(customActionMatches({ ...base, triggerType: "mentions_duck" }, message), true);
  assert.equal(customActionMatches({ ...base, triggerType: "unknown" }, message), false);
});

test("honeypot softbans once with a return invite then permanently bans", async () => {
  const actions = []; const persisted = []; const member = { id: "223456789012345678", bannable: true, permissions: { has: () => false } };
  const message = { guildId: "123456789012345678", channelId: "323456789012345678", member, author: { async send(payload) { actions.push(["dm", payload]); } }, channel: { async createInvite() { actions.push(["invite"]); return { url: "https://discord.gg/duck" }; } }, guild: { name: "Test Pond", members: { async ban(id, options) { actions.push(["ban", id, options]); }, async unban(id) { actions.push(["unban", id]); } } } };
  const settings = { automodHoneypotEnabled: true, automodHoneypotChannelId: message.channelId };
  assert.equal(await handleHoneypot(message, settings, {}, (...args) => persisted.push(args)), true);
  assert.equal(actions.some(([name]) => name === "unban"), true); assert.equal(actions.some(([name]) => name === "dm"), true); assert.deepEqual(persisted[0][1].honeypotTriggeredUserIds, [member.id]);
  actions.length = 0; await handleHoneypot(message, settings, { honeypotTriggeredUserIds: [member.id] }, () => {});
  assert.deepEqual(actions.map(([name]) => name), ["ban"]); assert.equal(actions[0][2].deleteMessageSeconds, 604_800);
});

test("honeypot counters normalize malformed persisted values", () => {
  assert.deepEqual(normalizedHoneypotStats({ total: "4", firstTraps: -2, permanentBans: 2, lastTriggeredAt: "2026-08-21T00:00:00.000Z", lastUserId: "223456789012345678" }), { total: 4, firstTraps: 0, permanentBans: 2, lastTriggeredAt: "2026-08-21T00:00:00.000Z", lastUserId: "223456789012345678" });
});

test("persistent warning histories have member, guild, and global retention bounds", () => {
  const warnings = { guilds: {} };
  for (let guildIndex = 0; guildIndex < 6; guildIndex += 1) {
    const guildId = String(700000000000000000n + BigInt(guildIndex)); warnings.guilds[guildId] = {};
    for (let memberIndex = 0; memberIndex < 1_001; memberIndex += 1) {
      const memberId = String(800000000000000000n + BigInt(guildIndex * 2_000 + memberIndex));
      warnings.guilds[guildId][memberId] = Array.from({ length: memberIndex === 1_000 ? 125 : 1 }, (_, index) => ({ createdAt: new Date(index * 1000 + guildIndex * 10_000).toISOString() }));
    }
  }
  trimWarningStore(warnings);
  const memberEntries = Object.values(warnings.guilds).flatMap((members) => Object.entries(members));
  assert.equal(memberEntries.length, 5_000);
  assert.ok(Object.values(warnings.guilds).every((members) => Object.keys(members).length <= 1_000));
  assert.ok(memberEntries.every(([, history]) => history.length <= 100));
});
