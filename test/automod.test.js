import assert from "node:assert/strict";
import test from "node:test";
import {
  customActionMatches,
  detectScam,
  detectViolation,
  handleHoneypot,
  includesTerm,
  normalizedHoneypotStats,
} from "../src/automod.js";
import { trimWarningStore } from "../src/config.js";

/**
 * Helper to construct minimal Discord message objects for testing.
 */
function createMockMessage(overrides = {}) {
  const botId = "323456789012345678";
  return {
    content: "ordinary message",
    attachments: new Map(),
    mentions: { users: new Map() },
    channelId: "123456789012345678",
    author: { id: "223456789012345678" },
    client: { user: { id: botId } },
    ...overrides,
  };
}

test("AutoMod - Term Matching", async (t) => {
  await t.test("matches normalized whole words and phrases correctly", () => {
    assert.equal(includesTerm("This is PORN!", ["porn"]), true);
    assert.equal(includesTerm("that is a spoiler alert", ["spoiler alert"]), true);
    assert.equal(includesTerm("a class assignment", ["ass"]), false);
  });
});

test("AutoMod - Content and Attachment Filters", async (t) => {
  await t.test("detects violations across text content and attachment filenames", () => {
    const base = createMockMessage();

    assert.equal(
      detectViolation({ ...base, content: "a porn link" }, { automodNsfwFilter: true }),
      "Sexual or NSFW content"
    );
    assert.equal(
      detectViolation(
        { ...base, attachments: new Map([["1", { name: "nudes.zip" }]]) },
        { automodNsfwFilter: true }
      ),
      "Sexual or NSFW content"
    );
    assert.equal(
      detectViolation(
        { ...base, content: "hidden pond phrase" },
        { automodCustomWords: ["pond phrase"] }
      ),
      "Custom blocked phrase"
    );
    assert.equal(
      detectViolation(base, { automodSwearFilter: false, automodNsfwFilter: false }),
      null
    );
  });

  await t.test("detects invite links, excessive mentions, and caps locally", () => {
    const base = createMockMessage();

    assert.equal(
      detectViolation(
        { ...base, content: "join https://discord.gg/example" },
        { automodInviteFilter: true }
      ),
      "Discord invite link"
    );
    assert.match(
      detectViolation(
        {
          ...base,
          content: "hello",
          mentions: { users: new Map([["1", {}], ["2", {}], ["3", {}]]) },
        },
        { automodMentionLimit: 2 }
      ),
      /Too many/
    );
    assert.equal(
      detectViolation(
        { ...base, content: "THIS MESSAGE IS VERY LOUD" },
        { automodCapsFilter: true }
      ),
      "Excessive capital letters"
    );
  });

  await t.test("blocks common raid payloads without requiring external AI", () => {
    const base = createMockMessage();

    assert.equal(
      detectViolation({ ...base, content: "visit https://example.com" }, { automodLinkFilter: true }),
      "Links are not allowed here"
    );
    assert.equal(
      detectViolation(
        { ...base, attachments: new Map([["1", { name: "totally-safe.exe" }]]) },
        { automodDangerousFileFilter: true }
      ),
      "Potentially dangerous attachment"
    );
    assert.equal(
      detectViolation({ ...base, content: "aaaaaaaaaaaa" }, { automodRepeatedTextFilter: true }),
      "Repeated-character spam"
    );
    assert.match(
      detectViolation({ ...base, content: "\u{1f986}\u{1f986}\u{1f986}" }, { automodEmojiLimit: 2 }),
      /Too many emoji/
    );
    assert.match(
      detectViolation({ ...base, content: "one\ntwo\nthree" }, { automodLineLimit: 2 }),
      /Too many lines/
    );
  });
});

test("AutoMod - Scam Detection", async (t) => {
  await t.test("blocks high-confidence scam scripts", () => {
    const testCases = [
      {
        text: "MR BEAST LIVE crypto giveaway! Claim double BTC at mrbeast-bonus[.]xyz now",
        expected: "Celebrity crypto giveaway impersonation",
      },
      {
        text: "MrBeast will double your crypto. Send BTC to this wallet address now",
        expected: "Celebrity crypto giveaway impersonation",
      },
      {
        text: "Guaranteed 2x return: send BTC to this wallet address and receive double back",
        expected: "Crypto doubling or guaranteed-return scam",
      },
      {
        text: "Claim your free Nitro at hxxps://nitro-gift[.]xyz",
        expected: "Suspicious reward or giveaway link",
      },
      {
        text: "I accidentally reported your Steam account. Add this support admin to appeal.",
        expected: "Fake report or support impersonation script",
      },
      {
        text: "Connect your wallet at https://wallet-sync.example.com to validate your assets",
        expected: "Suspicious wallet-connection link",
      },
      {
        text: "Send me your Discord token for verification",
        expected: "Credential or recovery-secret theft attempt",
      },
      {
        text: "Scan this QR code to verify your Discord login",
        expected: "Suspicious QR login or verification request",
      },
      {
        text: "MrBeast crypto casino promo code! Only the fastest win; this post will be deleted. https://linktr.ee/beastgames",
        expected: "Multi-signal crypto promotion scam",
      },
    ];

    for (const { text, expected } of testCases) {
      assert.equal(detectScam(createMockMessage({ content: text })), expected);
    }

    assert.equal(
      detectViolation(
        createMockMessage({ content: "MR-BEAST crypto giveaway: claim BTC at bonus[.]xyz" }),
        {}
      ),
      "Celebrity crypto giveaway impersonation"
    );
  });

  await t.test("ignores legitimate discussion or scam warnings", () => {
    const safeTexts = [
      "Warning: avoid the fake MrBeast crypto giveaway scam and never click its links.",
      "MrBeast posted a video discussing crypto scams.",
      "Never share your seed phrase with anyone.",
    ];

    for (const text of safeTexts) {
      assert.equal(detectScam(createMockMessage({ content: text })), null);
    }
  });
});

