import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";

const MANIFEST_NAME = "duck-captcha-manifest.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4;

/** @type {Map<string, { mtimeMs: number, size: number, value: any }>} */
const manifestCache = new Map();

/**
 * Normalizes user input for CAPTCHA comparison.
 * @param {string} value
 * @returns {string}
 */
function normalizeCaptchaAnswer(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
}

/**
 * Resolves the absolute root path for the CAPTCHA dataset.
 * @param {string} [value]
 * @returns {string}
 */
function captchaRoot(value = process.env.DUCK_CAPTCHA_DATASET_PATH) {
  return path.resolve(process.cwd(), String(value || "data/captcha-dataset").trim());
}

/**
 * Validates a manifest entry and returns a safe absolute file path.
 * @param {string} root
 * @param {any} entry
 * @returns {{ file: string, answer: string } | null}
 */
function safeManifestEntry(root, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const relativePath = String(entry.path || "").replaceAll("\\", "/");
  const answer = normalizeCaptchaAnswer(entry.answer);

  if (
    !relativePath ||
    relativePath.length > 512 ||
    path.isAbsolute(relativePath) ||
    !/^[a-z0-9]{3,12}$/.test(answer) ||
    !/\.(?:png|jpe?g|gif|webp)$/i.test(relativePath)
  ) {
    return null;
  }

  const resolvedFile = path.resolve(root, relativePath);
  const relativeFromRoot = path.relative(root, resolvedFile);

  // Ensure resolved path stays strictly within root directory
  const isInsideRoot =
    !relativeFromRoot.startsWith("..") &&
    !path.isAbsolute(relativeFromRoot) &&
    relativeFromRoot !== "";

  return isInsideRoot ? { file: resolvedFile, answer } : null;
}

/**
 * Reads and caches the CAPTCHA dataset manifest.
 * @param {string} [root]
 * @returns {{ root: string, entries: Array<{ file: string, answer: string }>, error: string | null }}
 */
function loadManifest(root = captchaRoot()) {
  const manifestPath = path.join(root, MANIFEST_NAME);

  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch {
    return {
      root,
      entries: [],
      error: `Run npm run setup:captcha, then set DUCK_CAPTCHA_DATASET_PATH=${root}`,
    };
  }

  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) {
    return {
      root,
      entries: [],
      error: "The image CAPTCHA manifest is missing or too large.",
    };
  }

  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { root, entries: [], error: "The image CAPTCHA manifest is not valid JSON." };
  }

  if (
    parsed?.version !== 1 ||
    parsed?.source !== "parsasam/captcha-dataset" ||
    !Array.isArray(parsed?.entries) ||
    parsed.entries.length > MAX_ENTRIES
  ) {
    return { root, entries: [], error: "The image CAPTCHA manifest has an unsupported format." };
  }

  const entries = parsed.entries
    .map((entry) => safeManifestEntry(root, entry))
    .filter((entry) => entry !== null);

  const value = entries.length
    ? { root, entries, error: null }
    : {
        root,
        entries: [],
        error: "The image CAPTCHA manifest contains no safe labeled images.",
      };

  manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });

  // LRU Eviction
  while (manifestCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = manifestCache.keys().next().value;
    if (firstKey) manifestCache.delete(firstKey);
  }

  return value;
}

/**
 * Validates buffer headers to determine image file format safely.
 * @param {Buffer} buffer
 * @returns {{ extension: string, contentType: string } | null}
 */
function imageType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { extension: ".png", contentType: "image/png" };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    buffer.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    return { extension: ".webp", contentType: "image/webp" };
  }

  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      buffer.subarray(0, 6).equals(Buffer.from("GIF89a")))
  ) {
    return { extension: ".gif", contentType: "image/gif" };
  }

  return null;
}

/**
 * Selects a random CAPTCHA sample from the dataset.
 * @param {{ root?: string, random?: (max: number) => number }} [options]
 * @returns {{ answer: string, buffer: Buffer, extension: string, contentType: string }}
 */
function getImageCaptcha(options = {}) {
  const dataset = loadManifest(captchaRoot(options.root));
  if (!dataset.entries.length) {
    throw Object.assign(new Error(dataset.error || "Image CAPTCHA is unavailable."), {
      code: "CAPTCHA_DATASET_UNAVAILABLE",
    });
  }

  const getRandomIndex = options.random || randomInt;
  const maxAttempts = Math.min(20, dataset.entries.length);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const entry = dataset.entries[getRandomIndex(dataset.entries.length)];
    try {
      const stat = fs.statSync(entry.file);
      if (!stat.isFile() || stat.size < 16 || stat.size > MAX_IMAGE_BYTES) continue;

      const buffer = fs.readFileSync(entry.file);
      const type = imageType(buffer);
      if (!type) continue;

      return { answer: entry.answer, buffer, ...type };
    } catch {
      // Missing or unreadable file: try next random sample without throwing
    }
  }

  throw Object.assign(
    new Error("Duck could not read a safe image from the CAPTCHA dataset."),
    { code: "CAPTCHA_DATASET_UNAVAILABLE" }
  );
}

/**
 * Checks dataset availability and total available image count.
 * @param {{ root?: string }} [options]
 * @returns {{ ready: boolean, images: number, source: string, error: string | null }}
 */
function getImageCaptchaStatus(options = {}) {
  const dataset = loadManifest(captchaRoot(options.root));
  return {
    ready: dataset.entries.length > 0,
    images: dataset.entries.length,
    source: "parsasam/captcha-dataset",
    error: dataset.error,
  };
}

/**
 * Clears the manifest cache.
 */
function clearImageCaptchaCache() {
  manifestCache.clear();
}

export {
  clearImageCaptchaCache,
  getImageCaptcha,
  getImageCaptchaStatus,
  normalizeCaptchaAnswer,
};