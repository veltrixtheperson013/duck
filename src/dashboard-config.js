const AI_MODELS = Object.freeze([
  {
    id: "cohere/north-mini-code:free",
    label: "Cohere North Mini Code",
    tier: "free",
    disclaimer: "This provider may retain prompts, but states they are not used for training.",
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Google Gemma 4 31B",
    tier: "free",
    disclaimer: "This provider may retain prompts, but states they are not used for training.",
  },
  {
    id: "openai/gpt-oss-20b:free",
    label: "OpenAI GPT-OSS 20B",
    tier: "free",
    disclaimer: "This provider may retain prompts, but states they are not used for training.",
  },
  {
    id: "tencent/hy3",
    label: "Tencent HY 3",
    tier: "plus",
    disclaimer: "Routed only to Tencent with data collection denied. Provider policies can still change.",
    providerRouting: { order: ["tencent"], allow_fallbacks: false, data_collection: "deny" },
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    label: "Llama 3.1 70B Instruct",
    tier: "plus",
    disclaimer: "Routed only through providers that declare no data collection. Provider policies can still change.",
    providerRouting: { data_collection: "deny" },
  },
]);

const TTS_MODELS = Object.freeze([
  {
    id: "elevenlabs/default",
    label: "ElevenLabs (host default)",
    tier: "free",
    disclaimer: "Uses the voice configured by Duck's host.",
  },
  {
    id: "deepgram/flux-tts",
    label: "Deepgram Flux TTS",
    tier: "free",
    disclaimer: "Duck requests model-improvement opt-out. Provider policies can still change.",
  },
]);

const AI_MODEL_IDS = new Set(AI_MODELS.map(({ id }) => id));
const TTS_MODEL_IDS = new Set(TTS_MODELS.map(({ id }) => id));
const CAPABILITY_MODES = new Set(["ask", "approve", "agent"]);
const AI_CONTEXT_MODES = new Set(["current", "focused", "server"]);
const AI_RESPONSE_STYLES = new Set(["concise", "balanced", "detailed"]);
const AI_CHANNEL_MODES = new Set(["mentions", "moderation"]);

function getAiModelDefinition(id) {
  return AI_MODELS.find((model) => model.id === id) ?? null;
}

