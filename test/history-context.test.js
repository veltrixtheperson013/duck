import assert from "node:assert/strict";
import test from "node:test";
import { historyDate, readChannelHistory } from "../src/history-context.js";
import { executeAiReadTool, validateAiActionToolCall, wantsRecentHistory } from "../src/core.js";

const GUILD = "123456789012345678", CHANNEL = "223456789012345678";
const idAt = ms => String((BigInt(ms) - 1420070400000n) << 22n);
function fixture(count = 80) {
  const base = Date.parse("2026-10-20T12:00:00Z"); let reads = 0;
  const items = Array.from({ length: count }, (_, n) => ({ id: idAt(base - n * 60_000), channelId: CHANNEL, createdTimestamp: base - n * 60_000, author: { tag: "member" }, cleanContent: `Message ${n}`, attachments: new Map(), embeds: [] }));
  const channel = { id: CHANNEL, name: "general", guildId: GUILD, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), messages: { fetch: async ({ limit, before }) => { reads++; return new Map(items.filter(m => !before || BigInt(m.id) < BigInt(before)).slice(0, limit).map(m => [m.id, m])); } } };
  return { base, items, channel, reads: () => reads };
}

test("activity review requests do not enter the message-list shortcut", () => {
  const message = { channel: { id: CHANNEL }, mentions: { channels: new Map() }, guild: { channels: { cache: new Map() } } };
  for (const text of ["look at recent activity in this channel and raise flags for any sus activity", "summarize recent messages", "review yesterday's messages", "analyze the last week of chat"]) assert.equal(wantsRecentHistory(message, text), false, text);
});

test("history tool reads the requested time period instead of the newest messages", async () => {
  const f = fixture();
  const result = await readChannelHistory({ channel_id: CHANNEL, after_iso: "2026-10-20T11:00:00Z", before_iso: "2026-10-20T11:30:00Z", limit: 5 }, async () => f.channel);
  assert.equal(result.messages.length, 5);
  assert.ok(result.messages.every(m => m.createdAt >= "2026-10-20T11:00:00.000Z" && m.createdAt < "2026-10-20T11:30:00.000Z"));
  assert.match(result.messages[0].url, new RegExp(`/channels/${GUILD}/${CHANNEL}/`));
  assert.equal(result.has_more, true); assert.ok(result.next_before_message_id);
});

test("history pagination returns older evidence without duplication and respects the lower bound", async () => {
  const f = fixture(14); const first = await readChannelHistory({ limit: 5 }, async () => f.channel);
  const second = await readChannelHistory({ limit: 5, before_message_id: first.next_before_message_id }, async () => f.channel);
  assert.ok(second.messages.every(m => !first.messages.some(a => a.id === m.id)));
  const bounded = await readChannelHistory({ after_iso: new Date(f.base - 3 * 60_000).toISOString(), limit: 20 }, async () => f.channel);
  assert.equal(bounded.messages.length, 4); assert.equal(bounded.has_more, false); assert.equal(bounded.next_before_message_id, null);
});

test("history reads enforce page, message, time, cursor and context-size budgets", async () => {
  for (const args of [{ pages: 4 }, { limit: 101 }, { before_message_id: "injected" }, { after_iso: "yesterday" }, { after_iso: "2026-10-20T12:00:00Z", before_iso: "2026-10-19T12:00:00Z" }]) await assert.rejects(readChannelHistory(args, async () => { throw Error("Should not fetch"); }));
  assert.throws(() => historyDate("2026-10-20T12:00:00", "date"), /timezone/);
  assert.throws(() => historyDate("2026-02-30T12:00:00Z", "date"), /invalid calendar/);
  const f = fixture(300); for (const item of f.items) item.cleanContent = "Long evidence ".repeat(100);
  const result = await readChannelHistory({ limit: 100, pages: 3 }, async () => f.channel);
  assert.ok(result.messages.length < 100); assert.equal(result.has_more, true); assert.ok(JSON.stringify(result).length < 12_000); assert.ok(f.reads() <= 3);
  const search = await readChannelHistory({ query: "never exists", limit: 100, pages: 3 }, async () => f.channel);
  assert.equal(search.messages.length, 0); assert.equal(search.scanned, 300);
  const long = fixture(1); long.items[0].cleanContent = "x".repeat(1500) + "exact search phrase";
  const found = await readChannelHistory({ query: "exact search phrase" }, async () => long.channel);
  assert.equal(found.messages.length, 1); assert.match(found.messages[0].content, /exact search phrase/);
});

test("each older page requires fresh authorization and mismatched channels are refused", async () => {
  const f = fixture(300); let checks = 0;
  await assert.rejects(readChannelHistory({ query: "absent", limit: 100 }, async () => { if (++checks === 2) throw Error("Permission revoked"); return f.channel; }), /Permission revoked/);
  assert.equal(checks, 2); assert.equal(f.reads(), 1);
  f.items[0].channelId = "999999999999999999";
  await assert.rejects(readChannelHistory({}, async () => f.channel), /different channel/);
});

test("native history tool rejects channels outside supplied context before fetching", async () => {
  let fetched = 0;
  await assert.rejects(executeAiReadTool({ guildId: GUILD, guild: { channels: { cache: new Map() }, members: { fetch: async () => { fetched++; } } } }, { function: { name: "read_channel_history", arguments: JSON.stringify({ channel_id: CHANNEL }) } }, { availableChannels: [] }), /not supplied/);
  assert.equal(fetched, 0);
});

test("evidenced review flags become proposals instead of fabricated completed actions", () => {
  const f = fixture(); const message = { guildId: GUILD, guild: { channels: { cache: new Map([[CHANNEL, f.channel]]) } }, member: { permissions: { has: () => true } }, channel: f.channel, channelId: CHANNEL, content: "Flag suspicious messages in this channel", mentions: { channels: new Map() } };
  const call = { function: { name: "propose_message_actions", arguments: JSON.stringify({ actions: [{ tool: "flag_message_for_review", channelId: CHANNEL, messageId: f.items[0].id, reason: "This message contains an explicit threat that needs moderator review." }] }) } };
  const result = validateAiActionToolCall(message, call, { members: [], channels: [{ id: CHANNEL }], roles: [] });
  assert.equal(result.error, undefined); assert.equal(result.actions[0].tool, "flag_message_for_review"); assert.match(result.actions[0].summary, /No punishment/);
});
