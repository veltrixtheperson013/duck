import assert from "node:assert/strict";
import test from "node:test";
import { HELPER_TOOLS } from "../src/helper-tools.js";
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
import { summarizeEmbedsForAi } from "../src/ai-content.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";

/**
 * Creates a mock Discord message fixture with nested guild and channel relationships.
 */
function createMessageFixture({ readable = true } = {}) {
  const fetchedMessage = {
    id: "323456789012345678",
    author: { id: "423456789012345678", tag: "member#0001" },
    createdAt: new Date("2026-08-29T12:00:00.000Z"),
    createdTimestamp: Date.parse("2026-08-29T12:00:00.000Z"),
    cleanContent: "Please inspect this channel safely",
    attachments: new Map(),
    embeds: [
      {
        title: "Server rules",
        description: "Be respectful.",
        fields: [{ name: "Rule 2", value: "No spam." }],
      },
    ],
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

test("AI Tools - Schema Definitions & Bounds", async (t) => {
  await t.test("exposes bounded read-tool definitions", () => {
    const expectedReadTools = [
      "request_channel_context",
      "search_channel_context",
      "inspect_message_context",
      "inspect_member_context",
      "inspect_channel_state",
      "inspect_role_context",
    ];

    assert.deepEqual(
      AI_READ_TOOL_DEFINITIONS.map((tool) => tool.function.name),
      expectedReadTools
    );

    for (const tool of AI_READ_TOOL_DEFINITIONS) {
      assert.equal(tool.type, "function");
      assert.equal(tool.function.parameters.additionalProperties, false);
    }

    // Context limit boundaries
    assert.equal(getAiToolContextLimit(999), 100);
    assert.equal(getAiToolContextLimit(-5), 1);
  });

  await t.test("exposes action tool groups without duplicate definitions", () => {
    const groupedActions = AI_ACTION_TOOL_GROUPS.flatMap((group) => group.tools);
    
    // Ensure uniqueness
    assert.equal(new Set(groupedActions).size, groupedActions.length);
    assert.deepEqual(
      [...groupedActions].sort(),
      TOOL_DEFINITIONS.map((tool) => tool.name).sort()
    );

    assert.equal(AI_ACTION_TOOL_DEFINITIONS.length, 5);
    assert.equal(
      AI_TOOL_DEFINITIONS.length,
      AI_READ_TOOL_DEFINITIONS.length + AI_ACTION_TOOL_DEFINITIONS.length + HELPER_TOOLS.length
    );

    for (const definition of AI_ACTION_TOOL_DEFINITIONS) {
      assert.equal(definition.type, "function");
      assert.equal(definition.function.parameters.additionalProperties, false);
      assert.equal(definition.function.parameters.properties.actions.maxItems, 10);
      assert.equal(definition.function.parameters.properties.actions.items.additionalProperties, false);
    }
  });
});

test("AI Tools - Validation & Proposals", async (t) => {
  await t.test("validates valid action proposals into localized execution plans", () => {
    const message = createMessageFixture();
    message.content = "Duck, purge 7 messages because spam";
    const context = { members: [], channels: [], roles: [] };

    const validCall = validateAiActionToolCall(
      message,
      {
        function: {
          name: "propose_message_actions",
          arguments: JSON.stringify({
            actions: [{ tool: "purge_messages", count: 7, reason: "spam" }],
          }),
        },
      },
      context
    );

    assert.equal(validCall.error, undefined);
    assert.equal(validCall.actions.length, 1);
    assert.equal(validCall.actions[0].tool, "purge_messages");
    assert.equal(validCall.actions[0].count, 7);
    assert.equal(validCall.actions[0].channelId, CHANNEL_ID);
  });

  await t.test("rejects action proposals targeting mismatched tool groups", () => {
    const message = createMessageFixture();
    const context = { members: [], channels: [], roles: [] };

    const wrongGroupCall = validateAiActionToolCall(
      message,
      {
        function: {
          name: "propose_message_actions",
          arguments: JSON.stringify({
            actions: [{ tool: "ban_member", targetId: "423456789012345678" }],
          }),
        },
      },
      context
    );

    assert.match(wrongGroupCall.error, /does not belong/);
  });
});

test("AI Tools - Parsing & Serialization", async (t) => {
  await t.test("parses valid JSON argument objects and throws on invalid inputs", () => {
    const parsed = parseAiToolArguments({
      function: { arguments: '{"channel_id":"123"}' },
    });
    assert.deepEqual(parsed, { channel_id: "123" });

    assert.throws(
      () => parseAiToolArguments({ function: { arguments: "[]" } }),
      /must be an object/
    );
  });

  await t.test("truncates serialized tool outputs exceeding configured character limits", (t) => {
    const originalMaxChars = process.env.AI_TOOL_RESULT_MAX_CHARS;
    process.env.AI_TOOL_RESULT_MAX_CHARS = "1000";

    t.after(() => {
      if (originalMaxChars === undefined) {
        delete process.env.AI_TOOL_RESULT_MAX_CHARS;
      } else {
        process.env.AI_TOOL_RESULT_MAX_CHARS = originalMaxChars;
      }
    });

    const boundedResult = serializeAiToolResult({ value: "x".repeat(2_000) });
    assert.ok(boundedResult.length <= 1_000);
    assert.equal(JSON.parse(boundedResult).truncated, true);
  });
});

test("AI Tools - Channel Context & Execution", async (t) => {
  await t.test("enforces supplied channel scope and permissions during execution", async () => {
    const message = createMessageFixture();
    const toolCall = {
      function: {
        name: "request_channel_context",
        arguments: JSON.stringify({ channel_id: CHANNEL_ID, limit: 5 }),
      },
    };
    const validContext = { availableChannels: [{ id: CHANNEL_ID }] };

    const result = await executeAiReadTool(message, toolCall, validContext);
    assert.equal(result.channel.id, CHANNEL_ID);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0].content, /inspect this channel/);
    assert.deepEqual(result.messages[0].embeds, [
      {
        title: "Server rules",
        description: "Be respectful.",
        fields: [{ name: "Rule 2", value: "No spam." }],
      },
    ]);

    // Rejections for missing channel context or unreadable channels
    await assert.rejects(
      () => executeAiReadTool(message, toolCall, { availableChannels: [] }),
      /not supplied/
    );
    await assert.rejects(
      () => executeAiReadTool(createMessageFixture({ readable: false }), toolCall, validContext),
      /cannot view/
    );
  });

  await t.test("summarizes rich embeds while adhering to size limits", () => {
    const rawEmbeds = [
      {
        author: { name: "Duck rules" },
        title: "Welcome",
        description: "x".repeat(2_000),
        fields: [{ name: "Rule 1", value: "No scams" }],
        footer: { text: "Read carefully" },
      },
    ];

    const summaries = summarizeEmbedsForAi(rawEmbeds, { maxChars: 300 });

    assert.equal(summaries[0].author, "Duck rules");
    assert.equal(summaries[0].title, "Welcome");
    assert.ok(JSON.stringify(summaries).length < 500);
  });
});