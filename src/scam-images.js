import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { createWorker, OEM, PSM } from "tesseract.js";
import english from "@tesseract.js-data/eng";
import { loadJsonFile, saveJsonFile } from "./config.js";

const HASH_PATH = path.join(process.cwd(), "data", "scam-image-hashes.json");
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_HASHES = 2_000;
const MAX_CACHE = 1_000;
const HASH_DISTANCE = 8;
const MAX_OCR_QUEUE = 4;
const ALLOWED_IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const imageHashCache = new Map();
let activeImageJobs = 0;
let queuedOcrJobs = 0;
let ocrTail = Promise.resolve();
let ocrWorkerPromise = null;

function differenceHash(pixels) {
  if (!Buffer.isBuffer(pixels) || pixels.length !== 72) return null;
  let bits = 0n;
  let offset = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (pixels[row * 9 + column] > pixels[row * 9 + column + 1]) bits |= 1n << offset;
      offset += 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hammingDistance(left, right) {
  if (!/^[0-9a-f]{16}$/i.test(left || "") || !/^[0-9a-f]{16}$/i.test(right || "")) return Infinity;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { value &= value - 1n; count += 1; }
  return count;
}

function findClosestHash(hash, entries, maxDistance = HASH_DISTANCE) {
  let best = null;
  for (const [knownHash, metadata] of Object.entries(entries || {})) {
    const distance = hammingDistance(hash, knownHash);
    if (distance <= maxDistance && (!best || distance < best.distance)) best = { hash: knownHash, distance, metadata };
  }
  return best;
}

function hashStore() {
  const stored = loadJsonFile(HASH_PATH, { hashes: {} });
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { hashes: {} };
  if (!stored.hashes || typeof stored.hashes !== "object" || Array.isArray(stored.hashes)) stored.hashes = {};
  for (const hash of Object.keys(stored.hashes)) if (!/^[0-9a-f]{16}$/i.test(hash)) delete stored.hashes[hash];
  return stored;
}

function rememberScamHash(hash, reason) {
  if (!/^[0-9a-f]{16}$/i.test(hash || "")) return false;
  const stored = hashStore();
  stored.hashes[hash.toLowerCase()] = { reason: String(reason || "High-confidence scam image").slice(0, 160), learnedAt: new Date().toISOString() };
  const ordered = Object.entries(stored.hashes).sort(([, left], [, right]) => Date.parse(left?.learnedAt || 0) - Date.parse(right?.learnedAt || 0));
  while (ordered.length > MAX_HASHES) { const [oldest] = ordered.shift(); delete stored.hashes[oldest]; }
  saveJsonFile(HASH_PATH, stored);
  return true;
}

function safeAttachmentUrl(attachment) {
  if (!attachment || Number(attachment.size || 0) > MAX_IMAGE_BYTES) return null;
  const type = String(attachment.contentType || "").toLowerCase();
  const name = String(attachment.name || "");
  if (!type.startsWith("image/") && !/\.(?:png|jpe?g|webp|gif)$/i.test(name)) return null;
  try {
    const url = new URL(attachment.url);
    return url.protocol === "https:" && ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch { return null; }
}

async function readBoundedImage(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" } });
  const length = Number(response.headers.get("content-length") || 0);
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || !type.startsWith("image/") || length > MAX_IMAGE_BYTES || !response.body) return null;
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) return null;
    chunks.push(chunk);
  }
  return total ? Buffer.concat(chunks, total) : null;
}

async function imageDifferenceHash(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || !ffmpegPath) return null;
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "scale=9:8:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const output = []; let size = 0; let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 4_000); timer.unref?.();
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 72) output.push(chunk); else child.kill(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && size === 72 ? differenceHash(Buffer.concat(output, size)) : null));
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

async function prepareOcrImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || !ffmpegPath) return null;
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease,format=gray", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const output = []; let size = 0; let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 5_000); timer.unref?.();
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= MAX_IMAGE_BYTES) output.push(chunk); else child.kill(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && size > 0 && size <= MAX_IMAGE_BYTES ? Buffer.concat(output, size) : null));
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(english.code, OEM.LSTM_ONLY, {
      cacheMethod: "none",
      gzip: english.gzip,
      langPath: english.langPath,
      logger: () => {},
    }).then(async (worker) => {
      await worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: "150" });
      return worker;
    }).catch(() => { ocrWorkerPromise = null; return null; });
  }
  return ocrWorkerPromise;
}

async function terminateOcrWorker(expected) {
  const pending = ocrWorkerPromise;
  if (!pending) return;
  const worker = await pending.catch(() => null);
  if (worker !== expected || ocrWorkerPromise !== pending) return;
  ocrWorkerPromise = null;
  await worker?.terminate().catch(() => null);
}

async function runOcr(bytes) {
  const prepared = await prepareOcrImage(bytes);
  if (!prepared) return null;
  const worker = await getOcrWorker();
  if (!worker) return null;
  let timer;
  const timeout = Symbol("ocr-timeout");
  const recognition = worker.recognize(prepared).then((result) => String(result?.data?.text || "").slice(0, 8_000)).catch(() => null);
  const result = await Promise.race([recognition, new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 15_000); timer.unref?.(); })]);
  clearTimeout(timer);
  if (result === timeout) { await terminateOcrWorker(worker); return null; }
  return result;
}

async function recognizeImageText(bytes) {
  if (queuedOcrJobs >= MAX_OCR_QUEUE) return null;
  queuedOcrJobs += 1;
  const task = ocrTail.catch(() => null).then(() => runOcr(bytes));
  ocrTail = task.then(() => null, () => null);
  try { return await task; } catch { return null; } finally { queuedOcrJobs -= 1; }
}

async function hashAttachment(attachment) {
  const url = safeAttachmentUrl(attachment);
  if (!url || activeImageJobs >= 2) return null;
  const cacheKey = `${attachment.id || url.pathname}:${attachment.size || 0}`;
  if (imageHashCache.has(cacheKey)) return { bytes: null, hash: imageHashCache.get(cacheKey) };
  activeImageJobs += 1;
  try {
    const bytes = await readBoundedImage(url);
    const hash = bytes ? await imageDifferenceHash(bytes) : null;
    if (hash) {
      imageHashCache.set(cacheKey, hash);
      while (imageHashCache.size > MAX_CACHE) imageHashCache.delete(imageHashCache.keys().next().value);
    }
    return { bytes, hash };
  } catch { return null; } finally { activeImageJobs -= 1; }
}

async function scanScamImages(message, learnReason = null, textDetector = null) {
  const attachments = [...(message?.attachments?.values?.() || [])].filter((attachment) => safeAttachmentUrl(attachment)).slice(0, 1);
  if (!attachments.length) return null;
  const analysis = await hashAttachment(attachments[0]);
  const hash = analysis?.hash;
  if (!hash) return null;
  if (learnReason) { rememberScamHash(hash, learnReason); return null; }
  const match = findClosestHash(hash, hashStore().hashes);
  if (match) return `Known scam image repost (visual distance ${match.distance})`;
  if (typeof textDetector !== "function") return null;
  const bytes = analysis.bytes || await readBoundedImage(safeAttachmentUrl(attachments[0]));
  const text = bytes ? await recognizeImageText(bytes) : null;
  const reason = text ? textDetector(text) : null;
  if (!reason) return null;
  rememberScamHash(hash, reason);
  return `Scam text detected inside image: ${reason}`;
}

export { differenceHash, findClosestHash, hammingDistance, imageDifferenceHash, recognizeImageText, rememberScamHash, scanScamImages };
