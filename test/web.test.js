import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDuckWebsiteServer, hasAdministratorPermission, hasManageGuildPermission, isDuckOwner, makeBotInviteUrl, makeDonationUrl } from "../src/web.js";
import { isPlusEnabled, isStripeServerConfigured, makePlusCheckoutInput } from "../src/stripe.js";

async function withWebsite(run, options = {}) {
  const server = createDuckWebsiteServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("website serves the homepage, privacy policy, assets, and health route", async () => {
  await withWebsite(async (origin) => {
    const homepage = await fetch(`${origin}/`);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Add Duck to Discord/);
    assert.match(homepage.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(homepage.headers.get("etag"), /^".+"$/);

    const unchanged = await fetch(`${origin}/`, { headers: { "If-None-Match": homepage.headers.get("etag") } });
    assert.equal(unchanged.status, 304);

    const privacy = await fetch(`${origin}/privacy-policy`);
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Third-party AI providers/);

    const guide = await fetch(`${origin}/guide`);
    assert.equal(guide.status, 200);
    const guideText = await guide.text();
    assert.match(guideText, /Set up your pond/);
    assert.match(guideText, /Commands and tools/);
    assert.doesNotMatch(guideText, /Configure the environment|Choose an AI provider|Configure voice and TTS|Troubleshooting/);
    assert.equal((await fetch(`${origin}/guide.html`)).status, 200);
    assert.equal((await fetch(`${origin}/privacy-policy.html`)).status, 200);

    const css = await fetch(`${origin}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/);
    assert.equal(css.headers.get("cache-control"), "no-cache");

    const script = await fetch(`${origin}/site.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);

    const dashboard = await fetch(`${origin}/dashboard`);
    assert.equal(dashboard.status, 200);
    const dashboardText = await dashboard.text();
    assert.match(dashboardText, /Continue with Discord/);
    assert.match(dashboardText, /Plan and billing/);
    assert.match(dashboardText, /Cancel subscription/);
    assert.match(dashboardText, /Welcome message/);
    assert.match(dashboardText, /Context range/);
    assert.doesNotMatch(dashboardText, /Activate owner Plus/);
    assert.match(dashboardText, /styles\.css\?v=20260821/);
    assert.match(dashboardText, /data-back/);
    assert.match(dashboardText, /Back to servers/);
    assert.match(dashboardText, /Controlled chaos/);
    assert.match(dashboardText, /funRoastEnabled/);
    assert.match(dashboardText, /Server identity/);
    assert.match(dashboardText, /data-route-progress/);
    const serverDashboard = await fetch(`${origin}/dashboard/servers/123456789012345678`);
    assert.equal(serverDashboard.status, 200);
    assert.match(await serverDashboard.text(), /Server control panel/);
    assert.equal((await fetch(`${origin}/favicon.svg`)).status, 200);
    assert.match(await (await fetch(`${origin}/pricing`)).text(), /Annual saves \$8\.89/);
    assert.match(await (await fetch(`${origin}/donate`)).text(), /seriously thankful/i);
    assert.match(await (await fetch(`${origin}/refunds`)).text(), /did not receive the subscription/);
    assert.match(await (await fetch(`${origin}/terms-of-service`)).text(), /Terms of service/);
    assert.equal((await fetch(`${origin}/billing.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/me`)).status, 401);
    assert.deepEqual(await (await fetch(`${origin}/api/stats`)).json(), { servers: 0 });

    const health = await fetch(`${origin}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: "duck" });
  });
});

test("website rejects unsupported methods and unknown routes", async () => {
  await withWebsite(async (origin) => {
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal((await fetch(`${origin}/`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/dashboard/servers/123456789012345678`, { method: "POST" })).status, 405);
  });
});

