import assert from "node:assert/strict";
import test from "node:test";
import { customActionMatches, detectViolation, includesTerm } from "../src/automod.js";

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

test("custom actions match only allowlisted server-side conditions", () => {
  const message = { content: "Hello Duck!", channelId: "123456789012345678", author: { id: "223456789012345678" } };
  const base = { enabled: true, channelId: null, userId: null, triggerType: "contains", triggerValue: "hello duck" };
  assert.equal(customActionMatches(base, message), true);
  assert.equal(customActionMatches({ ...base, channelId: "999999999999999999" }, message), false);
  assert.equal(customActionMatches({ ...base, userId: "999999999999999999" }, message), false);
  assert.equal(customActionMatches({ ...base, triggerType: "starts_with", triggerValue: "duck" }, message), false);
  assert.equal(customActionMatches({ ...base, triggerType: "unknown" }, message), false);
});
