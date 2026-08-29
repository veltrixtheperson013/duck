import assert from "node:assert/strict";
import test from "node:test";
import { createManagerClock, fetchWithDeadline, readManagerJson, retryDelay } from "../child/src/protocol.js";

test("child protocol refuses HTML without trying to parse it as JSON", async () => {
  const response = new Response("<!DOCTYPE html><title>proxy error</title>", {
    status: 502,
    headers: { "Content-Type": "text/html", "X-Request-ID": "request-123" },
  });
  await assert.rejects(
    () => readManagerJson(response),
    (error) => error.code === "manager_non_json"
      && error.retryable === true
      && /non-JSON HTTP 502/.test(error.message)
      && /request-123/.test(error.message)
      && !error.message.includes("DOCTYPE"),
  );
});

test("child protocol accepts marked JSON and preserves retry guidance", async () => {
  const good = new Response('{"ok":true}', {
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Duck-Child-Protocol": "1" },
  });
  assert.deepEqual(await readManagerJson(good), { ok: true });

  const limited = new Response('{"error":"slow down"}', {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "8" },
  });
  await assert.rejects(
    () => readManagerJson(limited),
    (error) => error.status === 429 && error.retryable === true && error.retryAfterMs === 8_000,
  );
});

test("child clock safely resynchronizes after a manager clock-skew response", async () => {
  let localTime = 1_800_000_000_000;
  const clock = createManagerClock(() => localTime);
  assert.equal(clock.now(), localTime);
  assert.equal(clock.observe(localTime + 90_000, { immediate: true }), true);
  assert.equal(clock.now(), localTime + 90_000);
  localTime += 1_000;
  assert.equal(clock.now(), 1_800_000_091_000);
  assert.equal(clock.observe(localTime + (25 * 60 * 60_000), { immediate: true }), false);
});

test("child retry delay is bounded and fetch deadline aborts stalled requests", async () => {
  assert.equal(retryDelay(1, { random: () => 0 }), 1_000);
  assert.equal(retryDelay(99, { random: () => 0 }), 30_000);
  assert.equal(retryDelay(1, { retryAfterMs: 8_000, random: () => 0 }), 8_000);
  await assert.rejects(
    () => fetchWithDeadline("https://example.invalid", {}, 1_000, (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })),
    (error) => error.code === "manager_timeout" && error.retryable === true,
  );
});