test("public pages contain no GitHub references", async () => {
  const pages = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/privacy-policy.html", import.meta.url), "utf8"),
    readFile(new URL("../public/guide.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/site.js", import.meta.url), "utf8"),
    readFile(new URL("../public/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../public/dashboard.js", import.meta.url), "utf8"),
    readFile(new URL("../public/pricing.html", import.meta.url), "utf8"),
    readFile(new URL("../public/donate.html", import.meta.url), "utf8"),
    readFile(new URL("../public/refunds.html", import.meta.url), "utf8"),
    readFile(new URL("../public/terms-of-service.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(pages.join("\n"), /github/i);
  assert.doesNotMatch(pages.slice(0, 3).join("\n"), /(?:href|src)="\/(?:styles\.css|site\.js)"/);
});

test("Discord sessions cannot read or change another account's server profile", async () => {
  const environmentKeys = ["CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_OAUTH_REDIRECT_URI", "DUCK_SESSION_SECURE", "DUCK_PLUS_ENABLED"];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const alphaUser = "1138897388694687834"; const betaUser = "900000000000000002"; const alphaGuild = "800000000000000001"; const betaGuild = "800000000000000002";
  Object.assign(process.env, { CLIENT_ID: "1507850959642955816", DISCORD_CLIENT_SECRET: "test-client-secret", DISCORD_OAUTH_REDIRECT_URI: "http://127.0.0.1/auth/discord/callback", DUCK_SESSION_SECURE: "false", DUCK_PLUS_ENABLED: "false" });
  const profiles = new Map([[alphaGuild, { welcomeMessage: "Alpha private profile" }], [betaGuild, { welcomeMessage: "Beta private profile" }]]);
  const fetchImpl = async (url, options = {}) => {
    const authorization = String(options.headers?.Authorization || "");
    if (String(url).endsWith("/oauth2/token")) { const code = options.body.get("code"); return Response.json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600 }); }
    if (String(url).endsWith("/users/@me/guilds")) { const alpha = authorization.endsWith("access-alpha"); return Response.json([{ id: alpha ? alphaGuild : betaGuild, name: alpha ? "Alpha Pond" : "Beta Pond", permissions: "32", owner: false }]); }
    if (String(url).endsWith("/users/@me")) { const alpha = authorization.endsWith("access-alpha"); return Response.json({ id: alpha ? alphaUser : betaUser, username: alpha ? "alpha" : "beta", avatar: null }); }
    return new Response("not found", { status: 404 });
  };
  const signIn = async (origin, code) => {
    const begin = await fetch(`${origin}/auth/discord`, { redirect: "manual" }); const oauthUrl = new URL(begin.headers.get("location")); const stateCookie = begin.headers.get("set-cookie").match(/duck_oauth_state=([^;]+)/)[1];
    const callback = await fetch(`${origin}/auth/discord/callback?code=${code}&state=${encodeURIComponent(oauthUrl.searchParams.get("state"))}`, { redirect: "manual", headers: { Cookie: `duck_oauth_state=${stateCookie}` } });
    return `duck_session=${callback.headers.get("set-cookie").match(/duck_session=([^;,]+)/)[1]}`;
  };
  try {
    await withWebsite(async (origin) => {
      const alphaCookie = await signIn(origin, "alpha"); const betaCookie = await signIn(origin, "beta");
      const alphaMe = await (await fetch(`${origin}/api/me`, { headers: { Cookie: alphaCookie } })).json(); const betaMe = await (await fetch(`${origin}/api/me`, { headers: { Cookie: betaCookie } })).json();
      const alphaOwn = await fetch(`${origin}/api/guilds/${alphaGuild}/settings`, { headers: { Cookie: alphaCookie } }); assert.equal(alphaOwn.status, 200); const alphaSettings = await alphaOwn.json(); assert.equal(alphaSettings.settings.welcomeMessage, "Alpha private profile"); assert.equal(alphaSettings.settings.subscription.source, "owner");
      assert.equal((await fetch(`${origin}/api/guilds/${betaGuild}/settings`, { headers: { Cookie: alphaCookie } })).status, 403);
      assert.equal((await fetch(`${origin}/api/guilds/${alphaGuild}/settings`, { headers: { Cookie: betaCookie } })).status, 403);
      const crossWrite = await fetch(`${origin}/api/guilds/${alphaGuild}/settings`, { method: "PUT", headers: { Cookie: betaCookie, "Content-Type": "application/json", "X-Duck-CSRF": betaMe.csrf }, body: JSON.stringify({ welcomeMessage: "stolen" }) }); assert.equal(crossWrite.status, 403); assert.equal(profiles.get(alphaGuild).welcomeMessage, "Alpha private profile");
      const freeFunUpgrade = await fetch(`${origin}/api/guilds/${betaGuild}/settings`, { method: "PUT", headers: { Cookie: betaCookie, "Content-Type": "application/json", "X-Duck-CSRF": betaMe.csrf }, body: JSON.stringify({ funRoastEnabled: true }) }); assert.equal(freeFunUpgrade.status, 402);
      const ownerSave = await fetch(`${origin}/api/guilds/${alphaGuild}/settings`, { method: "PUT", headers: { Cookie: alphaCookie, "Content-Type": "application/json", "X-Duck-CSRF": alphaMe.csrf }, body: JSON.stringify({ aiPersonality: "A dry-witted pond guardian", funRoastEnabled: true }) }); assert.equal(ownerSave.status, 200); assert.equal(profiles.get(alphaGuild).subscription.provider, "owner"); assert.equal(profiles.get(alphaGuild).aiPersonality, "A dry-witted pond guardian"); assert.equal(profiles.get(alphaGuild).funRoastEnabled, true);
    }, { fetchImpl, client: { guilds: { cache: new Map([[alphaGuild, {}], [betaGuild, {}]]) }, application: { owner: null } }, getGuildSettings: (id) => profiles.get(id) || {}, updateGuildSettings: (id, patch) => profiles.set(id, { ...(profiles.get(id) || {}), ...patch }) });
  } finally {
    for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
  }
});

