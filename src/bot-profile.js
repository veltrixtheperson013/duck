import { createHash } from "node:crypto";
import { Routes } from "discord.js";
import { hasMaturePlusEntitlement } from "./dashboard-config.js";

export function profileRequest(message, spec, value) {
  if (!["avatar", "banner"].includes(spec.profileField) || value === null) {
    makeGuildProfilePatch({ [spec.profileField]: value });
    return { value };
  }
  const attachment = message.attachments?.get(value);
  if (!attachment || !/^image\/(png|jpeg|webp|gif)$/.test(attachment.contentType || "") || attachment.size > 5 * 1024 * 1024) throw new TypeError("Choose a PNG, JPEG, WebP, or GIF image attached to this request, at most 5 MB.");
  return { value, profileAttachment: { url: attachment.url, name: attachment.name, size: attachment.size, contentType: attachment.contentType } };
}
function assertEntitlement(settings) { if (!hasMaturePlusEntitlement(settings)) throw new Error("Server branding unlocks after three months of paid Duck Plus."); }
function profileValue(bot, field) { return bot[field === "nickname" ? "nickname" : field] ?? null; }
export async function prepareProfileAction(guild, spec, raw, settings, fetchImpl = fetch) {
  assertEntitlement(settings);
  const bot = await guild.members.fetchMe({ force: true });
  let value = raw.value; let image;
  if (["avatar", "banner"].includes(spec.profileField) && value !== null) {
    const attachment = raw.profileAttachment;
    const url = new URL(attachment?.url || "https://invalid.local/");
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) || !url.pathname.startsWith("/attachments/") || url.username || url.password || url.port) throw new Error("Profile images must come from a Discord attachment on this request.");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(attachment.contentType || "") || attachment.size > 5 * 1024 * 1024) throw new Error("Profile image must be at most 5 MB.");
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Discord could not return that attachment. Attach it again.");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error("Profile image exceeds 5 MB."); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); value = `data:${attachment.contentType};base64,${bytes.toString("base64")}`;
    image = { name: String(attachment.name || "image").slice(0, 256), sizeBytes: size, sha256: createHash("sha256").update(bytes).digest("hex"), source: url.href };
  }
  const patch = makeGuildProfilePatch({ [spec.profileField]: value });
  return { profileField: spec.profileField, profilePatch: patch, beforeProfile: profileValue(bot, spec.profileField), image, summary: `Change only Duck's server ${spec.profileField}: ${image ? JSON.stringify(image) : JSON.stringify(value)}. Administrator approval required.` };
}
export async function executeProfileAction(guild, member, action, settings) {
  assertEntitlement(settings);
  const bot = await guild.members.fetchMe({ force: true });
  if (profileValue(bot, action.profileField) !== action.beforeProfile) throw new Error("Duck's profile changed since the preview. Request a fresh approval.");
  // The exact validated image bytes are retained in the pending action; no URL is fetched after approval.
  const field = action.profileField; const value = action.profilePatch[field === "nickname" ? "nick" : field];
  const patch = makeGuildProfilePatch({ [field]: value });
  await guild.client.rest.patch(Routes.guildMember(guild.id, "@me"), { body: patch, reason: `Duck server profile approved by ${member.id}` });
  return `Updated Duck's server ${field}.`;
}

function parseProfileImage(value, field) {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be an image or null.`);
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new TypeError(`${field} must be a PNG, JPEG, WebP, or GIF image.`);
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new TypeError(`${field} must be 5 MB or smaller.`);
  const magic = match[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : match[1] === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
        : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString());
  if (!magic) throw new TypeError(`${field} contents do not match its image type.`);
  return value;
}
export function makeGuildProfilePatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Profile must be a JSON object.");
  const allowed = new Set(["nickname", "bio", "avatar", "banner"]); const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !allowed.has(key))) throw new TypeError("Unknown or missing profile field.");
  const patch = {};
  if ("nickname" in input) { if (input.nickname === null) patch.nick = null; else { if (typeof input.nickname !== "string") throw new TypeError("Server nickname must be text or null."); const value = input.nickname.trim(); if (!value || value.length > 32) throw new TypeError("Server nickname must be 1-32 characters or null."); patch.nick = value; } }
  if ("bio" in input) { if (input.bio === null) patch.bio = null; else { if (typeof input.bio !== "string") throw new TypeError("Server bio must be text or null."); const value = input.bio.trim(); if (value.length > 190) throw new TypeError("Server bio must be 190 characters or fewer."); patch.bio = value || null; } }
  if ("avatar" in input) patch.avatar = parseProfileImage(input.avatar, "Avatar");
  if ("banner" in input) patch.banner = parseProfileImage(input.banner, "Banner");
  return patch;
}
