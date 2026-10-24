import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { PermissionsBitField } from "discord.js";
import { createDuckWebsiteServer } from "../src/web.js";

test("preset approvals and trials require live admin, CSRF, server scope, and a single-use token", async () => {
  const envKeys = ["CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_OAUTH_REDIRECT_URI", "DUCK_SESSION_SECURE", "DUCK_PUBLIC_URL"];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLIENT_ID: "1507850959642955816", DISCORD_CLIENT_SECRET: "fixture-client-secret", DISCORD_OAUTH_REDIRECT_URI: "http://127.0.0.1/auth/discord/callback", DUCK_SESSION_SECURE: "false" }); delete process.env.DUCK_PUBLIC_URL;
  const guildId = "123456789012345678", userId = "223456789012345678"; let currentAdmin = true; let stored = {}; let changes = 0;
  const guild = { id: guildId, name: "Fixture" };
  const member = { id: userId, guild, permissions: { has: () => currentAdmin } };
  const bot = { id: "323456789012345678", permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator), roles: { highest: { position: 10 } } };
  const channels = new Map();
  guild.channels = { cache: channels, fetch: async () => channels, create: async () => { changes++; throw new Error("This test never approves channel creation"); } };
  guild.members = { cache: new Map([[userId, member]]), fetch: async () => member, fetchMe: async () => bot }; guild.roles = { cache: new Map(), fetch: async () => new Map() };
  const fetchImpl = async url => {
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (String(url).endsWith("/users/@me/guilds")) return Response.json([{ id: guildId, name: "Fixture", permissions: "8", owner: false }]);
    if (String(url).endsWith("/users/@me")) return Response.json({ id: userId, username: "fixture-user" });
    return new Response("missing", { status: 404 });
  };
  const server = createDuckWebsiteServer({ fetchImpl, client: { guilds: { cache: new Map([[guildId, guild]]) }, application: { owner: null } }, getGuildSettings: () => stored, updateGuildSettings: (_, patch) => { stored = structuredClone({ ...stored, ...patch }); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const begin = await fetch(`${origin}/auth/discord`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")).searchParams.get("state");
    const stateCookie = begin.headers.get("set-cookie").match(/duck_oauth_state=([^;]+)/)[1];
    const callback = await fetch(`${origin}/auth/discord/callback?code=fixture&state=${state}`, { redirect: "manual", headers: { Cookie: `duck_oauth_state=${stateCookie}` } });
    const cookie = `duck_session=${callback.headers.get("set-cookie").match(/duck_session=([^;,]+)/)[1]}`;
    const me = await (await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf };
    const post = (path, body, customHeaders = headers) => fetch(`${origin}/api/guilds/${guildId}/${path}`, { method: "POST", headers: customHeaders, body: JSON.stringify(body) });
    const input = { tool: "save_server_preset", preset: { id: "event", name: "Event", operations: [{ kind: "create_text", name: "event-chat" }] } };
    assert.equal((await post("presets/preview", input, { "Content-Type": "application/json" })).status, 401);
    assert.equal((await post("presets/preview", input, { Cookie: cookie, "Content-Type": "application/json" })).status, 403);
    const response = await post("presets/preview", input); assert.equal(response.status, 200);
    const { token, preview } = await response.json(); assert.match(preview, /create text/); assert.equal(changes, 0); assert.equal(stored.serverPresets, undefined);
    currentAdmin = false;
    assert.equal((await post("presets/approve", { token })).status, 403);
    assert.equal((await post("trial", {})).status, 403);
    currentAdmin = true;
    const applied = await post("presets/approve", { token }); assert.equal(applied.status, 200); assert.equal(stored.serverPresets.length, 1); assert.equal(changes, 0);
    assert.equal((await post("presets/approve", { token })).status, 403);
    assert.equal((await post("presets/preview", { tool: "update_server_settings", settings: { automodEnabled: false } })).status, 400);
    const foreign = await fetch(`${origin}/api/guilds/999999999999999999/presets/approve`, { method: "POST", headers, body: JSON.stringify({ token }) }); assert.equal(foreign.status, 403);
    assert.equal((await post("trial", {}, { Cookie: cookie })).status, 403);
    assert.equal((await post("trial", {})).status, 200); assert.equal(stored.subscription.provider, "trial");
    assert.equal((await post("trial", {})).status, 409);
    const used = stored.plusTrialUsedAt; stored = { plusTrialUsedAt: used, subscription: { tier: "free", status: "inactive" } };
    assert.equal((await post("trial", {})).status, 409);
  } finally {
    server.close(); await once(server, "close");
    for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  }
});
