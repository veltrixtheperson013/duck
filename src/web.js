import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PermissionsBitField, Routes } from "discord.js";
import { getPublicGuildSettings, getPublicModelCatalog, hasMaturePlusEntitlement, makeSettingsPatch } from "./dashboard-config.js";
import { readBoundedJson } from "./runtime.js";
import { getPublicBaseUrl, getStripeClient, isPlusEnabled, isStripeServerConfigured, makeDonationCheckoutInput, makePlusCheckoutInput, makeStripeSubscriptionPatch } from "./stripe.js";

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const pages = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }], ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/dashboard", { file: "dashboard.html", type: "text/html; charset=utf-8" }], ["/dashboard/", { file: "dashboard.html", type: "text/html; charset=utf-8" }], ["/dashboard.html", { file: "dashboard.html", type: "text/html; charset=utf-8" }],
  ["/pricing", { file: "pricing.html", type: "text/html; charset=utf-8" }], ["/pricing/", { file: "pricing.html", type: "text/html; charset=utf-8" }], ["/pricing.html", { file: "pricing.html", type: "text/html; charset=utf-8" }],
  ["/donate", { file: "donate.html", type: "text/html; charset=utf-8" }], ["/donate/", { file: "donate.html", type: "text/html; charset=utf-8" }], ["/donate.html", { file: "donate.html", type: "text/html; charset=utf-8" }],
  ["/refunds", { file: "refunds.html", type: "text/html; charset=utf-8" }], ["/refunds/", { file: "refunds.html", type: "text/html; charset=utf-8" }], ["/refunds.html", { file: "refunds.html", type: "text/html; charset=utf-8" }],
  ["/terms-of-service", { file: "terms-of-service.html", type: "text/html; charset=utf-8" }], ["/terms-of-service/", { file: "terms-of-service.html", type: "text/html; charset=utf-8" }], ["/terms-of-service.html", { file: "terms-of-service.html", type: "text/html; charset=utf-8" }],
  ["/privacy-policy", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }], ["/privacy-policy/", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }], ["/privacy-policy.html", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }],
  ["/guide", { file: "guide.html", type: "text/html; charset=utf-8" }], ["/guide/", { file: "guide.html", type: "text/html; charset=utf-8" }], ["/guide.html", { file: "guide.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }], ["/site.js", { file: "site.js", type: "text/javascript; charset=utf-8" }], ["/dashboard.js", { file: "dashboard.js", type: "text/javascript; charset=utf-8" }],
  ["/billing.js", { file: "billing.js", type: "text/javascript; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
]);
const assetCache = new Map([...new Set([...pages.values()].map(({ file }) => file))].map((file) => { const body = fs.readFileSync(path.join(publicDirectory, file)); return [file, { body, gzip: gzipSync(body, { level: 6 }), etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 24)}"` }]; }));
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const DUCK_OWNER_USER_ID = "1138897388694687834";

function securityHeaders(contentType) { return { "Content-Type": contentType, "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: https://cdn.discordapp.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Origin-Agent-Cluster": "?1", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "Referrer-Policy": "no-referrer", "Strict-Transport-Security": "max-age=31536000; includeSubDomains", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "X-Permitted-Cross-Domain-Policies": "none" }; }
function send(res, status, contentType, body, method = "GET", extraHeaders = {}) { const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); res.writeHead(status, { ...securityHeaders(contentType), "Cache-Control": "no-store", "Content-Length": payload.length, ...extraHeaders }); res.end(method === "HEAD" ? undefined : payload); }
function json(res, status, body, method = "GET", headers = {}) { send(res, status, "application/json; charset=utf-8", JSON.stringify(body), method, headers); }
function redirect(res, location, headers = {}) { res.writeHead(302, { ...securityHeaders("text/plain; charset=utf-8"), "Cache-Control": "no-store", Location: location, ...headers }); res.end(); }
function sendAsset(req, res, page, method) { const asset = assetCache.get(page.file); if (!asset) return send(res, 500, "text/plain; charset=utf-8", "Duck could not load this page.", method); const cacheControl = page.type === "image/svg+xml" ? "public, max-age=604800" : "no-cache"; const common = { ...securityHeaders(page.type), "Cache-Control": cacheControl, ETag: asset.etag, Vary: "Accept-Encoding" }; if (req.headers["if-none-match"] === asset.etag) { res.writeHead(304, common); return res.end(); } const zipped = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers["accept-encoding"] || ""); const body = zipped ? asset.gzip : asset.body; res.writeHead(200, { ...common, ...(zipped ? { "Content-Encoding": "gzip" } : {}), "Content-Length": body.length }); res.end(method === "HEAD" ? undefined : body); }
function parseCookies(req) { const cookies = Object.create(null); for (const part of String(req.headers.cookie || "").split(";")) { const [key, value] = part.trim().split(/=(.*)/s); if (!key) continue; try { cookies[key] = decodeURIComponent(value || ""); } catch { /* Ignore malformed attacker-controlled cookies. */ } } return cookies; }
function randomToken() { return randomBytes(32).toString("base64url"); }
function hasManageGuildPermission(guild) { if (guild?.owner) return true; try { const permissions = BigInt(guild?.permissions || "0"); return (permissions & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n; } catch { return false; } }
function hasAdministratorPermission(guild) { if (guild?.owner) return true; try { return (BigInt(guild?.permissions || "0") & ADMINISTRATOR) !== 0n; } catch { return false; } }
function makeBotInviteUrl(guildId, clientId = process.env.CLIENT_ID || "1507850959642955816") { const url = new URL("https://discord.com/oauth2/authorize"); url.searchParams.set("client_id", clientId); url.searchParams.set("guild_id", guildId); url.searchParams.set("disable_guild_select", "true"); return url.toString(); }
function makeDonationUrl(template, amount) { if (!template || ![1, 5, 10, 20, 50, 100].includes(amount)) return null; try { const url = new URL(template.replaceAll("{amount}", String(amount))); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function isDuckOwner(userId) { return String(userId || "") === DUCK_OWNER_USER_ID; }
function withOwnerPlus(settings, userId) { if (!isDuckOwner(userId) || settings?.subscription?.provider === "stripe") return settings; return { ...settings, subscription: { provider: "owner", tier: "plus", status: "active", expiresAt: null, grantedTo: DUCK_OWNER_USER_ID } }; }
function getGuildTextChannels(client, guildId, requester, requesterIsAdministrator = false) { const guild = client?.guilds?.cache?.get(guildId); if (!guild?.channels?.cache) return []; return [...guild.channels.cache.values()].filter((channel) => channel?.isTextBased?.() && !channel?.isThread?.() && typeof channel.send === "function" && (requesterIsAdministrator || channel.permissionsFor?.(requester)?.has(PermissionsBitField.Flags.ViewChannel))).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).slice(0, 500).map((channel) => ({ id: channel.id, name: channel.name || "unnamed-channel" })); }
function getGuildBotProfile(client, guildId) { const member = client?.guilds?.cache?.get(guildId)?.members?.me; return { nickname: member?.nickname ?? null, bio: member?.bio ?? null, avatarUrl: member?.displayAvatarURL?.({ extension: "webp", size: 256 }) ?? null, bannerUrl: member?.bannerURL?.({ extension: "webp", size: 512 }) ?? null }; }
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
function makeGuildProfilePatch(input) {
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
async function readBody(req, maxBytes = 16 * 1024) { const chunks = []; let total = 0; for await (const chunk of req) { total += chunk.length; if (total > maxBytes) { const error = new Error("Request body is too large."); error.status = 413; throw error; } chunks.push(chunk); } return Buffer.concat(chunks, total); }

function validateJsonShape(value) {
  const dangerous = new Set(["__proto__", "prototype", "constructor"]);
  const pending = [{ value, depth: 0 }]; let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++visited > 5_000 || current.depth > 12) throw Object.assign(new TypeError("JSON input is too complex."), { status: 400 });
    if (!current.value || typeof current.value !== "object") continue;
    for (const key of Object.keys(current.value)) {
      if (dangerous.has(key)) throw Object.assign(new TypeError("Unsafe JSON property."), { status: 400 });
      pending.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
  return value;
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw Object.assign(new TypeError("Content-Type must be application/json."), { status: 415 });
  return validateJsonShape(JSON.parse((await readBody(req, maxBytes)).toString("utf8") || "{}"));
}

function safeProviderUrl(value, allowedHosts) {
  try { const url = new URL(value); return url.protocol === "https:" && allowedHosts.has(url.hostname) ? url.toString() : null; } catch { return null; }
}

function canManageBilling(guild, subscription, userId) {
  return Boolean(guild?.owner || (/^\d{10,}$/.test(subscription?.purchaserId || "") && subscription.purchaserId === userId));
}

function setBoundedMapEntry(map, key, value, maximum) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function normalizeDiscordGuilds(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error("Discord returned an invalid server list."), { status: 502 });
  return value.slice(0, 500).filter((guild) => guild && /^\d{10,}$/.test(String(guild.id || "")) && /^\d+$/.test(String(guild.permissions || "0"))).map((guild) => ({ id: String(guild.id), name: typeof guild.name === "string" ? guild.name.slice(0, 100) : "Discord server", icon: typeof guild.icon === "string" && /^[a-zA-Z0-9_]+$/.test(guild.icon) ? guild.icon : null, owner: guild.owner === true, permissions: String(guild.permissions) }));
}

function discordTokenExpiry(tokens) {
  const seconds = Number(tokens?.expires_in);
  return Date.now() + Math.max(60, Math.min(Number.isFinite(seconds) ? seconds : 3_600, 86_400)) * 1_000;
}

function createDuckWebsiteServer(options = {}) {
  const discordFetch = options.fetchImpl || fetch;
  const client = options.client;
  const getGuildSettings = options.getGuildSettings || (() => ({}));
  const updateGuildSettings = options.updateGuildSettings || (() => {});
  const stripe = options.stripeClient ?? getStripeClient();
  const sessions = new Map(); const webhookEvents = new Map();
  const oauthStateSecret = randomBytes(32);
  const requestRates = new Map(); const globalRates = new Map(); const billingCheckoutLocks = new Set();
  let lastPruneAt = 0; let discordInflight = 0;
  const discordTimeoutMs = Math.max(100, Math.min(Number(options.discordTimeoutMs) || 10_000, 30_000));
  const clientId = () => String(process.env.CLIENT_ID || "").trim();
  const clientSecret = () => String(process.env.DISCORD_CLIENT_SECRET || "").trim();
  const redirectUri = () => String(process.env.DISCORD_OAUTH_REDIRECT_URI || "https://duck.wispbyte.app/auth/discord/callback").trim();
  const secureCookie = () => !/^(0|false|no)$/i.test(process.env.DUCK_SESSION_SECURE || "") && redirectUri().startsWith("https:");
  const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie() ? "; Secure" : ""}`;
  const prune = (force = false) => { const now = Date.now(); if (!force && now - lastPruneAt < 30_000 && sessions.size <= 5_000 && webhookEvents.size <= 10_000 && requestRates.size <= 10_000) return; lastPruneAt = now; for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key); for (const [key, value] of webhookEvents) if (value <= now) webhookEvents.delete(key); for (const [key, value] of requestRates) if (value.resetAt <= now) requestRates.delete(key); for (const [key, value] of globalRates) if (value.resetAt <= now) globalRates.delete(key); while (sessions.size > 5_000) sessions.delete(sessions.keys().next().value); while (webhookEvents.size > 10_000) webhookEvents.delete(webhookEvents.keys().next().value); while (requestRates.size > 10_000) requestRates.delete(requestRates.keys().next().value); };
  function makeOAuthState() { const payload = `${Date.now()}.${randomToken()}`; const signature = createHmac("sha256", oauthStateSecret).update(payload).digest("base64url"); return `${payload}.${signature}`; }
  function verifyOAuthState(value) { const parts = String(value || "").split("."); const createdAt = Number(parts[0]); if (parts.length !== 3 || !Number.isFinite(createdAt) || createdAt > Date.now() + 60_000 || Date.now() - createdAt > 10 * 60_000) return false; const expected = createHmac("sha256", oauthStateSecret).update(`${parts[0]}.${parts[1]}`).digest(); let supplied; try { supplied = Buffer.from(parts[2], "base64url"); } catch { return false; } return supplied.length === expected.length && timingSafeEqual(supplied, expected); }
  function allowRequest(req, bucket, limit, windowMs) { const now = Date.now(); const globalLimit = Math.max(limit * 10, 100); let global = globalRates.get(bucket); if (!global || global.resetAt <= now) { global = { count: 0, resetAt: now + windowMs }; globalRates.set(bucket, global); } if (++global.count > globalLimit) return false; const key = `${req.socket.remoteAddress || "unknown"}:${bucket}`; let current = requestRates.get(key); if (!current || current.resetAt <= now) { current = { count: 0, resetAt: now + windowMs }; setBoundedMapEntry(requestRates, key, current, 10_000); } current.count += 1; return current.count <= limit; }
  async function discordJson(url, options = {}, session = null, maxBytes = 1024 * 1024) {
    if (discordInflight >= 20 || (session?.discordInflight || 0) >= 2) throw Object.assign(new Error("Discord is busy. Try again shortly."), { status: 429 });
    discordInflight += 1; if (session) session.discordInflight = (session.discordInflight || 0) + 1;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), discordTimeoutMs); timeout.unref?.();
    try {
      const response = await discordFetch(url, { ...options, signal: controller.signal });
      let body; try { body = await readBoundedJson(response, maxBytes); } catch (error) { throw Object.assign(new Error("Discord returned an invalid or oversized response."), { status: 502, cause: error }); }
      return { response, body };
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error("Discord took too long to respond."), { status: 504, cause: error });
      throw error;
    } finally { clearTimeout(timeout); discordInflight -= 1; if (session) session.discordInflight -= 1; }
  }
  async function tokenRequest(parameters, session = null) { const { response, body } = await discordJson("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...parameters }) }, session, 128 * 1024); if (!response.ok || typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 4_096 || (body.refresh_token != null && (typeof body.refresh_token !== "string" || body.refresh_token.length > 4_096))) throw new Error("Discord sign-in could not be completed."); return body; }
  async function discordApi(session, route) { if (session.tokenExpiresAt <= Date.now() + 60_000) { session.refreshPromise ??= tokenRequest({ grant_type: "refresh_token", refresh_token: session.refreshToken }, session).then((tokens) => { session.accessToken = tokens.access_token; session.refreshToken = tokens.refresh_token || session.refreshToken; session.tokenExpiresAt = discordTokenExpiry(tokens); }).finally(() => { session.refreshPromise = null; }); await session.refreshPromise; } const { response, body } = await discordJson(`https://discord.com/api/v10${route}`, { headers: { Authorization: `Bearer ${session.accessToken}` } }, session); if (!response.ok) throw new Error("Discord could not return your server list."); return route === "/users/@me/guilds" ? normalizeDiscordGuilds(body) : body; }
  function getSession(req) { prune(); const id = parseCookies(req).duck_session; const session = id && sessions.get(id); return session ? { id, session } : null; }
  async function guildAccess(req, guildId, fresh = false) { const auth = getSession(req); if (!auth) return { error: "Sign in with Discord first.", status: 401 }; const guilds = !fresh && auth.session.guilds && auth.session.guildsAt > Date.now() - 30_000 ? auth.session.guilds : await discordApi(auth.session, "/users/@me/guilds"); auth.session.guilds = guilds; auth.session.guildsAt = Date.now(); const guild = guilds.find(({ id }) => id === guildId); if (!guild) return { error: "You are not a member of that server.", status: 403 }; if (!hasManageGuildPermission(guild)) return { error: "Manage Server permission is required.", status: 403 }; const botGuild = client?.guilds?.cache?.get(guildId); if (!botGuild) return { error: "Invite Duck to this server before configuring it.", status: 409 }; const isAdministrator = hasAdministratorPermission(guild); let member = null; if (!isAdministrator) { member = botGuild.members?.cache?.get(auth.session.user.id) ?? (botGuild.members?.fetch ? await botGuild.members.fetch({ user: auth.session.user.id, force: true }).catch(() => null) : null); if (!member) return { error: "Duck could not verify your current server membership.", status: 403 }; } return { ...auth, guild, botGuild, member, isAdministrator }; }
  function requireCsrf(req, auth) { const supplied = Buffer.from(String(req.headers["x-duck-csrf"] || "")); const expected = Buffer.from(String(auth.session.csrf || "")); return supplied.length > 20 && supplied.length === expected.length && timingSafeEqual(supplied, expected); }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    const method = req.method || "GET"; let pathname;
    try { pathname = new URL(req.url || "/", "http://duck.local").pathname; } catch { return send(res, 400, "text/plain; charset=utf-8", "Bad request.", method); }
    try {
      prune();
      const rate = pathname.startsWith("/auth/") ? ["auth", 30, 10 * 60_000] : pathname === "/api/billing/webhook" ? ["billing-webhook", 120, 60_000] : pathname === "/donate/checkout" ? ["billing-donation", 10, 60_000] : pathname.endsWith("/branding") ? ["branding", 6, 60_000] : pathname.includes("/billing/") ? ["billing-user", 20, 60_000] : ["web", 300, 60_000];
      if (!allowRequest(req, ...rate)) return json(res, 429, { error: "Too many requests. Try again shortly." }, method, { "Retry-After": "60" });
      if (pathname === "/health" && ["GET", "HEAD"].includes(method)) return json(res, 200, { ok: true, service: "duck" }, method);
      if (pathname === "/api/stats" && method === "GET") return json(res, 200, { servers: Math.max(0, Number(client?.guilds?.cache?.size) || 0) }, method, { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" });
      if (pathname === "/api/site-config" && method === "GET") return json(res, 200, { plusEnabled: isPlusEnabled() }, method);
      if (pathname === "/auth/discord" && method === "GET") { if (!clientId() || !clientSecret()) return json(res, 503, { error: "Discord login is not configured yet." }); prune(); const state = makeOAuthState(); const url = new URL("https://discord.com/oauth2/authorize"); url.searchParams.set("client_id", clientId()); url.searchParams.set("response_type", "code"); url.searchParams.set("redirect_uri", redirectUri()); url.searchParams.set("scope", "identify guilds"); url.searchParams.set("state", state); return redirect(res, url.toString(), { "Set-Cookie": cookie("duck_oauth_state", state, 600) }); }
      if (pathname === "/auth/discord/callback" && method === "GET") { const url = new URL(req.url, "http://duck.local"); const state = url.searchParams.get("state"); const code = url.searchParams.get("code"); const expected = parseCookies(req).duck_oauth_state; if (!state || !code || code.length > 2_048 || expected !== state || !verifyOAuthState(state)) return json(res, 400, { error: "Discord sign-in state was invalid or expired." }); const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }); const { response: userResponse, body: user } = await discordJson("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${tokens.access_token}` } }, null, 128 * 1024); if (!userResponse.ok || !/^\d{10,}$/.test(String(user.id || ""))) return json(res, 502, { error: "Discord could not return your account." }); const id = randomToken(); sessions.set(id, { user: { id: String(user.id), username: typeof user.username === "string" ? user.username.slice(0, 64) : "Discord user", globalName: typeof user.global_name === "string" ? user.global_name.slice(0, 64) : null, avatar: typeof user.avatar === "string" && /^[a-zA-Z0-9_]+$/.test(user.avatar) ? user.avatar : null }, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || null, tokenExpiresAt: discordTokenExpiry(tokens), expiresAt: Date.now() + 12 * 60 * 60_000, csrf: randomToken(), guilds: null, guildsAt: 0, discordInflight: 0 }); prune(true); return redirect(res, "/dashboard", { "Set-Cookie": [cookie("duck_session", id, 43_200), cookie("duck_oauth_state", "", 0)] }); }
      if (pathname === "/auth/logout" && method === "POST") { const auth = getSession(req); if (!auth) return json(res, 401, { error: "No active session." }); if (!requireCsrf(req, auth)) return json(res, 403, { error: "Invalid request token." }); sessions.delete(auth.id); return json(res, 200, { ok: true }, method, { "Set-Cookie": cookie("duck_session", "", 0) }); }
      if (pathname === "/api/me" && method === "GET") { const auth = getSession(req); return auth ? json(res, 200, { user: auth.session.user, csrf: auth.session.csrf, isOwner: isDuckOwner(auth.session.user.id) }) : json(res, 401, { error: "Sign in with Discord first." }); }
      if (pathname === "/donate/checkout" && method === "POST") { if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return json(res, 403, { error: "Cross-site checkout requests are not allowed." }); const input = await readJsonBody(req, 1024); if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "amount") || !Number.isInteger(input.amount)) return json(res, 400, { error: "Choose a valid support amount." }); const amount = input.amount; if (stripe && String(process.env.STRIPE_SECRET_KEY || "").trim()) { const checkout = await stripe.checkout.sessions.create(makeDonationCheckoutInput(amount)); const url = safeProviderUrl(checkout?.url, new Set(["checkout.stripe.com"])); if (!url) throw new Error("Stripe did not return a valid checkout URL."); return json(res, 200, { url }); } const url = makeDonationUrl(String(process.env.DUCK_DONATION_CHECKOUT_URL || ""), amount); return url ? json(res, 200, { url }) : json(res, 503, { error: "Development support payments are not configured yet." }); }
      if (pathname === "/api/guilds" && method === "GET") { const auth = getSession(req); if (!auth) return json(res, 401, { error: "Sign in with Discord first." }); const guilds = await discordApi(auth.session, "/users/@me/guilds"); auth.session.guilds = guilds; auth.session.guildsAt = Date.now(); return json(res, 200, { guilds: guilds.map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon || null, owner: Boolean(guild.owner), canManage: hasManageGuildPermission(guild), isAdministrator: hasAdministratorPermission(guild), botPresent: Boolean(client?.guilds?.cache?.has(guild.id)), inviteUrl: makeBotInviteUrl(guild.id, clientId()) })) }); }
      const settingsMatch = pathname.match(/^\/api\/guilds\/(\d{10,})\/settings$/);
      if (settingsMatch && method === "GET") { const access = await guildAccess(req, settingsMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); const stored = getGuildSettings(settingsMatch[1]); const current = withOwnerPlus(stored, access.session.user.id); const plusEnabled = isPlusEnabled(); const billingManager = canManageBilling(access.guild, stored.subscription, access.session.user.id); return json(res, 200, { settings: getPublicGuildSettings(current, process.env.OPENROUTER_MODEL), botProfile: getGuildBotProfile(client, settingsMatch[1]), models: getPublicModelCatalog(), channels: getGuildTextChannels(client, settingsMatch[1], access.member, access.isAdministrator), isAdministrator: access.isAdministrator, isDuckOwner: isDuckOwner(access.session.user.id), plusEnabled, billingConfigured: Boolean(plusEnabled && stripe && isStripeServerConfigured()), canManageSubscription: billingManager && stored.subscription?.provider === "stripe" && Boolean(stored.subscription?.customerId), canCancelSubscription: billingManager && stored.subscription?.provider === "stripe" && Boolean(stored.subscription?.customerId) && Boolean(stored.subscription?.subscriptionId) && !stored.subscription?.cancelAtPeriodEnd }); }
      if (settingsMatch && method === "PUT") { const access = await guildAccess(req, settingsMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); if (!requireCsrf(req, access)) return json(res, 403, { error: "Invalid request token." }); const input = await readJsonBody(req, 256 * 1024); const stored = getGuildSettings(settingsMatch[1]); const current = withOwnerPlus(stored, access.session.user.id); let result; try { result = makeSettingsPatch(current, input, process.env.OPENROUTER_MODEL); } catch (error) { if (error instanceof TypeError) return json(res, error.status || 400, { error: error.message }); throw error; } const channelIds = new Set(getGuildTextChannels(client, settingsMatch[1], access.member, access.isAdministrator).map(({ id }) => id)); for (const key of ["modChannelId", "welcomeChannelId"]) if (result.patch[key] != null && !channelIds.has(result.patch[key])) return json(res, 400, { error: `${key} must be visible to both you and Duck in this server.` }); if (result.patch.entryChannels?.logChannelId != null && !channelIds.has(result.patch.entryChannels.logChannelId)) return json(res, 400, { error: "logChannelId must be visible to both you and Duck in this server." }); for (const item of result.patch.automodChannelSlowmodes || []) if (!channelIds.has(item.channelId)) return json(res, 400, { error: "Every channel rate guard must be visible to both you and Duck in this server." }); for (const item of result.patch.customActions || []) if (item.channelId && !channelIds.has(item.channelId)) return json(res, 400, { error: "Every custom-action channel must be visible to both you and Duck in this server." }); const changesAdminPolicy = ("capabilityMode" in result.patch && result.patch.capabilityMode !== (current.capabilityMode || "ask")) || ("commandPrefix" in result.patch && result.patch.commandPrefix !== (current.commandPrefix || "!")); const changesAutomation = Object.keys(input).some((key) => key.startsWith("automod") || key === "customActions"); if ((changesAdminPolicy || changesAutomation) && !access.isAdministrator) return json(res, 403, { error: "Administrator permission is required to change approval policy, AutoMod, or custom actions." }); if (result.patch.capabilityMode === "agent" && result.patch.capabilityMode !== current.capabilityMode) return json(res, 400, { error: "Agent mode must be enabled through Discord's Administrator confirmation flow." }); const ownerSubscription = current.subscription?.provider === "owner" ? { subscription: { ...current.subscription, updatedAt: new Date().toISOString() } } : {}; updateGuildSettings(settingsMatch[1], { ...ownerSubscription, ...result.patch }); return json(res, 200, { ok: true, settings: result.settings }); }
      const brandingMatch = pathname.match(/^\/api\/guilds\/(\d{10,})\/branding$/);
      if (brandingMatch && method === "PUT") { const access = await guildAccess(req, brandingMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); if (!requireCsrf(req, access)) return json(res, 403, { error: "Invalid request token." }); const stored = getGuildSettings(brandingMatch[1]); if (!hasMaturePlusEntitlement(stored)) return json(res, 402, { error: "Server branding unlocks after three months of an active paid Duck Plus subscription." }); if (!client?.rest?.patch) return json(res, 503, { error: "Duck is not ready to update its server profile." }); const input = await readJsonBody(req, 14 * 1024 * 1024); let patch; try { patch = makeGuildProfilePatch(input); } catch (error) { if (error instanceof TypeError) return json(res, error.status || 400, { error: error.message }); throw error; } await client.rest.patch(Routes.guildMember(brandingMatch[1], "@me"), { body: patch, reason: `Duck dashboard profile update by ${access.session.user.id}` }); return json(res, 200, { ok: true }); }
      const checkoutMatch = pathname.match(/^\/api\/guilds\/(\d{10,})\/billing\/checkout$/);
      if (checkoutMatch && method === "POST") { const access = await guildAccess(req, checkoutMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); if (!requireCsrf(req, access)) return json(res, 403, { error: "Invalid request token." }); if (!isPlusEnabled()) return json(res, 503, { error: "Duck Plus is currently unavailable." }); if (!stripe || !isStripeServerConfigured()) return json(res, 503, { error: "Duck Plus checkout is not configured yet." }); const input = await readJsonBody(req); if (!["month", "year"].includes(input.period)) return json(res, 400, { error: "Choose monthly or annual billing." }); const profile = getGuildSettings(checkoutMatch[1]); const current = profile.subscription || {}; const pendingAt = Date.parse(profile.billingCheckoutPending?.createdAt || ""); if (["active", "trialing"].includes(current.status)) return json(res, 409, { error: "This server already has Duck Plus. Use subscription settings to change or cancel it." }); if (billingCheckoutLocks.has(checkoutMatch[1]) || (Number.isFinite(pendingAt) && pendingAt > Date.now() - 30 * 60_000)) return json(res, 409, { error: "A checkout is already pending for this server." }); billingCheckoutLocks.add(checkoutMatch[1]); try { const checkout = await stripe.checkout.sessions.create(makePlusCheckoutInput({ guildId: checkoutMatch[1], discordUserId: access.session.user.id, period: input.period })); const url = safeProviderUrl(checkout?.url, new Set(["checkout.stripe.com"])); if (!url) throw new Error("Stripe did not return a valid checkout URL."); updateGuildSettings(checkoutMatch[1], { billingCheckoutPending: { createdAt: new Date().toISOString(), requestedBy: access.session.user.id, checkoutSessionId: /^cs_[a-zA-Z0-9_]+$/.test(checkout.id || "") ? checkout.id : null } }); return json(res, 200, { url }); } finally { billingCheckoutLocks.delete(checkoutMatch[1]); } }
      const portalMatch = pathname.match(/^\/api\/guilds\/(\d{10,})\/billing\/portal$/);
      if (portalMatch && method === "POST") { const access = await guildAccess(req, portalMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); if (!requireCsrf(req, access)) return json(res, 403, { error: "Invalid request token." }); const subscription = getGuildSettings(portalMatch[1]).subscription || {}; if (!canManageBilling(access.guild, subscription, access.session.user.id)) return json(res, 403, { error: "Only the subscriber or server owner can manage billing." }); if (!stripe || subscription.provider !== "stripe" || !subscription.customerId) return json(res, 409, { error: "No Stripe subscription is linked to this server." }); const portal = await stripe.billingPortal.sessions.create({ customer: subscription.customerId, return_url: `${getPublicBaseUrl()}/dashboard` }); const url = safeProviderUrl(portal?.url, new Set(["billing.stripe.com"])); if (!url) throw new Error("Stripe did not return a valid billing URL."); return json(res, 200, { url }); }
      const cancelMatch = pathname.match(/^\/api\/guilds\/(\d{10,})\/billing\/cancel$/);
      if (cancelMatch && method === "POST") { const access = await guildAccess(req, cancelMatch[1], true); if (access.error) return json(res, access.status, { error: access.error }); if (!requireCsrf(req, access)) return json(res, 403, { error: "Invalid request token." }); const subscription = getGuildSettings(cancelMatch[1]).subscription || {}; if (!canManageBilling(access.guild, subscription, access.session.user.id)) return json(res, 403, { error: "Only the subscriber or server owner can cancel billing." }); if (!stripe || subscription.provider !== "stripe" || !subscription.customerId || !subscription.subscriptionId) return json(res, 409, { error: "No Stripe subscription is linked to this server." }); if (subscription.cancelAtPeriodEnd) return json(res, 409, { error: "This subscription is already scheduled to cancel." }); const returnUrl = `${getPublicBaseUrl()}/dashboard?billing=canceled&guild=${encodeURIComponent(cancelMatch[1])}`; const portal = await stripe.billingPortal.sessions.create({ customer: subscription.customerId, return_url: `${getPublicBaseUrl()}/dashboard`, flow_data: { type: "subscription_cancel", subscription_cancel: { subscription: subscription.subscriptionId }, after_completion: { type: "redirect", redirect: { return_url: returnUrl } } } }); const url = safeProviderUrl(portal?.url, new Set(["billing.stripe.com"])); if (!url) throw new Error("Stripe did not return a valid cancellation URL."); return json(res, 200, { url }); }
      if (pathname === "/api/billing/webhook" && method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, { error: "Content-Type must be application/json." });
        const signature = String(req.headers["stripe-signature"] || ""); const raw = await readBody(req, 256 * 1024);
        if (!signature || !raw.length) return json(res, 400, { error: "Missing signature or body." });
        if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return json(res, 503, { error: "Stripe webhooks are not configured." });
        let event; try { event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET); } catch { return json(res, 400, { error: "Invalid Stripe webhook signature." }); }
        try {
          let billing = makeStripeSubscriptionPatch(event); if (!billing) return json(res, 200, { ok: true, ignored: true });
          if (stripe.subscriptions?.retrieve && billing.subscription.subscriptionId) { const canonical = await stripe.subscriptions.retrieve(billing.subscription.subscriptionId); billing = makeStripeSubscriptionPatch({ ...event, data: { object: canonical } }); if (!billing) throw new Error("Canonical Stripe subscription was invalid."); }
          const profile = getGuildSettings(billing.guildId); const current = profile.subscription || {}; const pending = profile.billingCheckoutPending; const pendingAt = Date.parse(pending?.createdAt || ""); const pendingMatches = Number.isFinite(pendingAt) && pendingAt > Date.now() - 30 * 60_000 && pending.requestedBy === billing.subscription.purchaserId;
          const occurredAtMs = Date.parse(billing.occurredAt || ""); const currentOccurredAtMs = Date.parse(current.eventCreatedAt || "");
          if (current.eventId === billing.eventId || webhookEvents.has(billing.eventId)) return json(res, 200, { ok: true, duplicate: true });
          if (!Number.isFinite(occurredAtMs)) throw new Error("Stripe event has no valid creation time.");
          if (Number.isFinite(currentOccurredAtMs) && occurredAtMs < currentOccurredAtMs) return json(res, 200, { ok: true, stale: true });
          if (current.subscriptionId && current.subscriptionId !== billing.subscription.subscriptionId && (["active", "trialing"].includes(current.status) || !pendingMatches)) return json(res, 200, { ok: true, conflict: true });
          if (!current.subscriptionId && pending && !pendingMatches) return json(res, 200, { ok: true, conflict: true });
          webhookEvents.set(billing.eventId, Date.now() + 3 * 24 * 60 * 60_000); prune(true);
          updateGuildSettings(billing.guildId, { subscription: billing.subscription, billingCheckoutPending: null });
          return json(res, 200, { ok: true });
        } catch { return json(res, 500, { error: "Stripe webhook processing failed." }); }
      }
      if (pathname === "/dashboard/") return redirect(res, "/dashboard");
      const dashboardGuildPage = /^\/dashboard\/servers\/\d{10,}\/?$/.test(pathname);
      const page = pages.get(pathname); if ((page || dashboardGuildPage) && ["GET", "HEAD"].includes(method)) return sendAsset(req, res, page || pages.get("/dashboard"), method);
      if (pathname === "/donate/checkout") return json(res, 405, { error: "Method not allowed." }, method, { Allow: "POST" });
      if (page || dashboardGuildPage || pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return json(res, 405, { error: "Method not allowed." }, method, { Allow: "GET, HEAD" });
      return send(res, 404, "text/plain; charset=utf-8", "Duck wandered off. Page not found.", method);
    } catch (error) { const status = error.code === "plus_required" ? 402 : error instanceof SyntaxError ? 400 : error.status || 500; return json(res, status, { error: status === 500 ? "Duck hit an unexpected server error." : error.message }); }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 512;
  server.maxHeadersCount = 100;
  return server;
}

export { assetCache, createDuckWebsiteServer, hasAdministratorPermission, hasManageGuildPermission, isDuckOwner, makeBotInviteUrl, makeDonationUrl, securityHeaders, setBoundedMapEntry };
