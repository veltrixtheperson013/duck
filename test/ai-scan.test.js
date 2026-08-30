import test from "node:test";
import assert from "node:assert/strict";
import { buildScanInput, getServerRules, parseScanResult, requestSuggestion, shouldQueueScan } from "../src/ai-scan.js";

test("AI scanner accepts only bounded advisory flags", () => {
  assert.deepEqual(parseScanResult('{"flag":true,"category":"harassment","confidence":0.91,"reason":"Targeted insults."}'), { category: "harassment", confidence: 0.91, reason: "Targeted insults." });
  assert.equal(parseScanResult('{"flag":false,"category":"other","confidence":0.9,"reason":"Safe."}'), null);
  assert.equal(parseScanResult('{"flag":true,"category":"ban_them","confidence":1,"reason":"No."}'), null);
});

test("AI scanner is channel opt-in and uses the server-selected chatbot model", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const message = { guildId: "800000000000000001", channelId: "800000000000000002", author: { id: "800000000000000003" }, content: "a message long enough to inspect" };
    const settings = { aiScanEnabled: true, aiScanFlagChannelId: "800000000000000004", aiScanChannelIds: [message.channelId] };
    assert.equal(shouldQueueScan(message, settings, 1_000_000), true);
    assert.equal(shouldQueueScan({ ...message, channelId: "800000000000000099" }, settings, 1_010_000), false);
    let request;
    const result = await requestSuggestion(message.content, { model: "cohere/north-mini-code:free", fetchImpl: async (url, options) => { request = { url, options }; return Response.json({ choices: [{ message: { content: '{"flag":true,"category":"spam","confidence":0.8,"reason":"Repeated promotion."}' } }] }); } });
    assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, "cohere/north-mini-code:free");
    assert.equal(body.provider, undefined);
    assert.equal(body.messages.at(-1).content, message.content);
    assert.deepEqual(result, { category: "spam", confidence: 0.8, reason: "Repeated promotion." });
  } finally { previous == null ? delete process.env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY = previous; }
});

test("AI scanner rejects unapproved models and preserves selected-model privacy routing", async () => {
  await assert.rejects(() => requestSuggestion("inspect this", { model: "attacker/unknown", fetchImpl: async () => Response.json({}) }), /allowlist/);
  let request;
  await requestSuggestion("inspect this", { model: "tencent/hy3", fetchImpl: async (url, options) => { request = { url, options }; return Response.json({ choices: [{ message: { content: '{"flag":false}' } }] }); } });
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "tencent/hy3");
  assert.deepEqual(body.provider, { order: ["tencent"], allow_fallbacks: false, data_collection: "deny" });
});

test("AI scanner reads recent and pinned rule embeds", async () => {
  const recentRule = { id: "recent", createdTimestamp: 2, content: "", embeds: [{ title: "General rules", fields: [{ name: "Rule 1", value: "No harassment" }] }] };
  const pinnedRule = { id: "pinned", createdTimestamp: 1, content: "", embeds: [{ description: "No advertising or scams", footer: { text: "Applies everywhere" } }] };
  const channel = { messages: { fetch: async () => new Map([[recentRule.id, recentRule]]), fetchPins: async () => ({ items: [{ message: pinnedRule }] }) } };
  const message = { guildId: "810000000000000001", guild: { channels: { cache: new Map([["810000000000000002", channel]]), fetch: async () => null } } };
  const rules = await getServerRules(message, { aiScanRulesChannelId: "810000000000000002" }, 1_000);
  assert.match(rules, /No advertising or scams/);
  assert.match(rules, /General rules/);
  assert.match(rules, /No harassment/);
});

test("AI scanner clearly separates nearby context from the target message", () => {
  const nearby = { id: "820000000000000003", createdTimestamp: 1, author: { id: "820000000000000004", bot: false }, content: "That was a quoted example", embeds: [] };
  const target = { id: "820000000000000005", createdTimestamp: 2, author: { id: "820000000000000006" }, content: "I am reporting the quote, not endorsing it", embeds: [], channel: { messages: { cache: new Map([[nearby.id, nearby]]) } } };
  const input = buildScanInput(target);
  assert.match(input, /<nearby_context>/);
  assert.match(input, /quoted example/);
  assert.match(input, /<target_message>/);
  assert.match(input, /reporting the quote/);
});
