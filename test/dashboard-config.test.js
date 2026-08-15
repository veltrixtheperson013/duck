import assert from "node:assert/strict";
import test from "node:test";
import { getBrandingEligibleAt, getFunCommandAccess, getPlusLoyalty, getPublicGuildSettings, getPublicModelCatalog, hasMaturePlusEntitlement, hasPlusEntitlement, makeSettingsPatch } from "../src/dashboard-config.js";

test("dashboard settings allowlist fields and gate Plus models per guild", () => {
  const free = makeSettingsPatch({}, { aiChatEnabled: false, aiModel: "google/gemma-4-31b-it:free" });
  assert.equal(free.settings.aiChatEnabled, false);
  assert.equal(free.settings.aiModel, "google/gemma-4-31b-it:free");
  assert.throws(() => makeSettingsPatch({}, { aiModel: "tencent/hy3" }), /requires Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { subscription: { tier: "plus" } }), /Unknown setting/);

  const plusSettings = { subscription: { tier: "plus", status: "active", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  assert.equal(hasPlusEntitlement(plusSettings), true);
  assert.equal(makeSettingsPatch(plusSettings, { aiModel: "tencent/hy3" }).settings.aiModel, "tencent/hy3");
});

test("expired Plus selections fall back to a free model", () => {
  const settings = getPublicGuildSettings({ aiModel: "tencent/hy3", subscription: { tier: "plus", status: "active", expiresAt: "2000-01-01T00:00:00.000Z" } });
  assert.equal(settings.subscription.tier, "free");
  assert.equal(settings.aiModel, "cohere/north-mini-code:free");
  assert.equal(getPublicModelCatalog().tts.find(({ id }) => id === "deepgram/flux-tts:free").label, "Deepgram Flux TTS");
});

test("settings without subscription data normalize to the Free plan", () => {
  const settings = getPublicGuildSettings({ aiChatEnabled: true });
  assert.deepEqual(settings.subscription, {
    tier: "free",
    status: "inactive",
    source: null,
    expiresAt: null,
    cancelAtPeriodEnd: false,
    brandingEligible: false,
    brandingEligibleAt: null,
  });
});

test("server branding requires three calendar months of paid Plus", () => {
  const now = Date.parse("2026-05-01T12:00:00.000Z");
  const paid = { subscription: { provider: "stripe", tier: "plus", status: "active", startedAt: "2026-01-31T12:00:00.000Z" } };
  assert.equal(getBrandingEligibleAt(paid), "2026-04-30T12:00:00.000Z");
  assert.equal(hasMaturePlusEntitlement(paid, now), true);
  assert.equal(hasMaturePlusEntitlement({ subscription: { ...paid.subscription, startedAt: "2026-03-01T00:00:00.000Z" } }, now), false);
  assert.equal(hasMaturePlusEntitlement({ subscription: { provider: "owner", tier: "plus", status: "active", startedAt: "2020-01-01T00:00:00.000Z" } }, now), false);
});

test("fun commands keep a Free set and enforce Plus toggles", () => {
  const free = getPublicGuildSettings({});
  assert.equal(free.funQuackEnabled, true);
  assert.equal(free.funDuckFactEnabled, true);
  assert.equal(free.funCoinflipEnabled, true);
  assert.equal(free.funRoastEnabled, false);
  assert.equal(getFunCommandAccess(free, "quack").allowed, true);
  assert.equal(getFunCommandAccess(free, "roast").reason, "plus_required");
  assert.throws(() => makeSettingsPatch({}, { funRoastEnabled: true }), /requires Duck Plus/);

  const plus = { subscription: { tier: "plus", status: "active" } };
  const enabled = makeSettingsPatch(plus, { funRoastEnabled: true, funWouldYouRatherEnabled: true });
  assert.equal(enabled.settings.funRoastEnabled, true);
  assert.equal(getFunCommandAccess({ ...plus, ...enabled.patch }, "roast").allowed, true);
  assert.equal(getFunCommandAccess({ ...plus, funCommandsEnabled: false, funRoastEnabled: true }, "roast").reason, "disabled");
});

test("ElevenLabs TTS is Plus-only and Deepgram is the Free default", () => {
  assert.equal(getPublicGuildSettings({}).ttsModel, "deepgram/flux-tts:free");
  assert.equal(getPublicGuildSettings({ ttsModel: "elevenlabs/default" }).ttsModel, "deepgram/flux-tts:free");
  assert.throws(() => makeSettingsPatch({}, { ttsModel: "elevenlabs/default" }), /requires Duck Plus/);
  const plus = { subscription: { tier: "plus", status: "active" } };
  assert.equal(makeSettingsPatch(plus, { ttsModel: "elevenlabs/default" }).settings.ttsModel, "elevenlabs/default");
  assert.equal(getPublicModelCatalog().tts.find(({ id }) => id === "elevenlabs/default").tier, "plus");
});

test("dashboard exposes and validates advanced per-server controls", () => {
  const input = {
    aiVisionEnabled: false,
    aiContextMode: "focused",
    aiResponseStyle: "concise",
    aiChannelMode: "mentions",
    ttsAnnounceNames: false,
    modChannelId: "123456789012345678",
    welcomeChannelId: "223456789012345678",
    welcomeMessage: "Welcome {user} to {server}!",
    farewellMessage: "See you later, {username}.",
    logChannelId: "323456789012345678",
  };
  const { patch, settings } = makeSettingsPatch({}, input);
  assert.equal(settings.aiContextMode, "focused");
  assert.equal(settings.aiChannelMode, "mentions");
  assert.equal(settings.ttsAnnounceNames, false);
  assert.equal(settings.logChannelId, input.logChannelId);
  assert.equal(patch.entryChannels.logChannelId, input.logChannelId);
  assert.throws(() => makeSettingsPatch({}, { aiResponseStyle: "detailed" }), /require Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { aiPersonality: "Chaotic pond comedian" }), /requires Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { ttsMessageLength: 400 }), /Unknown setting/);
  assert.throws(() => makeSettingsPatch({}, { welcomeMessage: "" }), /1-180 characters/);
});