test("AutoMod - Custom Action Rules", async (t) => {
  await t.test("matches only explicit server-side conditions", () => {
    const botId = "323456789012345678";
    const message = createMockMessage({
      content: "Hello Duck! https://duck.example",
      attachments: new Map([["1", {}]]),
      mentions: { users: new Map([[botId, {}]]) },
    });

    const baseConfig = {
      enabled: true,
      channelId: null,
      userId: null,
      triggerType: "contains",
      triggerValue: "hello duck",
    };

    assert.equal(customActionMatches(baseConfig, message), true);
    assert.equal(customActionMatches({ ...baseConfig, channelId: "999999999999999999" }, message), false);
    assert.equal(customActionMatches({ ...baseConfig, userId: "999999999999999999" }, message), false);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "starts_with", triggerValue: "duck" }, message), false);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "ends_with", triggerValue: "duck.example" }, message), true);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "equals", triggerValue: message.content }, message), true);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "has_link" }, message), true);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "has_attachment" }, message), true);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "mentions_duck" }, message), true);
    assert.equal(customActionMatches({ ...baseConfig, triggerType: "unknown" }, message), false);
  });
});

test("AutoMod - Honeypot & Protection Mechanisms", async (t) => {
  await t.test("permanently bans on the first trigger without a return path", async () => {
    const actions = [];
    const persisted = [];
    const member = {
      id: "223456789012345678",
      bannable: true,
      permissions: { has: () => false },
    };

    const message = {
      guildId: "123456789012345678",
      channelId: "323456789012345678",
      member,
      author: {
        id: member.id,
        async send(payload) {
          actions.push(["dm", payload]);
        },
      },
      channel: {
        async createInvite() {
          actions.push(["invite"]);
          return { url: "https://discord.gg/duck" };
        },
      },
      guild: {
        name: "Test Pond",
        members: {
          async ban(id, options) {
            actions.push(["ban", id, options]);
          },
          async unban(id) {
            actions.push(["unban", id]);
          },
        },
      },
    };

    const settings = {
      automodHoneypotEnabled: true,
      automodHoneypotChannelId: message.channelId,
    };

    const result = await handleHoneypot(
      message,
      settings,
      {},
      (...args) => persisted.push(args)
    );

    assert.equal(result, true);
    assert.deepEqual(actions.map(([name]) => name), ["ban"]);
    assert.equal(actions[0][2].deleteMessageSeconds, 604_800);
    assert.equal(persisted.some(([, patch]) => patch.honeypotStats?.permanentBans === 1), true);

    // Ensure re-trigger still results in a ban
    actions.length = 0;
    await handleHoneypot(
      message,
      settings,
      { honeypotTriggeredUserIds: [member.id] },
      () => {}
    );
    assert.deepEqual(actions.map(([name]) => name), ["ban"]);
  });

  await t.test("normalizes malformed persisted honeypot stats", () => {
    const rawStats = {
      total: "4",
      firstTraps: -2,
      permanentBans: 2,
      lastTriggeredAt: "2026-08-21T00:00:00.000Z",
      lastUserId: "223456789012345678",
    };

    assert.deepEqual(normalizedHoneypotStats(rawStats), {
      total: 4,
      firstTraps: 0,
      permanentBans: 2,
      lastTriggeredAt: "2026-08-21T00:00:00.000Z",
      lastUserId: "223456789012345678",
    });
  });
});

test("Config - Storage Retention Rules", async (t) => {
  await t.test("enforces member, guild, and global bounds on warning histories", () => {
    const warnings = { guilds: {} };

    for (let guildIndex = 0; guildIndex < 6; guildIndex += 1) {
      const guildId = String(700000000000000000n + BigInt(guildIndex));
      warnings.guilds[guildId] = {};

      for (let memberIndex = 0; memberIndex < 1_001; memberIndex += 1) {
        const memberId = String(800000000000000000n + BigInt(guildIndex * 2_000 + memberIndex));
        
        warnings.guilds[guildId][memberId] = Array.from(
          { length: memberIndex === 1_000 ? 125 : 1 },
          (_, index) => ({
            createdAt: new Date(index * 1000 + guildIndex * 10_000).toISOString(),
          })
        );
      }
    }

    trimWarningStore(warnings);

    const memberEntries = Object.values(warnings.guilds).flatMap((members) =>
      Object.entries(members)
    );

    assert.equal(memberEntries.length, 5_000);
    assert.ok(
      Object.values(warnings.guilds).every(
        (members) => Object.keys(members).length <= 1_000
      )
    );
    assert.ok(memberEntries.every(([, history]) => history.length <= 100));
  });
});