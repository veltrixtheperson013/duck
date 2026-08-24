import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearImageCaptchaCache, getImageCaptcha, getImageCaptchaStatus, normalizeCaptchaAnswer } from "../src/captcha.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duck-captcha-"));
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24, 1)]);
  fs.writeFileSync(path.join(root, "sample.png"), image);
  fs.writeFileSync(path.join(root, "duck-captcha-manifest.json"), JSON.stringify({
    version: 1,
    source: "parsasam/captcha-dataset",
    entries: [{ path: "sample.png", answer: "AbC123" }, { path: "../outside.png", answer: "unsafe" }],
  }));
  return root;
}

test("image CAPTCHA loads a bounded safe local sample without exposing its filename", () => {
  const root = fixture();
  try {
    clearImageCaptchaCache();
    assert.deepEqual(getImageCaptchaStatus({ root }), { ready: true, images: 1, source: "parsasam/captcha-dataset", error: null });
    const sample = getImageCaptcha({ root, random: () => 0 });
    assert.equal(sample.answer, "abc123");
    assert.equal(sample.extension, ".png");
    assert.ok(Buffer.isBuffer(sample.buffer));
  } finally { clearImageCaptchaCache(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("image CAPTCHA answers ignore harmless case and punctuation differences", () => {
  assert.equal(normalizeCaptchaAnswer("  Ab-C 123! "), "abc123");
});

test("missing image CAPTCHA datasets fail closed", () => {
  clearImageCaptchaCache();
  const missing = path.join(os.tmpdir(), `duck-captcha-missing-${Date.now()}`);
  assert.equal(getImageCaptchaStatus({ root: missing }).ready, false);
  assert.throws(() => getImageCaptcha({ root: missing }), (error) => error?.code === "CAPTCHA_DATASET_UNAVAILABLE");
});
