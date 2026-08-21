import assert from "node:assert/strict";
import test from "node:test";
import { splitDiscordLines } from "../src/logging.js";

test("Discord pagination preserves long AI paragraphs without truncation", () => {
  const original = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const chunks = splitDiscordLines([original], 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join(" "), original);
});