test("Duck Plus defaults off and fails closed", async () => {
  const previous = process.env.DUCK_PLUS_ENABLED;
  delete process.env.DUCK_PLUS_ENABLED;
  try {
    assert.equal(isPlusEnabled(), false);
    assert.equal(isStripeServerConfigured(), false);
    assert.throws(() => makePlusCheckoutInput({ guildId: "123456789012345678", discordUserId: "999999999999999999", period: "month" }), /currently unavailable/);
    await withWebsite(async (origin) => {
      assert.deepEqual(await (await fetch(`${origin}/api/site-config`)).json(), { plusEnabled: false });
    });
  } finally {
    if (previous == null) delete process.env.DUCK_PLUS_ENABLED;
    else process.env.DUCK_PLUS_ENABLED = previous;
  }
});

test("dashboard security helpers enforce Discord permissions and safe donation links", () => {
  assert.equal(isDuckOwner("1138897388694687834"), true);
  assert.equal(isDuckOwner("1138897388694687835"), false);
  assert.equal(hasManageGuildPermission({ permissions: "32" }), true);
  assert.equal(hasAdministratorPermission({ permissions: "32" }), false);
  assert.equal(hasAdministratorPermission({ permissions: "8" }), true);
  assert.equal(hasManageGuildPermission({ permissions: "invalid" }), false);
  const invite = new URL(makeBotInviteUrl("123456789012345678", "1507850959642955816"));
  assert.equal(invite.searchParams.get("guild_id"), "123456789012345678");
  assert.equal(invite.searchParams.get("disable_guild_select"), "true");
  assert.equal(makeDonationUrl("https://example.com/support?amount={amount}", 20), "https://example.com/support?amount=20");
  assert.equal(makeDonationUrl("http://example.com/{amount}", 20), null);
  assert.equal(makeDonationUrl("https://example.com/{amount}", 3), null);
});

