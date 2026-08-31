import assert from "node:assert/strict";
import test from "node:test";
import { customActionMatches, detectScam, detectViolation, handleHoneypot, includesTerm, normalizedHoneypotStats } from "../src/automod.js";
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

test("AutoMod blocks common raid payloads without an AI provider", () => {
  const base = { content: "ordinary message", attachments: new Map(), mentions: { users: new Map() } };
  assert.equal(detectViolation({ ...base, content: "visit https://example.com" }, { automodLinkFilter: true }), "Links are not allowed here");
  assert.equal(detectViolation({ ...base, attachments: new Map([["1", { name: "totally-safe.exe" }]]) }, { automodDangerousFileFilter: true }), "Potentially dangerous attachment");
  assert.equal(detectViolation({ ...base, content: "aaaaaaaaaaaa" }, { automodRepeatedTextFilter: true }), "Repeated-character spam");
  assert.match(detectViolation({ ...base, content: "\u{1f986}\u{1f986}\u{1f986}" }, { automodEmojiLimit: 2 }), /Too many emoji/);
  assert.match(detectViolation({ ...base, content: "one\ntwo\nthree" }, { automodLineLimit: 2 }), /Too many lines/);
});

test("AutoMod blocks high-confidence scam scripts locally", () => {
  const message = (content) => ({ content, attachments: new Map(), mentions: { users: new Map() } });
  assert.equal(detectScam(message("MR BEAST LIVE crypto giveaway! Claim double BTC at mrbeast-bonus[.]xyz now")), "Celebrity crypto giveaway impersonation");
  assert.equal(detectScam(message("MrBeast will double your crypto. Send BTC to this wallet address now")), "Celebrity crypto giveaway impersonation");
  assert.equal(detectScam(message("Guaranteed 2x return: send BTC to this wallet address and receive double back")), "Crypto doubling or guaranteed-return scam");
  assert.equal(detectScam(message("Claim your free Nitro at hxxps://nitro-gift[.]xyz")), "Suspicious reward or giveaway link");
  assert.equal(detectScam(message("I accidentally reported your Steam account. Add this support admin to appeal.")), "Fake report or support impersonation script");
  assert.equal(detectScam(message("Connect your wallet at https://wallet-sync.example.com to validate your assets")), "Suspicious wallet-connection link");
  assert.equal(detectScam(message("Send me your Discord token for verification")), "Credential or recovery-secret theft attempt");
  assert.equal(detectScam(message("Scan this QR code to verify your Discord login")), "Suspicious QR login or verification request");
  assert.equal(detectScam(message("MrBeast crypto casino promo code! Only the fastest win; this post will be deleted. https://linktr.ee/beastgames")), "Multi-signal crypto promotion scam");
  assert.equal(detectViolation(message("MR-BEAST crypto giveaway: claim BTC at bonus[.]xyz"), {}), "Celebrity crypto giveaway impersonation");
});

test("AutoMod does not flag ordinary scam warnings and discussion", () => {
  const message = (content) => ({ content, attachments: new Map(), mentions: { users: new Map() } });
  assert.equal(detectScam(message("Warning: avoid the fake MrBeast crypto giveaway scam and never click its links.")), null);
  assert.equal(detectScam(message("MrBeast posted a video discussing crypto scams.")), null);
  assert.equal(detectScam(message("Never share your seed phrase with anyone.")), null);
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

test("honeypot permanently bans on the first trigger without a return path", async () => {
  const actions = []; const persisted = []; const member = { id: "223456789012345678", bannable: true, permissions: { has: () => false } };
  const message = { guildId: "123456789012345678", channelId: "323456789012345678", member, author: { id: member.id, async send(payload) { actions.push(["dm", payload]); } }, channel: { async createInvite() { actions.push(["invite"]); return { url: "https://discord.gg/duck" }; } }, guild: { name: "Test Pond", members: { async ban(id, options) { actions.push(["ban", id, options]); }, async unban(id) { actions.push(["unban", id]); } } } };
  const settings = { automodHoneypotEnabled: true, automodHoneypotChannelId: message.channelId };
  assert.equal(await handleHoneypot(message, settings, {}, (...args) => persisted.push(args)), true);
  assert.deepEqual(actions.map(([name]) => name), ["ban"]);
  assert.equal(actions[0][2].deleteMessageSeconds, 604_800);
  assert.equal(persisted.some(([, patch]) => patch.honeypotStats?.permanentBans === 1), true);
  actions.length = 0; await handleHoneypot(message, settings, { honeypotTriggeredUserIds: [member.id] }, () => {});
  assert.deepEqual(actions.map(([name]) => name), ["ban"]);
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
