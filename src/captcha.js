import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";

const MANIFEST_NAME = "duck-captcha-manifest.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const cache = new Map();

function normalizeCaptchaAnswer(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "").slice(0, 32);
}

function captchaRoot(value = process.env.DUCK_CAPTCHA_DATASET_PATH) {
  return path.resolve(process.cwd(), String(value || "data/captcha-dataset").trim());
}

function safeManifestEntry(root, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const relative = String(entry.path || "").replaceAll("\\", "/");
  const answer = normalizeCaptchaAnswer(entry.answer);
  if (!relative || relative.length > 512 || path.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..") || !/^[a-z0-9]{3,12}$/.test(answer) || !/\.(?:png|jpe?g|gif|webp)$/i.test(relative)) return null;
  const file = path.resolve(root, ...relative.split("/"));
  const boundary = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return file.startsWith(boundary) ? { file, answer } : null;
}

function loadManifest(root = captchaRoot()) {
  const manifestPath = path.join(root, MANIFEST_NAME);
  let stat;
  try { stat = fs.statSync(manifestPath); } catch { return { root, entries: [], error: `Run npm run setup:captcha, then set DUCK_CAPTCHA_DATASET_PATH=${root}` }; }
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) return { root, entries: [], error: "The image CAPTCHA manifest is missing or too large." };
  const cached = cache.get(manifestPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) return cached.value;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return { root, entries: [], error: "The image CAPTCHA manifest is not valid JSON." }; }
  if (parsed?.version !== 1 || parsed?.source !== "parsasam/captcha-dataset" || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) return { root, entries: [], error: "The image CAPTCHA manifest has an unsupported format." };
  const entries = parsed.entries.map((entry) => safeManifestEntry(root, entry)).filter(Boolean);
  const value = entries.length ? { root, entries, error: null } : { root, entries: [], error: "The image CAPTCHA manifest contains no safe labeled images." };
  cache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  while (cache.size > 4) cache.delete(cache.keys().next().value);
  return value;
}

function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: ".png", contentType: "image/png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: ".jpg", contentType: "image/jpeg" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return { extension: ".webp", contentType: "image/webp" };
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return { extension: ".gif", contentType: "image/gif" };
  return null;
}

function getImageCaptcha(options = {}) {
  const dataset = loadManifest(captchaRoot(options.root));
  if (!dataset.entries.length) throw Object.assign(new Error(dataset.error || "Image CAPTCHA is unavailable."), { code: "CAPTCHA_DATASET_UNAVAILABLE" });
  const random = options.random || randomInt;
  for (let attempt = 0; attempt < Math.min(20, dataset.entries.length); attempt += 1) {
    const entry = dataset.entries[random(dataset.entries.length)];
    try {
      const stat = fs.statSync(entry.file);
      if (!stat.isFile() || stat.size < 16 || stat.size > MAX_IMAGE_BYTES) continue;
      const buffer = fs.readFileSync(entry.file); const type = imageType(buffer);
      if (!type) continue;
      return { answer: entry.answer, buffer, ...type };
    } catch { /* A missing sample is skipped without trusting another path. */ }
  }
  throw Object.assign(new Error("Duck could not read a safe image from the CAPTCHA dataset."), { code: "CAPTCHA_DATASET_UNAVAILABLE" });
}

function getImageCaptchaStatus(options = {}) {
  const dataset = loadManifest(captchaRoot(options.root));
  return { ready: dataset.entries.length > 0, images: dataset.entries.length, source: "parsasam/captcha-dataset", error: dataset.error };
}

function clearImageCaptchaCache() { cache.clear(); }

export { clearImageCaptchaCache, getImageCaptcha, getImageCaptchaStatus, normalizeCaptchaAnswer };