test("Plus profiles can set a bounded custom AI personality", () => {
  const current = { subscription: { tier: "plus", status: "active" } };
  const result = makeSettingsPatch(current, { aiPersonality: "Friendly, playful, and fond of terrible pond jokes." });
  assert.equal(result.settings.aiPersonality, "Friendly, playful, and fond of terrible pond jokes.");
  assert.throws(() => makeSettingsPatch(current, { aiPersonality: "x".repeat(241) }), /240 characters or fewer/);
});

test("AutoMod settings are bounded and server custom words require Plus", () => {
  const plus = { subscription: { provider: "stripe", tier: "plus", status: "active" } };
  const basic = makeSettingsPatch({}, {
    automodEnabled: true,
    automodSwearFilter: true,
    automodNsfwFilter: true,
    automodGlobalSlowmodeSeconds: 12,
    automodChannelSlowmodes: [{ channelId: "123456789012345678", seconds: 30 }],
    automodViolationsBeforeWarn: 2,
    automodWarningsBeforeAction: 4,
    automodEscalation: "softban",
  });
  assert.equal(basic.settings.automodEnabled, true);
  assert.equal(basic.settings.automodChannelSlowmodes[0].seconds, 30);
  assert.throws(() => makeSettingsPatch({}, { automodCustomWords: ["spoiler"] }), /require Duck Plus/);
  assert.throws(() => makeSettingsPatch(plus, { automodCustomWords: [{}] }), /must be text/);
  assert.throws(() => makeSettingsPatch({}, { automodChannelSlowmodes: [{ channelId: 123456789012345678, seconds: 30 }] }), /valid channel/);
  assert.throws(() => makeSettingsPatch({}, { automodGlobalSlowmodeSeconds: 21_601 }), /0-21600/);
  assert.throws(() => makeSettingsPatch({}, { automodViolationsBeforeWarn: 0 }), /1 to 20/);

  assert.deepEqual(makeSettingsPatch(plus, { automodCustomWords: [" Spoiler ", "spoiler"] }).settings.automodCustomWords, ["spoiler"]);
});

test("custom actions use safe allowlists and loyalty-based caps", () => {
  const action = (index, actionType = "reply") => ({
    id: `rule_${index}`,
    name: `Rule ${index}`,
    enabled: true,
    triggerType: "contains",
    triggerValue: "hello",
    channelId: null,
    userId: null,
    actionType,
    response: actionType === "reply" ? "Hi {user}" : "",
  });
  assert.equal(makeSettingsPatch({}, { customActions: Array.from({ length: 5 }, (_, index) => action(index)) }).settings.customActions.length, 5);
  assert.throws(() => makeSettingsPatch({}, { customActions: Array.from({ length: 6 }, (_, index) => action(index)) }), /up to 5/);
  assert.throws(() => makeSettingsPatch({}, { customActions: [action(1, "kick")] }), /require Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { customActions: [{ ...action(1), actionType: "execute" }] }), /unsupported/);
  assert.throws(() => makeSettingsPatch({}, { customActions: [{ ...action(1), enabled: "true" }] }), /invalid types/);
  assert.throws(() => makeSettingsPatch({}, { customActions: [{ ...action(1), extra: "client-owned" }] }), /unknown field/);
  assert.throws(() => makeSettingsPatch({}, { customActions: [action(1), action(1)] }), /unique/);

  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const basePlus = { subscription: { provider: "stripe", tier: "plus", status: "active", startedAt: "2026-07-14T00:00:00.000Z" } };
  const threeMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2026-05-14T00:00:00.000Z" } };
  const sixMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2026-02-14T00:00:00.000Z" } };
  assert.equal(getPlusLoyalty(basePlus, now).customActionLimit, 25);
  assert.equal(getPlusLoyalty(threeMonthPlus, now).customActionLimit, 50);
  assert.equal(getPlusLoyalty(sixMonthPlus, now).customActionLimit, null);
  assert.equal(makeSettingsPatch(basePlus, { customActions: [action(1, "kick")] }, "", now).settings.customActions[0].actionType, "kick");
  assert.deepEqual(getPublicGuildSettings({ customActions: [action(1), action(2, "kick")] }).customActions.map(({ actionType }) => actionType), ["reply"]);
});
