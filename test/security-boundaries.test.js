import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coreSource = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const automodSource = await readFile(new URL("../src/automod.js", import.meta.url), "utf8");

test("pending moderation revalidates the original requester at execution time", () => {
  const start = coreSource.indexOf("async function revalidateExecutionAuthorization");
  const end = coreSource.indexOf("\nfunction summarizeMemberName", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = coreSource.slice(start, end);

  assert.match(implementation, /members\.fetch\(\{ user: action\.requestedBy, force: true \}\)/);
  assert.match(implementation, /action\.tool === "bulk_actions"[\s\S]*Administrator/);
  assert.match(implementation, /channel\.permissionsFor\(requester\)/);
  assert.match(implementation, /requesterActionBlockReasonForMember/);
  assert.match(coreSource, /await revalidateExecutionAuthorization\(guild, action, approver\)/);
});

test("channel history requires the requester's effective channel permissions", () => {
  const start = coreSource.indexOf("function canIncludeChannelMessages");
  const end = coreSource.indexOf("\nfunction getChannelCacheKey", start);
  const implementation = coreSource.slice(start, end);

  assert.match(implementation, /channel\.permissionsFor\(message\.member\)/);
  assert.match(implementation, /ViewChannel/);
  assert.match(implementation, /ReadMessageHistory/);
  assert.doesNotMatch(implementation, /roles\.everyone/);
});

test("both natural-language moderation paths enforce requester hierarchy", () => {
  const matches = indexSource.match(/requesterActionBlockReason\(/g) ?? [];
  assert.ok(matches.length >= 2, `expected at least two hierarchy checks, found ${matches.length}`);
});

test("command registration has a single configured scope", () => {
  const start = coreSource.indexOf("async function registerCommands");
  const end = coreSource.indexOf("\nfunction validateSlashCommandDispatchers", start);
  const implementation = coreSource.slice(start, end);

  assert.match(implementation, /getCommandScope\(\)/);
  assert.match(implementation, /scope === "global" \? body : \[\]/);
  assert.match(implementation, /scope === "guild" \? body : \[\]/);
});

test("custom actions cannot execute arbitrary uploaded code", () => {
  assert.doesNotMatch(automodSource, /\beval\s*\(|new\s+Function\s*\(/);
  assert.match(automodSource, /executed >= 3/);
  assert.match(automodSource, /member\.id === message\.guild\.ownerId/);
  assert.match(automodSource, /member\.moderatable/);
  assert.match(automodSource, /member\.kickable/);
  assert.match(automodSource, /member\.bannable/);
});
