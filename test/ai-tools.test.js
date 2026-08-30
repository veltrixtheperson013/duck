import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_ACTION_TOOL_DEFINITIONS,
  AI_ACTION_TOOL_GROUPS,
  AI_READ_TOOL_DEFINITIONS,
  AI_TOOL_DEFINITIONS,
  executeAiReadTool,
  getAiToolContextLimit,
  parseAiToolArguments,
  serializeAiToolResult,
  validateAiActionToolCall,
} from "../src/core.js";
import { TOOL_DEFINITIONS } from "../src/constants.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";

function makeMessageFixture({ readable = true } = {}) {
  const fetchedMessage = {
    id: "323456789012345678",
    author: { id: "423456789012345678", tag: "member#0001" },
    createdAt: new Date("2026-08-29T12:00:00.000Z"),
    createdTimestamp: Date.parse("2026-08-29T12:00:00.000Z"),
    cleanContent: "Please inspect this channel safely",
    attachments: new Map(),
  };
  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    name: "reports",
    parent: null,
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => readable }),
    messages: {
      cache: new Map([[fetchedMessage.id, fetchedMessage]]),
      fetch: async () => new Map([[fetchedMessage.id, fetchedMessage]]),
    },
  };
  const guild = {
    id: GUILD_ID,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    members: { me: { id: "523456789012345678" } },
    roles: { everyone: {} },
  };
  channel.guild = guild;
  return {
    id: "623456789012345678",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    guild,
    channel,
    member: { id: "723456789012345678" },
  };
}

test("AI read tools expose only bounded server-context operations", () => {
  assert.deepEqual(AI_READ_TOOL_DEFINITIONS.map((tool) => tool.function.name), [
    "request_channel_context",
    "search_channel_context",
    "inspect_message_context",
    "inspect_member_context",
    "inspect_channel_state",
    "inspect_role_context",
  ]);
  for (const tool of AI_READ_TOOL_DEFINITIONS) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
  assert.equal(getAiToolContextLimit(999), 100);
  assert.equal(getAiToolContextLimit(-5), 1);
});

test("AI action tools expose every supported action exactly once", () => {
  const groupedActions = AI_ACTION_TOOL_GROUPS.flatMap((group) => group.tools);
  assert.equal(new Set(groupedActions).size, groupedActions.length);
  assert.deepEqual([...groupedActions].sort(), TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  assert.equal(AI_ACTION_TOOL_DEFINITIONS.length, 5);
  assert.equal(AI_TOOL_DEFINITIONS.length, AI_READ_TOOL_DEFINITIONS.length + AI_ACTION_TOOL_DEFINITIONS.length);
  for (const definition of AI_ACTION_TOOL_DEFINITIONS) {
    assert.equal(definition.type, "function");
    assert.equal(definition.function.parameters.additionalProperties, false);
    assert.equal(definition.function.parameters.properties.actions.maxItems, 10);
    assert.equal(definition.function.parameters.properties.actions.items.additionalProperties, false);
  }
});

test("AI action proposals are group checked and validated into local plans", () => {
  const message = makeMessageFixture();
  message.content = "Duck, purge 7 messages because spam";
  const context = { members: [], channels: [], roles: [] };
  const valid = validateAiActionToolCall(message, {
    function: {
      name: "propose_message_actions",
      arguments: JSON.stringify({ actions: [{ tool: "purge_messages", count: 7, reason: "spam" }] }),
    },
  }, context);
  assert.equal(valid.error, undefined);
  assert.equal(valid.actions.length, 1);
  assert.equal(valid.actions[0].tool, "purge_messages");
  assert.equal(valid.actions[0].count, 7);
  assert.equal(valid.actions[0].channelId, CHANNEL_ID);

  const wrongGroup = validateAiActionToolCall(message, {
    function: {
      name: "propose_message_actions",
      arguments: JSON.stringify({ actions: [{ tool: "ban_member", targetId: "423456789012345678" }] }),
    },
  }, context);
  assert.match(wrongGroup.error, /does not belong/);
});

test("AI tool arguments and results are parsed and bounded", () => {
  assert.deepEqual(parseAiToolArguments({ function: { arguments: '{"channel_id":"123"}' } }), { channel_id: "123" });
  assert.throws(() => parseAiToolArguments({ function: { arguments: "[]" } }), /must be an object/);
  const original = process.env.AI_TOOL_RESULT_MAX_CHARS;
  process.env.AI_TOOL_RESULT_MAX_CHARS = "1000";
  try {
    const bounded = serializeAiToolResult({ value: "x".repeat(2_000) });
    assert.ok(bounded.length <= 1_000);
    assert.equal(JSON.parse(bounded).truncated, true);
  } finally {
    if (original === undefined) delete process.env.AI_TOOL_RESULT_MAX_CHARS;
    else process.env.AI_TOOL_RESULT_MAX_CHARS = original;
  }
});

test("channel context tool enforces supplied IDs and Discord visibility", async () => {
  const message = makeMessageFixture();
  const call = { function: { name: "request_channel_context", arguments: JSON.stringify({ channel_id: CHANNEL_ID, limit: 5 }) } };
  const context = { availableChannels: [{ id: CHANNEL_ID }] };
  const result = await executeAiReadTool(message, call, context);
  assert.equal(result.channel.id, CHANNEL_ID);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content, /inspect this channel/);

  await assert.rejects(() => executeAiReadTool(message, call, { availableChannels: [] }), /not supplied/);
  await assert.rejects(() => executeAiReadTool(makeMessageFixture({ readable: false }), call, context), /cannot view/);
});
