import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const interactionFiles = ["color-roles.js", "community.js", "community-studio.js", "core.js", "index.js"];

test("ephemeral interaction responses use Discord message flags", async () => {
  for (const file of interactionFiles) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bephemeral\s*:/, `${file} still uses the deprecated ephemeral option`);
    assert.match(source, /MessageFlags\.Ephemeral/, `${file} should keep its private interaction responses`);
    assert.match(source, /import[\s\S]*?\bMessageFlags\b[\s\S]*?from "discord\.js";/, `${file} must import MessageFlags from discord.js`);
  }
});
