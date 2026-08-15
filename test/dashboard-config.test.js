import assert from "node:assert/strict";
import test from "node:test";
import { getPublicGuildSettings, getPublicModelCatalog, hasPlusEntitlement, makeSettingsPatch } from "../src/dashboard-config.js";

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
  assert.equal(getPublicModelCatalog().tts.find(({ id }) => id === "deepgram/flux-tts").label, "Deepgram Flux TTS");
});

test("settings without subscription data normalize to the Free plan", () => {
  const settings = getPublicGuildSettings({ aiChatEnabled: true });
  assert.deepEqual(settings.subscription, {
    tier: "free",
    status: "inactive",
    source: null,
    expiresAt: null,
    cancelAtPeriodEnd: false,
  });
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
