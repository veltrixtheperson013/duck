import assert from "node:assert/strict";
import test from "node:test";
import { getAiModelDefinition, getBrandingEligibleAt, getFunCommandAccess, getPlusLoyalty, getPublicGuildSettings, getPublicModelCatalog, hasMaturePlusEntitlement, hasPlusEntitlement, makeSettingsPatch } from "../src/dashboard-config.js";

test("dashboard settings allowlist fields and gate Plus models per guild", () => {
  const free = makeSettingsPatch({}, { aiChatEnabled: false, aiModel: "google/gemma-4-31b-it:free" });
  assert.equal(free.settings.aiChatEnabled, false);
  assert.equal(free.settings.aiModel, "google/gemma-4-31b-it:free");
  assert.equal(getPublicModelCatalog().ai.find(({ id }) => id === "openrouter/free").label, "OpenRouter Free Router");
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
  const owner = { subscription: { provider: "owner", tier: "plus", status: "active" } };
  assert.equal(hasMaturePlusEntitlement(owner, now), true);
  assert.equal(getPlusLoyalty(owner, now).level, "plus_12");
  assert.equal(getPlusLoyalty(owner, now).customActionLimit, null);
});

test("fun commands keep a Free set and enforce Plus toggles", () => {
  const free = getPublicGuildSettings({});
  assert.equal(free.funQuackEnabled, true);
  assert.equal(free.funDuckFactEnabled, true);
  assert.equal(free.funCoinflipEnabled, true);
  assert.equal(free.funThisOrThatEnabled, true);
  assert.equal(free.funRandomMemberEnabled, true);
  assert.equal(free.funRpsEnabled, true);
  assert.equal(free.funFortuneEnabled, true);
  assert.equal(free.funRoastEnabled, false);
  assert.equal(free.funAlibiEnabled, false);
  assert.equal(getFunCommandAccess(free, "quack").allowed, true);
  assert.equal(getFunCommandAccess(free, "roast").reason, "plus_required");
  assert.equal(getFunCommandAccess(free, "battle").reason, "plus_required");
  assert.equal(getFunCommandAccess(free, "heist").reason, "plus_required");
  assert.throws(() => makeSettingsPatch({}, { funRoastEnabled: true }), /requires Duck Plus/);

  const plus = { subscription: { tier: "plus", status: "active" } };
  const enabled = makeSettingsPatch(plus, { funRoastEnabled: true, funWouldYouRatherEnabled: true, funAwardEnabled: true });
  assert.equal(enabled.settings.funRoastEnabled, true);
  assert.equal(getFunCommandAccess({ ...plus, ...enabled.patch }, "roast").allowed, true);
  assert.equal(getFunCommandAccess({ ...plus, ...enabled.patch }, "award").allowed, true);
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
  const honeypot = makeSettingsPatch({}, { automodHoneypotEnabled: true, automodHoneypotChannelId: "123456789012345678" });
  assert.equal(honeypot.settings.automodHoneypotEnabled, true); assert.equal(honeypot.settings.automodHoneypotChannelId, "123456789012345678");
  assert.throws(() => makeSettingsPatch({}, { automodCustomWords: ["spoiler"] }), /require Duck Plus/);
  assert.throws(() => makeSettingsPatch(plus, { automodCustomWords: [{}] }), /must be text/);
  assert.throws(() => makeSettingsPatch({}, { automodChannelSlowmodes: [{ channelId: 123456789012345678, seconds: 30 }] }), /valid channel/);
  assert.throws(() => makeSettingsPatch({}, { automodGlobalSlowmodeSeconds: 21_601 }), /0-21600/);
  assert.throws(() => makeSettingsPatch({}, { automodViolationsBeforeWarn: 0 }), /1 to 20/);

  assert.deepEqual(makeSettingsPatch(plus, { automodCustomWords: [" Spoiler ", "spoiler"] }).settings.automodCustomWords, ["spoiler"]);
});

test("model definitions and private provider policies cannot change at runtime", () => {
  const tencent = getAiModelDefinition("tencent/hy3");
  assert.equal(Object.isFrozen(tencent), true);
  assert.equal(Object.isFrozen(tencent.providerRouting), true);
  assert.equal(Object.isFrozen(tencent.providerRouting.order), true);
  assert.throws(() => { tencent.providerRouting.data_collection = "allow"; }, TypeError);
});

test("community modules and rule-aware scanning use bounded server-owned configuration", () => {
  const input = {
    aiScanRulesChannelId: "123456789012345678",
    reactionRolesEnabled: true,
    reactionRoleChannelId: "223456789012345678",
    reactionRoleTitle: "Pick a color",
    reactionRoleOptions: [{ roleId: "323456789012345678", label: "Green", emoji: "💚" }],
    ticketsEnabled: true,
    ticketPanelChannelId: "423456789012345678",
    ticketCategoryId: "523456789012345678",
    ticketSupportRoleId: "623456789012345678",
    ticketAdminRoleId: "723456789012345678",
    ticketPanelTitle: "Support pond",
    ticketOptions: [{ id: "verify", label: "Verify", description: "Complete a human check", emoji: "🎫", type: "verification", verificationLabel: "Human verification", additionalMessage: "Thanks for verifying." }],
  };
  const { patch, settings } = makeSettingsPatch({}, input);
  assert.deepEqual(patch.reactionRoleOptions, input.reactionRoleOptions);
  assert.deepEqual(settings.ticketOptions, input.ticketOptions);
  assert.equal(settings.aiScanRulesChannelId, input.aiScanRulesChannelId);
  assert.throws(() => makeSettingsPatch({}, { reactionRoleOptions: [{ roleId: "bad", label: "Admin", emoji: "x" }] }), /invalid/i);
  assert.throws(() => makeSettingsPatch({}, { ticketOptions: Array.from({ length: 6 }, (_, index) => ({ id: `x${index}`, label: "x", description: "", emoji: "" })) }), /up to 5/i);
  assert.throws(() => makeSettingsPatch({}, { ticketOptions: [{ id: "bad", label: "Bad", description: "", emoji: "", type: "execute_code" }] }), /invalid/i);
});

