import assert from "node:assert/strict";
import test from "node:test";
import {
  FairGuildScheduler,
  QueueCapacityError,
  fetchWithTimeoutAndRetry,
  modelSupportsVision,
  readBoundedJson,
  readBoundedText,
} from "../src/runtime.js";

test("vision is model-aware and Tencent HY3 is never auto-enabled", () => {
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free"), false);
  assert.equal(modelSupportsVision("OpenRouter", "cohere/north-mini-code:free"), false);
  assert.equal(modelSupportsVision("OpenRouter", "google/gemini-2.5-flash"), true);
  assert.equal(modelSupportsVision("OpenRouter", "custom/model", { models: "custom/model" }), true);
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free", { mode: "off" }), false);
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free", { mode: "on" }), false);
});

test("the scheduler serializes one guild while allowing another guild to progress", async () => {
  const scheduler = new FairGuildScheduler({ globalConcurrency: 2, guildConcurrency: 1, maxQueuedPerGuild: 2 });
  const events = [];
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = scheduler.schedule("guild-a", async () => {
    events.push("a1-start");
    await blocker;
    events.push("a1-end");
  }).promise;
  await new Promise((resolve) => setImmediate(resolve));
  const second = scheduler.schedule("guild-a", async () => events.push("a2")).promise;
  const otherGuild = scheduler.schedule("guild-b", async () => events.push("b1")).promise;
  await otherGuild;
  assert.deepEqual(events, ["a1-start", "b1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
  assert.equal(scheduler.snapshot("guild-a").queuedForGuild, 0);
});

test("the scheduler rejects work beyond the per-guild queue cap", async () => {
  const scheduler = new FairGuildScheduler({ globalConcurrency: 1, guildConcurrency: 1, maxQueuedPerGuild: 1 });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const active = scheduler.schedule("guild", () => blocker).promise;
  await new Promise((resolve) => setImmediate(resolve));
  const queued = scheduler.schedule("guild", async () => "queued").promise;
  assert.throws(() => scheduler.schedule("guild", async () => "overflow"), QueueCapacityError);
  release();
  await Promise.all([active, queued]);
});

test("bounded readers accept small JSON and reject oversized responses", async () => {
  assert.deepEqual(await readBoundedJson(new Response('{"ok":true}'), 100), { ok: true });
  await assert.rejects(() => readBoundedText(new Response("x".repeat(101)), 100), /exceeded 100 bytes/);
});

test("network policy retries transient responses and enforces a deadline", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 503 }) : new Response("ok");
    };
    const response = await fetchWithTimeoutAndRetry("https://example.invalid", {}, { attempts: 2, timeoutMs: 1_000 });
    assert.equal(await response.text(), "ok");
    assert.equal(calls, 2);

    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    await assert.rejects(
      () => fetchWithTimeoutAndRetry("https://example.invalid", {}, { attempts: 1, timeoutMs: 1_000 }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
