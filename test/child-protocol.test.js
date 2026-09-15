import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagerClock,
  fetchWithDeadline,
  readManagerJson,
  retryDelay,
} from "../child/src/protocol.js";

function createMockTime(initialTime = 1_800_000_000_000) {
  let currentTime = initialTime;
  return {
    now: () => currentTime,
    advance: (ms) => {
      currentTime += ms;
      return currentTime;
    },
    set: (ms) => {
      currentTime = ms;
      return currentTime;
    },
  };
}

test("Child Protocol - Parsing & Handling", async (t) => {
  await t.test("refuses HTML responses without attempting JSON parsing", async () => {
    const htmlResponse = new Response("<!DOCTYPE html><title>proxy error</title>", {
      status: 502,
      headers: {
        "Content-Type": "text/html",
        "X-Request-ID": "request-123",
      },
    });

    await assert.rejects(
      () => readManagerJson(htmlResponse),
      (error) =>
        error.code === "manager_non_json" &&
        error.retryable === true &&
        /non-JSON HTTP 502/.test(error.message) &&
        /request-123/.test(error.message) &&
        !error.message.includes("DOCTYPE")
    );
  });

  await t.test("accepts valid JSON and respects rate-limit headers", async () => {
    const validResponse = new Response('{"ok":true}', {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Duck-Child-Protocol": "1",
      },
    });
    assert.deepEqual(await readManagerJson(validResponse), { ok: true });

    const rateLimitedResponse = new Response('{"error":"slow down"}', {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "8",
      },
    });

    await assert.rejects(
      () => readManagerJson(rateLimitedResponse),
      (error) =>
        error.status === 429 &&
        error.retryable === true &&
        error.retryAfterMs === 8_000
    );
  });
});

test("Child Clock - Resynchronization", async (t) => {
  await t.test("safely resynchronizes after clock-skew observation", () => {
    const time = createMockTime();
    const clock = createManagerClock(time.now);

    assert.equal(clock.now(), 1_800_000_000_000);

    const observeSuccess = clock.observe(1_800_000_000_000 + 90_000, { immediate: true });
    assert.equal(observeSuccess, true);
    assert.equal(clock.now(), 1_800_000_090_000);

    time.advance(1_000);
    assert.equal(clock.now(), 1_800_000_091_000);

    // Excessive clock (>24 hours) should be rejected!!
    const excessiveSkew = time.now() + 25 * 60 * 60_000;
    assert.equal(clock.observe(excessiveSkew, { immediate: true }), false);
  });
});

test("Child Retry & Network Deadlines", async (t) => {
  await t.test("calculates bounded exponential backoff delay", () => {
    const fixedRandom = { random: () => 0 };

    assert.equal(retryDelay(1, fixedRandom), 1_000);
    assert.equal(retryDelay(99, fixedRandom), 30_000);
    assert.equal(retryDelay(1, { ...fixedRandom, retryAfterMs: 8_000 }), 8_000);
  });

  await t.test("aborts stalled network requests at deadline", async () => {
    const mockFetchWithTimeout = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true }
        );
      });

    await assert.rejects(
      () => fetchWithDeadline("https://example.invalid", {}, 1_000, mockFetchWithTimeout),
      (error) => error.code === "manager_timeout" && error.retryable === true
    );
  });
});