test("Discord OAuth session can list and update only a present manageable guild", async () => {
  const environmentKeys = ["CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_OAUTH_REDIRECT_URI", "DUCK_SESSION_SECURE", "DUCK_PUBLIC_URL", "DUCK_PLUS_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PLUS_MONTHLY_PRICE_ID", "STRIPE_PLUS_YEARLY_PRICE_ID"];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { CLIENT_ID: "1507850959642955816", DISCORD_CLIENT_SECRET: "test-client-secret", DISCORD_OAUTH_REDIRECT_URI: "http://127.0.0.1/auth/discord/callback", DUCK_SESSION_SECURE: "false", DUCK_PUBLIC_URL: "https://duck.wispbyte.app", DUCK_PLUS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PLUS_MONTHLY_PRICE_ID: "price_monthly", STRIPE_PLUS_YEARLY_PRICE_ID: "price_yearly" });
  const guildId = "123456789012345678";
  const stored = new Map();
  const checkoutInputs = [];
  const portalInputs = [];
  const profileUpdates = [];
  const stripeClient = {
    checkout: { sessions: { async create(input) { checkoutInputs.push(input); return { url: "https://checkout.stripe.com/c/pay_test" }; } } },
    billingPortal: { sessions: { async create(input) { portalInputs.push(input); return { url: "https://billing.stripe.com/p/session/test" }; } } },
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    if (String(url).endsWith("/users/@me/guilds")) return Response.json([{ id: guildId, name: "Test Pond", icon: null, permissions: "32", owner: false }]);
    if (String(url).endsWith("/users/@me")) return Response.json({ id: "999999999999999999", username: "duck-user", global_name: "Duck User", avatar: null });
    return new Response("not found", { status: 404 });
  };
  try {
    await withWebsite(async (origin) => {
      const begin = await fetch(`${origin}/auth/discord`, { redirect: "manual" });
      assert.equal(begin.status, 302);
      const oauthUrl = new URL(begin.headers.get("location"));
      assert.equal(oauthUrl.searchParams.get("scope"), "identify guilds");
      const stateCookie = begin.headers.get("set-cookie").match(/duck_oauth_state=([^;]+)/)[1];
      const callback = await fetch(`${origin}/auth/discord/callback?code=test-code&state=${encodeURIComponent(oauthUrl.searchParams.get("state"))}`, { redirect: "manual", headers: { Cookie: `duck_oauth_state=${stateCookie}` } });
      assert.equal(callback.status, 302);
      const sessionCookie = callback.headers.get("set-cookie").match(/duck_session=([^;,]+)/)[1];
      const cookie = `duck_session=${sessionCookie}`;
      const meResponse = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } });
      const me = await meResponse.json();
      assert.equal(me.user.username, "duck-user");
      const guilds = await (await fetch(`${origin}/api/guilds`, { headers: { Cookie: cookie } })).json();
      assert.equal(guilds.guilds[0].botPresent, true);
      assert.equal(guilds.guilds[0].canManage, true);
      assert.equal(guilds.guilds[0].isAdministrator, false);
      const update = await fetch(`${origin}/api/guilds/${guildId}/settings`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ aiChatEnabled: false, aiModel: "google/gemma-4-31b-it:free" }) });
      assert.equal(update.status, 200);
      assert.equal(stored.get(guildId).aiChatEnabled, false);
      const invalidSetting = await fetch(`${origin}/api/guilds/${guildId}/settings`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ imaginaryLimit: 999 }) });
      assert.equal(invalidSetting.status, 400);
      const forbidden = await fetch(`${origin}/api/guilds/${guildId}/settings`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ capabilityMode: "approve" }) });
      assert.equal(forbidden.status, 403);
      const forbiddenAutomod = await fetch(`${origin}/api/guilds/${guildId}/settings`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ automodEnabled: true }) });
      assert.equal(forbiddenAutomod.status, 403);
      const earlyBranding = await fetch(`${origin}/api/guilds/${guildId}/branding`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ nickname: "Pond Duck" }) });
      assert.equal(earlyBranding.status, 402);
      const checkout = await fetch(`${origin}/api/guilds/${guildId}/billing/checkout`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ period: "month" }) });
      assert.equal(checkout.status, 200);
      assert.equal(checkoutInputs[0].subscription_data.metadata.duck_guild_id, guildId);
      stored.set(guildId, { ...stored.get(guildId), subscription: { provider: "stripe", tier: "plus", status: "active", startedAt: "2025-01-01T00:00:00.000Z", customerId: "cus_test", subscriptionId: "sub_test", expiresAt: "2027-01-01T00:00:00.000Z", cancelAtPeriodEnd: false } });
      const settings = await (await fetch(`${origin}/api/guilds/${guildId}/settings`, { headers: { Cookie: cookie } })).json();
      assert.equal(settings.canManageSubscription, true);
      assert.equal(settings.canCancelSubscription, true);
      assert.equal(settings.settings.subscription.brandingEligible, true);
      const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
      const branding = await fetch(`${origin}/api/guilds/${guildId}/branding`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ nickname: "Pond Duck", bio: "Quacking locally.", avatar: png }) });
      assert.equal(branding.status, 200);
      assert.match(profileUpdates[0].route, new RegExp(`/guilds/${guildId}/members/%40me$`));
      assert.equal(profileUpdates[0].options.body.nick, "Pond Duck");
      const disguised = await fetch(`${origin}/api/guilds/${guildId}/branding`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duck-CSRF": me.csrf }, body: JSON.stringify({ avatar: "data:image/png;base64,QUJDRA==" }) });
      assert.equal(disguised.status, 400);
      const cancel = await fetch(`${origin}/api/guilds/${guildId}/billing/cancel`, { method: "POST", headers: { Cookie: cookie, "X-Duck-CSRF": me.csrf } });
      assert.equal(cancel.status, 200);
      assert.equal(portalInputs[0].flow_data.type, "subscription_cancel");
      assert.equal(portalInputs[0].flow_data.subscription_cancel.subscription, "sub_test");
    }, { fetchImpl, stripeClient, client: { rest: { async patch(route, options) { profileUpdates.push({ route, options }); return {}; } }, guilds: { cache: new Map([[guildId, {}]]) } }, getGuildSettings: (id) => stored.get(id) || {}, updateGuildSettings: (id, patch) => stored.set(id, { ...(stored.get(id) || {}), ...patch }) });
  } finally {
    for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
  }
});