test("Community Studio keeps useful Free modules and gates advanced controls to Plus", () => {
  const roleId = "123456789012345678";
  const channelId = "223456789012345678";
  const free = makeSettingsPatch({}, {
    autorolesEnabled: true,
    autoroleRoleIds: [roleId],
    levelsEnabled: true,
    suggestionsEnabled: true,
    suggestionChannelId: channelId,
    starboardEnabled: true,
    starboardChannelId: channelId,
    starboardThreshold: 4,
  }).settings;
  assert.equal(free.levelsEnabled, true);
  assert.deepEqual(free.autoroleRoleIds, [roleId]);
  assert.equal(free.starboardEmoji, "⭐");
  assert.throws(() => makeSettingsPatch({}, { autoroleRoleIds: [roleId, "323456789012345678"] }), /up to 1/);
  assert.throws(() => makeSettingsPatch({}, { suggestionAnonymousEnabled: true }), /requires Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { starboardEmoji: "🦆" }), /requires Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { levelRewards: [{ level: 5, roleId }] }), /require Duck Plus/);

  const plus = { subscription: { provider: "stripe", tier: "plus", status: "active" } };
  const advanced = makeSettingsPatch(plus, {
    autoroleRoleIds: [roleId, "323456789012345678"],
    levelRewards: [{ level: 5, roleId }],
    suggestionAnonymousEnabled: true,
    starboardEmoji: "🦆",
    starboardColor: "#16845c",
    scheduledPosts: [{ id: "rules_reminder", name: "Rules reminder", enabled: true, channelId, intervalMinutes: 1440, message: "Remember the rules." }],
  }).settings;
  assert.equal(advanced.suggestionAnonymousEnabled, true);
  assert.equal(advanced.starboardColor, 0x16845c);
  assert.equal(advanced.scheduledPosts.length, 1);
});

test("Color Dock validates cosmetic palettes and keeps larger automation in Plus", () => {
  const roleId = "123456789012345678";
  const channelId = "223456789012345678";
  const free = makeSettingsPatch({}, { colorRolesEnabled: true, colorRoleChannelId: channelId, colorRoleRequiredRoleId: roleId, colorRoleTitle: "Pond colors", colorRoleDescription: "Choose one.", colorRoleAccent: "#7c68ee", colorRoleAllowRemove: true, colorRoleOptions: [{ roleId: null, label: "Lagoon", color: "#20a4a8" }] }).settings;
  assert.equal(free.colorRoleOptions[0].color, 0x20a4a8);
  assert.equal(free.colorRoleAllowRemove, true);
  assert.throws(() => makeSettingsPatch({}, { colorRoleRandomOnJoin: true }), /requires Duck Plus/);
  assert.throws(() => makeSettingsPatch({}, { colorRoleOptions: Array.from({ length: 13 }, (_, index) => ({ roleId: null, label: `Color ${index}`, color: "#112233" })) }), /up to 12/);
  assert.throws(() => makeSettingsPatch({}, { colorRoleOptions: [{ roleId: null, label: "Bad", color: "red" }] }), /invalid/);
  const plus = { subscription: { tier: "plus", status: "active" } };
  assert.equal(makeSettingsPatch(plus, { colorRoleRandomOnJoin: true }).settings.colorRoleRandomOnJoin, true);
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
  const twoMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2026-06-14T00:00:00.000Z" } };
  const threeMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2026-05-14T00:00:00.000Z" } };
  const sixMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2026-02-14T00:00:00.000Z" } };
  const twelveMonthPlus = { subscription: { ...basePlus.subscription, startedAt: "2025-08-14T00:00:00.000Z" } };
  assert.equal(getPlusLoyalty(basePlus, now).customActionLimit, 25);
  assert.equal(getPlusLoyalty(twoMonthPlus, now).customActionLimit, 35);
  assert.equal(getPlusLoyalty(twoMonthPlus, now).memoryReplies, 24);
  assert.equal(getPlusLoyalty(threeMonthPlus, now).customActionLimit, 50);
  assert.equal(getPlusLoyalty(sixMonthPlus, now).customActionLimit, 100);
  assert.equal(getPlusLoyalty(twelveMonthPlus, now).customActionLimit, null);
  assert.equal(makeSettingsPatch(basePlus, { customActions: [action(1, "kick")] }, "", now).settings.customActions[0].actionType, "kick");
  assert.deepEqual(getPublicGuildSettings({ customActions: [action(1), action(2, "kick")] }).customActions.map(({ actionType }) => actionType), ["reply"]);
});
