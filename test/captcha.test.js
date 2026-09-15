import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearImageCaptchaCache,
  getImageCaptcha,
  getImageCaptchaStatus,
  normalizeCaptchaAnswer,
} from "../src/captcha.js";

/**
 * Creates a temporary fixture directory populated with sample captcha files.
 * @returns {string} Path to the temporary root directory
 */
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duck-captcha-"));
  
  // Minimal valid 8-byte PNG header followed by dummy bytes
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const imageBuffer = Buffer.concat([pngHeader, Buffer.alloc(24, 1)]);
  
  fs.writeFileSync(path.join(root, "sample.png"), imageBuffer);
  
  const manifest = {
    version: 1,
    source: "parsasam/captcha-dataset",
    entries: [
      { path: "sample.png", answer: "AbC123" },
      { path: "../outside.png", answer: "unsafe" }, // Path traversal attempt
    ],
  };
  
  fs.writeFileSync(
    path.join(root, "duck-captcha-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  return root;
}

test("image CAPTCHA loads a bounded safe local sample without exposing its filename", (t) => {
  const root = createFixture();
  
  t.after(() => {
    clearImageCaptchaCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  clearImageCaptchaCache();

  // Verify manifest loading filters out path traversal entries safely
  const status = getImageCaptchaStatus({ root });
  assert.deepEqual(status, {
    ready: true,
    images: 1,
    source: "parsasam/captcha-dataset",
    error: null,
  });

  // Verify sample retrieval and normalization
  const sample = getImageCaptcha({ root, random: () => 0 });
  assert.equal(sample.answer, "abc123");
  assert.equal(sample.extension, ".png");
  assert.ok(Buffer.isBuffer(sample.buffer));
  assert.equal(sample.buffer.length, 32);
});

test("image CAPTCHA answers ignore harmless case and punctuation differences", () => {
  assert.equal(normalizeCaptchaAnswer("  Ab-C 123! "), "abc123");
  assert.equal(normalizeCaptchaAnswer(""), "");
});

test("missing image CAPTCHA datasets fail closed", (t) => {
  t.after(() => clearImageCaptchaCache());
  
  clearImageCaptchaCache();
  const missingRoot = path.join(os.tmpdir(), `duck-captcha-missing-${Date.now()}`);

  const status = getImageCaptchaStatus({ root: missingRoot });
  assert.equal(status.ready, false);
  assert.ok(status.error !== null);

  assert.throws(
    () => getImageCaptcha({ root: missingRoot }),
    {
      code: "CAPTCHA_DATASET_UNAVAILABLE",
    }
  );
});