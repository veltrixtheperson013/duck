import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScanInput,
  getServerRules,
  parseScanResult,
  requestSuggestion,
  shouldQueueScan,
} from "../src/ai-scan.js";

test("AI Scan Engine", async (t) => {
  await t.test("parseScanResult - accepts only bounded advisory flags", () => {
    // Valid flag
    assert.deepEqual(
      parseScanResult(
        '{"flag":true,"category":"harassment","confidence":0.91,"reason":"Targeted insults."}'
      ),
      {
        category: "harassment",
        confidence: 0.91,
        reason: "Targeted insults.",
      }
    );

    // Non-flagged / benign content
    assert.equal(
      parseScanResult(
        '{"flag":false,"category":"other","confidence":0.9,"reason":"Safe."}'
      ),
      null
    );

    // Invalid or unapproved category action
    assert.equal(
      parseScanResult(
        '{"flag":true,"category":"ban_them","confidence":1,"reason":"No."}'
      ),
      null
    );
  });

  await t.test(
    "requestSuggestion - opt-in channel checks & server-selected model integration",
    async (st) => {
      const originalApiKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "test-key";

      st.after(() => {
        if (originalApiKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = originalApiKey;
        }
      });

      const message = {
        guildId: "800000000000000001",
        channelId: "800000000000000002",
        author: { id: "800000000000000003" },
        content: "a message long enough to inspect",
      };

      const settings = {
        aiScanEnabled: true,
        aiScanFlagChannelId: "800000000000000004",
        aiScanChannelIds: [message.channelId],
      };

      assert.equal(shouldQueueScan(message, settings, 1_000_000), true);
      assert.equal(
        shouldQueueScan(
          { ...message, channelId: "800000000000000099" },
          settings,
          1_010_000
        ),
        false
      );

      let interceptedRequest;
      const result = await requestSuggestion(message.content, {
        model: "cohere/north-mini-code:free",
        fetchImpl: async (url, options) => {
          interceptedRequest = { url, options };
          return Response.json({
            choices: [
              {
                message: {
                  content:
                    '{"flag":true,"category":"spam","confidence":0.8,"reason":"Repeated promotion."}',
                },
              },
            ],
          });
        },
      });

      assert.equal(
        interceptedRequest.url,
        "https://openrouter.ai/api/v1/chat/completions"
      );

      const body = JSON.parse(interceptedRequest.options.body);
      assert.equal(body.model, "cohere/north-mini-code:free");
      assert.equal(body.provider, undefined);
      assert.equal(body.messages.at(-1).content, message.content);
      assert.deepEqual(result, {
        category: "spam",
        confidence: 0.8,
        reason: "Repeated promotion.",
      });
    }
  );

  await t.test(
    "requestSuggestion - rejects unapproved models & preserves privacy routing",
    async () => {
      await assert.rejects(
        () =>
          requestSuggestion("inspect this", {
            model: "attacker/unknown",
            fetchImpl: async () => Response.json({}),
          }),
        /allowlist/
      );

      let interceptedRequest;
      await requestSuggestion("inspect this", {
        model: "tencent/hy3",
        fetchImpl: async (url, options) => {
          interceptedRequest = { url, options };
          return Response.json({
            choices: [{ message: { content: '{"flag":false}' } }],
          });
        },
      });

      const body = JSON.parse(interceptedRequest.options.body);
      assert.equal(body.model, "tencent/hy3");
      assert.deepEqual(body.provider, {
        order: ["tencent"],
        allow_fallbacks: false,
        data_collection: "deny",
      });
    }
  );

  await t.test(
    "requestSuggestion - Cloudflare challenge handling",
    async (st) => {
      await st.test("recovers from Cloudflare challenge retry", async () => {
        let calls = 0;
        const model = "qwen/qwen-2.5-7b-instruct:free";

        const result = await requestSuggestion("inspect this message", {
          model,
          fetchImpl: async (_url, options) => {
            assert.equal(JSON.parse(options.body).model, model);
            calls += 1;
            if (calls === 1) {
              return new Response(
                "<!DOCTYPE html><html><title>Just a moment...</title></html>",
                { status: 403 }
              );
            }
            return Response.json({
              choices: [
                {
                  message: {
                    content:
                      '{"flag":true,"category":"spam","confidence":0.8,"reason":"Repeated promotion."}',
                  },
                },
              ],
            });
          },
        });

        assert.equal(calls, 2);
        assert.equal(result.category, "spam");
      });

      await st.test(
        "reports exhausted challenge without leaking raw HTML",
        async () => {
          let calls = 0;

          await assert.rejects(
            requestSuggestion("inspect this message", {
              model: "google/gemma-2-9b-it:free",
              fetchImpl: async () => {
                calls += 1;
                return new Response(
                  "<!DOCTYPE html><html><title>Just a moment...</title></html>",
                  { status: 403 }
                );
              },
            }),
            (error) =>
              /Cloudflare/.test(error.message) &&
              !/<html|<!DOCTYPE/.test(error.message)
          );

          assert.equal(calls, 2);
        }
      );
    }
  );

  await t.test("getServerRules - reads recent and pinned rule embeds", async () => {
    const recentRule = {
      id: "recent",
      createdTimestamp: 2,
      content: "",
      embeds: [
        {
          title: "General rules",
          fields: [{ name: "Rule 1", value: "No harassment" }],
        },
      ],
    };

    const pinnedRule = {
      id: "pinned",
      createdTimestamp: 1,
      content: "",
      embeds: [
        {
          description: "No advertising or scams",
          footer: { text: "Applies everywhere" },
        },
      ],
    };

    const channel = {
      messages: {
        fetch: async () => new Map([[recentRule.id, recentRule]]),
        fetchPins: async () => ({ items: [{ message: pinnedRule }] }),
      },
    };

    const message = {
      guildId: "810000000000000001",
      guild: {
        channels: {
          cache: new Map([["810000000000000002", channel]]),
          fetch: async () => null,
        },
      },
    };

    const rules = await getServerRules(
      message,
      { aiScanRulesChannelId: "810000000000000002" },
      1_000
    );

    assert.match(rules, /No advertising or scams/);
    assert.match(rules, /General rules/);
    assert.match(rules, /No harassment/);
  });

  await t.test(
    "buildScanInput - clearly separates nearby context from target message",
    () => {
      const nearby = {
        id: "820000000000000003",
        createdTimestamp: 1,
        author: { id: "820000000000000004", bot: false },
        content: "That was a quoted example",
        embeds: [],
      };

      const target = {
        id: "820000000000000005",
        createdTimestamp: 2,
        author: { id: "820000000000000006" },
        content: "I am reporting the quote, not endorsing it",
        embeds: [],
        channel: {
          messages: {
            cache: new Map([[nearby.id, nearby]]),
          },
        },
      };

      const input = buildScanInput(target);

      assert.match(input, /<nearby_context>/);
      assert.match(input, /quoted example/);
      assert.match(input, /<target_message>/);
      assert.match(input, /reporting the quote/);
    }
  );
});