test("Stripe webhook verifies through the SDK and rejects stale delivery order", async () => {
  const previous = Object.fromEntries(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PLUS_MONTHLY_PRICE_ID", "STRIPE_PLUS_YEARLY_PRICE_ID"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PLUS_MONTHLY_PRICE_ID: "price_monthly", STRIPE_PLUS_YEARLY_PRICE_ID: "price_yearly" });
  const guildId = "123456789012345678";
  const stored = new Map();
  const stripeClient = { webhooks: { constructEvent(raw, signature, secret) { if (secret !== "whsec_test" || signature !== "valid") throw new Error("bad signature"); return JSON.parse(raw.toString("utf8")); } } };
  const postEvent = async (origin, event) => {
    const body = JSON.stringify(event);
    return fetch(`${origin}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "valid" }, body });
  };
  try {
    await withWebsite(async (origin) => {
      const created = Math.floor(Date.now() / 1000);
      const foreign = { id: "evt_foreign", type: "customer.subscription.created", created, data: { object: { id: "sub_foreign", status: "active", customer: "cus_foreign", metadata: { duck_guild_id: guildId }, cancel_at_period_end: false, items: { data: [{ current_period_end: 1_789_257_600, price: { id: "price_not_duck_plus" } }] } } } };
      assert.deepEqual(await (await postEvent(origin, foreign)).json(), { ok: true, ignored: true });
      assert.equal(stored.has(guildId), false);
      const newer = { id: "evt_newer", type: "customer.subscription.created", created, data: { object: { id: "sub_new", created: created - 100, status: "active", customer: "cus_test", metadata: { duck_guild_id: guildId }, cancel_at_period_end: false, items: { data: [{ current_period_end: 1_789_257_600, price: { id: "price_monthly" } }] } } } };
      assert.equal((await postEvent(origin, newer)).status, 200);
      assert.equal(stored.get(guildId).subscription.tier, "plus");
      assert.equal(stored.get(guildId).subscription.expiresAt, "2026-09-13T00:00:00.000Z");
      assert.equal(stored.get(guildId).subscription.startedAt, new Date((created - 100) * 1000).toISOString());
      const older = { id: "evt_older", type: "customer.subscription.deleted", created: created - 10, data: { object: { id: "sub_new", status: "canceled", customer: "cus_test", metadata: { duck_guild_id: guildId }, cancel_at_period_end: false, items: { data: [{ current_period_end: 1_789_257_600, price: { id: "price_monthly" } }] } } } };
      assert.deepEqual(await (await postEvent(origin, older)).json(), { ok: true, stale: true });
      assert.equal(stored.get(guildId).subscription.tier, "plus");
      const forged = await fetch(`${origin}/api/billing/webhook`, { method: "POST", headers: { "Stripe-Signature": "forged" }, body: JSON.stringify(newer) });
      assert.equal(forged.status, 400);
    }, { stripeClient, getGuildSettings: (id) => stored.get(id) || {}, updateGuildSettings: (id, patch) => stored.set(id, { ...(stored.get(id) || {}), ...patch }) });
  } finally {
    for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
  }
});