function hasPlusEntitlement(settings, now = Date.now()) {
  const subscription = settings?.subscription;
  if (subscription?.tier !== "plus" || !["active", "trialing"].includes(subscription.status)) return false;
  const expiresAt = Date.parse(subscription.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function getDefaultAiModel(configuredModel = "") {
  return AI_MODEL_IDS.has(configuredModel) ? configuredModel : AI_MODELS[0].id;
}

function getPublicGuildSettings(settings = {}, configuredModel = "", now = Date.now()) {
  const selected = getAiModelDefinition(settings.aiModel);
  const aiModel = selected && (selected.tier !== "plus" || hasPlusEntitlement(settings, now))
    ? selected.id
    : getDefaultAiModel(configuredModel && getAiModelDefinition(configuredModel)?.tier !== "plus" ? configuredModel : "");
  const ttsModel = TTS_MODEL_IDS.has(settings.ttsModel) ? settings.ttsModel : TTS_MODELS[0].id;
  const plus = hasPlusEntitlement(settings, now);
  return {
    aiChatEnabled: settings.aiChatEnabled !== false,
    aiModel,
    aiVisionEnabled: settings.aiVisionEnabled !== false,
    aiContextMode: AI_CONTEXT_MODES.has(settings.aiContextMode) ? settings.aiContextMode : "server",
    aiResponseStyle: AI_RESPONSE_STYLES.has(settings.aiResponseStyle) ? settings.aiResponseStyle : "balanced",
    aiChannelMode: AI_CHANNEL_MODES.has(settings.aiChannelMode) ? settings.aiChannelMode : "moderation",
    aiPersonality: plus && typeof settings.aiPersonality === "string" ? settings.aiPersonality : "",
    ttsEnabled: settings.ttsEnabled !== false,
    ttsModel,
    ttsAnnounceNames: settings.ttsAnnounceNames !== false,
    capabilityMode: CAPABILITY_MODES.has(settings.capabilityMode) ? settings.capabilityMode : "ask",
    commandPrefix: typeof settings.commandPrefix === "string" ? settings.commandPrefix : "!",
    modChannelId: /^\d{10,}$/.test(settings.modChannelId || "") ? settings.modChannelId : null,
    welcomeChannelId: /^\d{10,}$/.test(settings.welcomeChannelId || "") ? settings.welcomeChannelId : null,
    welcomeMessage: typeof settings.welcomeMessage === "string" ? settings.welcomeMessage : "Welcome {user} to {server}.",
    farewellMessage: typeof settings.farewellMessage === "string" ? settings.farewellMessage : "{username} has left the server.",
    logChannelId: /^\d{10,}$/.test(settings.entryChannels?.logChannelId || "") ? settings.entryChannels.logChannelId : null,
    subscription: {
      tier: plus ? "plus" : "free",
      status: plus ? settings.subscription.status : "inactive",
      source: plus && settings.subscription.provider === "owner" ? "owner" : plus ? "stripe" : null,
      expiresAt: plus ? settings.subscription.expiresAt ?? null : null,
      cancelAtPeriodEnd: plus ? Boolean(settings.subscription.cancelAtPeriodEnd) : false,
    },
  };
}

function makeSettingsPatch(current, input, configuredModel = "", now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings must be a JSON object.");
  const allowed = new Set(["aiChatEnabled", "aiModel", "aiVisionEnabled", "aiContextMode", "aiResponseStyle", "aiChannelMode", "aiPersonality", "ttsEnabled", "ttsModel", "ttsAnnounceNames", "capabilityMode", "commandPrefix", "modChannelId", "welcomeChannelId", "welcomeMessage", "farewellMessage", "logChannelId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unknown setting.");
  const patch = {};
  for (const key of ["aiChatEnabled", "aiVisionEnabled", "ttsEnabled", "ttsAnnounceNames"]) {
    if (key in input) {
      if (typeof input[key] !== "boolean") throw new TypeError(`${key} must be true or false.`);
      patch[key] = input[key];
    }
  }
  if ("aiModel" in input) {
    const model = getAiModelDefinition(input.aiModel);
    if (!model) throw new TypeError("Unsupported AI model.");
    if (model.tier === "plus" && !hasPlusEntitlement(current, now)) {
      const error = new Error("That AI model requires Duck Plus.");
      error.code = "plus_required";
      throw error;
    }
    patch.aiModel = model.id;
  }
  if ("ttsModel" in input) {
    if (!TTS_MODEL_IDS.has(input.ttsModel)) throw new TypeError("Unsupported TTS model.");
    patch.ttsModel = input.ttsModel;
  }
  if ("aiContextMode" in input) {
    if (!AI_CONTEXT_MODES.has(input.aiContextMode)) throw new TypeError("Unsupported AI context mode.");
    patch.aiContextMode = input.aiContextMode;
  }
  if ("aiResponseStyle" in input) {
    if (!AI_RESPONSE_STYLES.has(input.aiResponseStyle)) throw new TypeError("Unsupported AI response style.");
    if (input.aiResponseStyle === "detailed" && !hasPlusEntitlement(current, now)) {
      const error = new Error("Detailed AI responses require Duck Plus.");
      error.code = "plus_required";
      throw error;
    }
    patch.aiResponseStyle = input.aiResponseStyle;
  }
  if ("aiChannelMode" in input) {
    if (!AI_CHANNEL_MODES.has(input.aiChannelMode)) throw new TypeError("Unsupported AI channel mode.");
    patch.aiChannelMode = input.aiChannelMode;
  }
  if ("aiPersonality" in input) {
    if (!hasPlusEntitlement(current, now)) {
      const error = new Error("Custom AI personality requires Duck Plus.");
      error.code = "plus_required";
      throw error;
    }
    const personality = String(input.aiPersonality).trim();
    if (personality.length > 240) throw new TypeError("AI personality must be 240 characters or fewer.");
    patch.aiPersonality = personality;
  }
  if ("capabilityMode" in input) {
    if (!CAPABILITY_MODES.has(input.capabilityMode)) throw new TypeError("Unsupported approval mode.");
    patch.capabilityMode = input.capabilityMode;
  }
  if ("commandPrefix" in input) {
    const prefix = String(input.commandPrefix);
    if (!/^\S{1,5}$/u.test(prefix) || /[@#`]/u.test(prefix)) throw new TypeError("Prefix must be 1-5 non-space characters and cannot contain @, #, or `.");
    patch.commandPrefix = prefix;
  }
  for (const key of ["modChannelId", "welcomeChannelId"]) {
    if (key in input) {
      if (input[key] !== null && !/^\d{10,}$/.test(String(input[key]))) throw new TypeError(`${key} must be a Discord channel ID or null.`);
      patch[key] = input[key] === null ? null : String(input[key]);
    }
  }
  if ("logChannelId" in input) {
    if (input.logChannelId !== null && !/^\d{10,}$/.test(String(input.logChannelId))) throw new TypeError("logChannelId must be a Discord channel ID or null.");
    patch.entryChannels = { ...(current.entryChannels || {}), logChannelId: input.logChannelId === null ? null : String(input.logChannelId) };
  }
  for (const key of ["welcomeMessage", "farewellMessage"]) {
    if (key in input) {
      const value = String(input[key]).trim();
      if (!value || value.length > 180) throw new TypeError(`${key} must be 1-180 characters.`);
      patch[key] = value;
    }
  }
  return { patch, settings: getPublicGuildSettings({ ...current, ...patch }, configuredModel, now) };
}

function getPublicModelCatalog() {
  return {
    ai: AI_MODELS.map(({ providerRouting: _private, ...model }) => model),
    tts: TTS_MODELS.map((model) => ({ ...model })),
  };
}

export {
  AI_MODELS,
  TTS_MODELS,
  getAiModelDefinition,
  getDefaultAiModel,
  getPublicGuildSettings,
  getPublicModelCatalog,
  hasPlusEntitlement,
  makeSettingsPatch,
};
