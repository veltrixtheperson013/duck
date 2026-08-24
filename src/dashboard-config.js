function freezeModelDefinition(model) {
  const providerRouting = model.providerRouting
    ? Object.freeze({ ...model.providerRouting, ...(model.providerRouting.order ? { order: Object.freeze([...model.providerRouting.order]) } : {}) })
    : undefined;
  return Object.freeze({ ...model, ...(providerRouting ? { providerRouting } : {}) });
}

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
    id: "openrouter/free",
    label: "OpenRouter Free Router",
    tier: "free",
    disclaimer: "OpenRouter selects an available free model. The model provider and its data policy can vary between requests.",
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
].map(freezeModelDefinition));

const TTS_MODELS = Object.freeze([
  {
    id: "deepgram/flux-tts:free",
    label: "Deepgram Flux TTS",
    tier: "free",
    disclaimer: "Free speech generation routed through OpenRouter using Deepgram's Flux Cole voice.",
  },
  {
    id: "elevenlabs/default",
    label: "ElevenLabs",
    tier: "plus",
    disclaimer: "Duck Plus voice using the host-configured ElevenLabs voice and model.",
  },
].map(freezeModelDefinition));

const AI_MODEL_IDS = new Set(AI_MODELS.map(({ id }) => id));
const TTS_MODEL_IDS = new Set(TTS_MODELS.map(({ id }) => id));
const CAPABILITY_MODES = new Set(["ask", "approve", "agent"]);
const AI_CONTEXT_MODES = new Set(["current", "focused", "server"]);
const AI_RESPONSE_STYLES = new Set(["concise", "balanced", "detailed"]);
const AI_CHANNEL_MODES = new Set(["mentions", "moderation"]);
const AI_SCAN_SENSITIVITIES = new Set(["low", "balanced", "high"]);
const FUN_COMMANDS = Object.freeze([
  { command: "quack", key: "funQuackEnabled", label: "Quack", tier: "free" },
  { command: "duckfact", key: "funDuckFactEnabled", label: "Duck facts", tier: "free" },
  { command: "coinflip", key: "funCoinflipEnabled", label: "Coin flip", tier: "free" },
  { command: "truth", key: "funTruthEnabled", label: "Truth", tier: "free" },
  { command: "dare", key: "funDareEnabled", label: "Dare", tier: "free" },
  { command: "truthordare", key: "funTruthOrDareEnabled", label: "Truth or dare", tier: "free" },
  { command: "rps", key: "funRpsEnabled", label: "Rock paper scissors", tier: "free" },
  { command: "fortune", key: "funFortuneEnabled", label: "Fortunes", tier: "free" },
  { command: "topic", key: "funTopicEnabled", label: "Conversation topics", tier: "free" },
  { command: "joke", key: "funJokeEnabled", label: "Pond jokes", tier: "free" },
  { command: "number", key: "funNumberEnabled", label: "Random number", tier: "free" },
  { command: "thisorthat", key: "funThisOrThatEnabled", label: "This or that", tier: "free" },
  { command: "randommember", key: "funRandomMemberEnabled", label: "Random member", tier: "free" },
  { command: "ship", key: "funShipEnabled", label: "Compatibility", tier: "plus" },
  { command: "curse", key: "funCurseEnabled", label: "Curses and blessings", tier: "plus" },
  { command: "spinwheel", key: "funSpinwheelEnabled", label: "Spin wheel", tier: "plus" },
  { command: "roll", key: "funRollEnabled", label: "Dice roller", tier: "plus" },
  { command: "eightball", key: "funEightballEnabled", label: "Magic 8-Ball", tier: "plus" },
  { command: "quote", key: "funQuoteEnabled", label: "Quote book", tier: "plus" },
  { command: "roast", key: "funRoastEnabled", label: "Friendly roasts", tier: "plus" },
  { command: "compliment", key: "funComplimentEnabled", label: "Compliments", tier: "plus" },
  { command: "choose", key: "funChooseEnabled", label: "Decision maker", tier: "plus" },
  { command: "rate", key: "funRateEnabled", label: "Extremely scientific ratings", tier: "plus" },
  { command: "wouldyourather", key: "funWouldYouRatherEnabled", label: "Would you rather", tier: "plus" },
  { command: "neverhaveiever", key: "funNeverHaveIEverEnabled", label: "Never have I ever", tier: "plus" },
  { command: "hotseat", key: "funHotseatEnabled", label: "Hot seat", tier: "plus" },
  { command: "vibecheck", key: "funVibeCheckEnabled", label: "Vibe check", tier: "plus" },
  { command: "battle", key: "funBattleEnabled", label: "Pond battle", tier: "plus" },
  { command: "dramatic", key: "funDramaticEnabled", label: "Dramatic introductions", tier: "plus" },
  { command: "conspiracy", key: "funConspiracyEnabled", label: "Silly conspiracies", tier: "plus" },
  { command: "challenge", key: "funChallengeEnabled", label: "Mini challenges", tier: "plus" },
  { command: "caption", key: "funCaptionEnabled", label: "Caption generator", tier: "plus" },
  { command: "alibi", key: "funAlibiEnabled", label: "Suspicious alibis", tier: "plus" },
  { command: "backstory", key: "funBackstoryEnabled", label: "Absurd backstories", tier: "plus" },
  { command: "award", key: "funAwardEnabled", label: "Pond awards", tier: "plus" },
  { command: "heist", key: "funHeistEnabled", label: "Imaginary heists", tier: "plus" },
]);
const FUN_COMMAND_BY_NAME = new Map(FUN_COMMANDS.map((command) => [command.command, command]));
const CUSTOM_ACTION_TRIGGERS = new Set(["message", "contains", "starts_with"]);
const CUSTOM_ACTION_TYPES = new Set(["reply", "react", "delete", "warn", "timeout", "kick", "softban"]);

function getAiModelDefinition(id) {
  return AI_MODELS.find((model) => model.id === id) ?? null;
}

function hasPlusEntitlement(settings, now = Date.now()) {
  const subscription = settings?.subscription;
  if (subscription?.tier !== "plus" || !["active", "trialing"].includes(subscription.status)) return false;
  const expiresAt = Date.parse(subscription.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function getBrandingEligibleAt(settings) {
  const startedAt = new Date(settings?.subscription?.startedAt || "");
  if (Number.isNaN(startedAt.valueOf())) return null;
  const targetMonth = startedAt.getUTCMonth() + 3;
  const finalDay = new Date(Date.UTC(startedAt.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(startedAt.getUTCFullYear(), targetMonth, Math.min(startedAt.getUTCDate(), finalDay), startedAt.getUTCHours(), startedAt.getUTCMinutes(), startedAt.getUTCSeconds(), startedAt.getUTCMilliseconds())).toISOString();
}

function addSubscriptionMonths(value, months) {
  const startedAt = new Date(value || "");
  if (Number.isNaN(startedAt.valueOf())) return null;
  const targetMonth = startedAt.getUTCMonth() + months;
  const finalDay = new Date(Date.UTC(startedAt.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(startedAt.getUTCFullYear(), targetMonth, Math.min(startedAt.getUTCDate(), finalDay), startedAt.getUTCHours(), startedAt.getUTCMinutes(), startedAt.getUTCSeconds(), startedAt.getUTCMilliseconds())).toISOString();
}

function getPlusLoyalty(settings, now = Date.now()) {
  const plus = hasPlusEntitlement(settings, now);
  const subscription = settings?.subscription ?? {};
  const owner = plus && subscription.provider === "owner";
  const paid = plus && ["stripe", "operator"].includes(subscription.provider);
  const startedAt = paid ? Date.parse(subscription.startedAt || "") : NaN;
  const twoAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 2) || "") : NaN;
  const threeAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 3) || "") : NaN;
  const sixAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 6) || "") : NaN;
  const twelveAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 12) || "") : NaN;
  const months = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / (30.4375 * 24 * 60 * 60_000))) : 0;
  const override = subscription.provider === "operator" && ["plus", "plus_2", "plus_3", "plus_6", "plus_12"].includes(subscription.levelOverride) ? subscription.levelOverride : null;
  const earnedLevel = Number.isFinite(twelveAt) && now >= twelveAt ? "plus_12" : Number.isFinite(sixAt) && now >= sixAt ? "plus_6" : Number.isFinite(threeAt) && now >= threeAt ? "plus_3" : Number.isFinite(twoAt) && now >= twoAt ? "plus_2" : "plus";
  const level = !plus ? "free" : owner ? "plus_12" : override || earnedLevel;
  const limits = { free: [5, 6], plus: [25, 16], plus_2: [35, 24], plus_3: [50, 32], plus_6: [100, 64], plus_12: [null, 100] };
  const [customActionLimit, memoryReplies] = limits[level];
  const milestones = { plus: [startedAt, twoAt, "plus_2"], plus_2: [twoAt, threeAt, "plus_3"], plus_3: [threeAt, sixAt, "plus_6"], plus_6: [sixAt, twelveAt, "plus_12"] };
  const [progressStart, progressEnd, nextLevel] = milestones[level] || [NaN, NaN, null];
  const nextAt = Number.isFinite(progressEnd) ? new Date(progressEnd).toISOString() : null;
  const progress = Number.isFinite(progressStart) && Number.isFinite(progressEnd) ? Math.max(0, Math.min(1, (now - progressStart) / (progressEnd - progressStart))) : level === "plus_12" ? 1 : 0;
  return { level, paid, owner, months, startedAt: paid ? subscription.startedAt : null, nextAt, nextLevel, progress, customActionLimit, memoryReplies };
}

function hasMaturePlusEntitlement(settings, now = Date.now()) {
  if (!hasPlusEntitlement(settings, now)) return false;
  if (settings?.subscription?.provider === "owner") return true;
  if (settings?.subscription?.provider === "operator") return ["plus_3", "plus_6", "plus_12"].includes(settings.subscription.levelOverride);
  if (settings?.subscription?.provider !== "stripe") return false;
  const eligibleAt = Date.parse(getBrandingEligibleAt(settings) || "");
  return Number.isFinite(eligibleAt) && eligibleAt <= now;
}

function getFunCommandAccess(settings, command, now = Date.now()) {
  const definition = FUN_COMMAND_BY_NAME.get(command);
  if (!definition) return null;
  if (settings?.funCommandsEnabled === false) return { allowed: false, reason: "disabled", definition };
  if (definition.tier === "plus" && !hasPlusEntitlement(settings, now)) return { allowed: false, reason: "plus_required", definition };
  const enabled = definition.tier === "free" ? settings?.[definition.key] !== false : settings?.[definition.key] === true;
  return { allowed: enabled, reason: enabled ? null : "disabled", definition };
}

function getDefaultAiModel(configuredModel = "") {
  return AI_MODEL_IDS.has(configuredModel) ? configuredModel : AI_MODELS[0].id;
}

function getPublicGuildSettings(settings = {}, configuredModel = "", now = Date.now()) {
  const subscription = settings.subscription ?? {};
  const selected = getAiModelDefinition(settings.aiModel);
  const aiModel = selected && (selected.tier !== "plus" || hasPlusEntitlement(settings, now))
    ? selected.id
    : getDefaultAiModel(configuredModel && getAiModelDefinition(configuredModel)?.tier !== "plus" ? configuredModel : "");
  const plus = hasPlusEntitlement(settings, now);
  const selectedTts = TTS_MODELS.find(({ id }) => id === settings.ttsModel);
  const ttsModel = selectedTts && (selectedTts.tier !== "plus" || plus) ? selectedTts.id : TTS_MODELS.find(({ tier }) => tier === "free").id;
  const loyalty = getPlusLoyalty(settings, now);
  const customActions = Array.isArray(settings.customActions)
    ? settings.customActions
      .filter((action) => plus || !["warn", "timeout", "kick", "softban"].includes(action?.actionType))
      .slice(0, loyalty.customActionLimit ?? settings.customActions.length)
    : [];
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
    funCommandsEnabled: settings.funCommandsEnabled !== false,
    ...Object.fromEntries(FUN_COMMANDS.map((command) => [command.key, command.tier === "free" ? settings[command.key] !== false : plus && settings[command.key] === true])),
    automodEnabled: settings.automodEnabled === true,
    automodHoneypotEnabled: settings.automodHoneypotEnabled === true,
    automodHoneypotChannelId: /^\d{10,}$/.test(settings.automodHoneypotChannelId || "") ? settings.automodHoneypotChannelId : null,
    honeypotStats: {
      total: Math.min(1_000_000_000, Math.max(0, Number(settings.honeypotStats?.total) || 0)),
      firstTraps: Math.min(1_000_000_000, Math.max(0, Number(settings.honeypotStats?.firstTraps) || 0)),
      permanentBans: Math.min(1_000_000_000, Math.max(0, Number(settings.honeypotStats?.permanentBans) || 0)),
      lastTriggeredAt: typeof settings.honeypotStats?.lastTriggeredAt === "string" ? settings.honeypotStats.lastTriggeredAt : null,
    },
    automodSwearFilter: settings.automodSwearFilter === true,
    automodNsfwFilter: settings.automodNsfwFilter === true,
    automodInviteFilter: settings.automodInviteFilter === true,
    automodCapsFilter: settings.automodCapsFilter === true,
    automodMentionLimit: Number.isInteger(settings.automodMentionLimit) ? settings.automodMentionLimit : 0,
    automodCustomWords: plus && Array.isArray(settings.automodCustomWords) ? settings.automodCustomWords : [],
    automodViolationsBeforeWarn: Number.isInteger(settings.automodViolationsBeforeWarn) ? settings.automodViolationsBeforeWarn : 3,
    automodWarningsBeforeAction: Number.isInteger(settings.automodWarningsBeforeAction) ? settings.automodWarningsBeforeAction : 3,
    automodEscalation: ["kick", "softban"].includes(settings.automodEscalation) ? settings.automodEscalation : "kick",
    automodGlobalSlowmodeSeconds: Number.isInteger(settings.automodGlobalSlowmodeSeconds) ? settings.automodGlobalSlowmodeSeconds : 0,
    automodChannelSlowmodes: Array.isArray(settings.automodChannelSlowmodes) ? settings.automodChannelSlowmodes : [],
    aiScanEnabled: settings.aiScanEnabled === true,
    aiScanChannelIds: Array.isArray(settings.aiScanChannelIds) ? settings.aiScanChannelIds.filter((id) => /^\d{10,}$/.test(id)).slice(0, 25) : [],
    aiScanFlagChannelId: /^\d{10,}$/.test(settings.aiScanFlagChannelId || "") ? settings.aiScanFlagChannelId : null,
    aiScanRulesChannelId: /^\d{10,}$/.test(settings.aiScanRulesChannelId || "") ? settings.aiScanRulesChannelId : null,
    aiScanSensitivity: AI_SCAN_SENSITIVITIES.has(settings.aiScanSensitivity) ? settings.aiScanSensitivity : "balanced",
    reactionRolesEnabled: settings.reactionRolesEnabled === true,
    reactionRoleChannelId: /^\d{10,}$/.test(settings.reactionRoleChannelId || "") ? settings.reactionRoleChannelId : null,
    reactionRoleTitle: typeof settings.reactionRoleTitle === "string" ? settings.reactionRoleTitle : "Choose your roles",
    reactionRoleMode: plus && settings.reactionRoleMode === "exclusive" ? "exclusive" : "normal",
    reactionRoleLimit: plus && Number.isInteger(settings.reactionRoleLimit) ? settings.reactionRoleLimit : 0,
    reactionRoleOptions: Array.isArray(settings.reactionRoleOptions) ? settings.reactionRoleOptions.slice(0, plus ? 25 : 10) : [],
    ticketsEnabled: settings.ticketsEnabled === true,
    ticketPanelChannelId: /^\d{10,}$/.test(settings.ticketPanelChannelId || "") ? settings.ticketPanelChannelId : null,
    ticketCategoryId: /^\d{10,}$/.test(settings.ticketCategoryId || "") ? settings.ticketCategoryId : null,
    ticketSupportRoleId: /^\d{10,}$/.test(settings.ticketSupportRoleId || "") ? settings.ticketSupportRoleId : null,
    ticketAdminRoleId: /^\d{10,}$/.test(settings.ticketAdminRoleId || "") ? settings.ticketAdminRoleId : null,
    ticketPanelTitle: typeof settings.ticketPanelTitle === "string" ? settings.ticketPanelTitle : "Duck Support",
    ticketOptions: Array.isArray(settings.ticketOptions) ? settings.ticketOptions.filter((item) => item && /^[a-z0-9_-]{1,24}$/.test(item.id || "") && typeof item.label === "string").slice(0, plus ? 10 : 5).map((item) => ({ id: item.id, label: item.label.slice(0, 80), description: typeof item.description === "string" ? item.description.slice(0, 200) : "", emoji: typeof item.emoji === "string" ? item.emoji.slice(0, 32) : "", type: ["verification", "image_verification"].includes(item.type) ? item.type : "support", verificationLabel: typeof item.verificationLabel === "string" ? item.verificationLabel.slice(0, 80) : "", additionalMessage: typeof item.additionalMessage === "string" ? item.additionalMessage.slice(0, 500) : "" })) : [],
    ticketTranscriptsEnabled: plus && settings.ticketTranscriptsEnabled === true,
    autorolesEnabled: settings.autorolesEnabled === true,
    autoroleRoleIds: Array.isArray(settings.autoroleRoleIds) ? settings.autoroleRoleIds.filter((id) => /^\d{10,}$/.test(id)).slice(0, plus ? 5 : 1) : [],
    levelsEnabled: settings.levelsEnabled === true,
    levelAnnouncementChannelId: /^\d{10,}$/.test(settings.levelAnnouncementChannelId || "") ? settings.levelAnnouncementChannelId : null,
    levelIgnoredChannelIds: Array.isArray(settings.levelIgnoredChannelIds) ? settings.levelIgnoredChannelIds.filter((id) => /^\d{10,}$/.test(id)).slice(0, 25) : [],
    levelRewards: plus && Array.isArray(settings.levelRewards) ? settings.levelRewards.slice(0, 10) : [],
    suggestionsEnabled: settings.suggestionsEnabled === true,
    suggestionChannelId: /^\d{10,}$/.test(settings.suggestionChannelId || "") ? settings.suggestionChannelId : null,
    suggestionAnonymousEnabled: plus && settings.suggestionAnonymousEnabled === true,
    starboardEnabled: settings.starboardEnabled === true,
    starboardChannelId: /^\d{10,}$/.test(settings.starboardChannelId || "") ? settings.starboardChannelId : null,
    starboardThreshold: Number.isInteger(settings.starboardThreshold) ? settings.starboardThreshold : 3,
    starboardEmoji: plus && typeof settings.starboardEmoji === "string" ? settings.starboardEmoji : "⭐",
    starboardColor: plus && Number.isInteger(settings.starboardColor) ? settings.starboardColor : 0xf2c85b,
    starboardAllowNsfw: plus && settings.starboardAllowNsfw === true,
    scheduledPosts: plus && Array.isArray(settings.scheduledPosts) ? settings.scheduledPosts.slice(0, 10) : [],
    colorRolesEnabled: settings.colorRolesEnabled === true,
    colorRoleChannelId: /^\d{10,}$/.test(settings.colorRoleChannelId || "") ? settings.colorRoleChannelId : null,
    colorRoleRequiredRoleId: /^\d{10,}$/.test(settings.colorRoleRequiredRoleId || "") ? settings.colorRoleRequiredRoleId : null,
    colorRoleTitle: typeof settings.colorRoleTitle === "string" ? settings.colorRoleTitle.slice(0, 100) : "Duck Color Dock",
    colorRoleDescription: typeof settings.colorRoleDescription === "string" ? settings.colorRoleDescription.slice(0, 500) : "Pick one color for your name. Choosing another automatically replaces the old one.",
    colorRoleAccent: Number.isInteger(settings.colorRoleAccent) ? Math.max(0, Math.min(0xffffff, settings.colorRoleAccent)) : 0x7c68ee,
    colorRoleAllowRemove: settings.colorRoleAllowRemove !== false,
    colorRoleRandomOnJoin: plus && settings.colorRoleRandomOnJoin === true,
    colorRoleOptions: Array.isArray(settings.colorRoleOptions) ? settings.colorRoleOptions.filter((item) => item && typeof item.label === "string" && Number.isInteger(item.color)).slice(0, plus ? 30 : 12).map((item) => ({ roleId: /^\d{10,}$/.test(item.roleId || "") ? item.roleId : null, label: item.label.slice(0, 80), color: Math.max(0, Math.min(0xffffff, item.color)) })) : [],
    customActions,
    loyalty,
    subscription: {
      tier: plus ? "plus" : "free",
      status: plus ? subscription.status : "inactive",
      source: plus && ["owner", "operator"].includes(subscription.provider) ? subscription.provider : plus ? "stripe" : null,
      expiresAt: plus ? subscription.expiresAt ?? null : null,
      cancelAtPeriodEnd: plus ? Boolean(subscription.cancelAtPeriodEnd) : false,
      brandingEligible: hasMaturePlusEntitlement(settings, now),
      brandingEligibleAt: plus ? getBrandingEligibleAt(settings) : null,
    },
  };
}

function makeSettingsPatch(current, input, configuredModel = "", now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings must be a JSON object.");
  const allowed = new Set(["aiChatEnabled", "aiModel", "aiVisionEnabled", "aiContextMode", "aiResponseStyle", "aiChannelMode", "aiPersonality", "aiScanEnabled", "aiScanChannelIds", "aiScanFlagChannelId", "aiScanRulesChannelId", "aiScanSensitivity", "reactionRolesEnabled", "reactionRoleChannelId", "reactionRoleTitle", "reactionRoleMode", "reactionRoleLimit", "reactionRoleOptions", "ticketsEnabled", "ticketPanelChannelId", "ticketCategoryId", "ticketSupportRoleId", "ticketAdminRoleId", "ticketPanelTitle", "ticketOptions", "ticketTranscriptsEnabled", "autorolesEnabled", "autoroleRoleIds", "levelsEnabled", "levelAnnouncementChannelId", "levelIgnoredChannelIds", "levelRewards", "suggestionsEnabled", "suggestionChannelId", "suggestionAnonymousEnabled", "starboardEnabled", "starboardChannelId", "starboardThreshold", "starboardEmoji", "starboardColor", "starboardAllowNsfw", "scheduledPosts", "colorRolesEnabled", "colorRoleChannelId", "colorRoleRequiredRoleId", "colorRoleTitle", "colorRoleDescription", "colorRoleAccent", "colorRoleAllowRemove", "colorRoleRandomOnJoin", "colorRoleOptions", "ttsEnabled", "ttsModel", "ttsAnnounceNames", "capabilityMode", "commandPrefix", "modChannelId", "welcomeChannelId", "welcomeMessage", "farewellMessage", "logChannelId", "funCommandsEnabled", "automodEnabled", "automodHoneypotEnabled", "automodHoneypotChannelId", "automodSwearFilter", "automodNsfwFilter", "automodInviteFilter", "automodCapsFilter", "automodMentionLimit", "automodCustomWords", "automodViolationsBeforeWarn", "automodWarningsBeforeAction", "automodEscalation", "automodGlobalSlowmodeSeconds", "automodChannelSlowmodes", "customActions", ...FUN_COMMANDS.map(({ key }) => key)]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unknown setting.");
  const patch = {};
  const plus = hasPlusEntitlement(current, now);
  for (const key of ["aiChatEnabled", "aiVisionEnabled", "aiScanEnabled", "reactionRolesEnabled", "ticketsEnabled", "ticketTranscriptsEnabled", "autorolesEnabled", "levelsEnabled", "suggestionsEnabled", "suggestionAnonymousEnabled", "starboardEnabled", "starboardAllowNsfw", "colorRolesEnabled", "colorRoleAllowRemove", "colorRoleRandomOnJoin", "ttsEnabled", "ttsAnnounceNames", "funCommandsEnabled", "automodEnabled", "automodHoneypotEnabled", "automodSwearFilter", "automodNsfwFilter", "automodInviteFilter", "automodCapsFilter", ...FUN_COMMANDS.map(({ key }) => key)]) {
    if (key in input) {
      if (typeof input[key] !== "boolean") throw new TypeError(`${key} must be true or false.`);
      patch[key] = input[key];
    }
  }
  if ("automodHoneypotChannelId" in input) { if (input.automodHoneypotChannelId !== null && (typeof input.automodHoneypotChannelId !== "string" || !/^\d{10,}$/.test(input.automodHoneypotChannelId))) throw new TypeError("Honeypot channel must be a valid Discord channel or null."); patch.automodHoneypotChannelId = input.automodHoneypotChannelId; }
  if ("automodMentionLimit" in input) { if (!Number.isInteger(input.automodMentionLimit) || input.automodMentionLimit < 0 || input.automodMentionLimit > 20) throw new TypeError("Mention limit must be an integer from 0 to 20."); patch.automodMentionLimit = input.automodMentionLimit; }
  if ("aiScanChannelIds" in input) { if (!Array.isArray(input.aiScanChannelIds) || input.aiScanChannelIds.length > 25 || input.aiScanChannelIds.some((id) => typeof id !== "string" || !/^\d{10,}$/.test(id))) throw new TypeError("AI scan channels must be a list of up to 25 Discord channels."); patch.aiScanChannelIds = [...new Set(input.aiScanChannelIds)]; }
  if ("aiScanFlagChannelId" in input) { if (input.aiScanFlagChannelId !== null && (typeof input.aiScanFlagChannelId !== "string" || !/^\d{10,}$/.test(input.aiScanFlagChannelId))) throw new TypeError("AI review channel must be a Discord channel or null."); patch.aiScanFlagChannelId = input.aiScanFlagChannelId; }
  if ("aiScanRulesChannelId" in input) { if (input.aiScanRulesChannelId !== null && (typeof input.aiScanRulesChannelId !== "string" || !/^\d{10,}$/.test(input.aiScanRulesChannelId))) throw new TypeError("AI rules channel must be a Discord channel or null."); patch.aiScanRulesChannelId = input.aiScanRulesChannelId; }
  if ("aiScanSensitivity" in input) { if (!AI_SCAN_SENSITIVITIES.has(input.aiScanSensitivity)) throw new TypeError("Unsupported AI scan sensitivity."); patch.aiScanSensitivity = input.aiScanSensitivity; }
  for (const key of ["reactionRoleChannelId", "ticketPanelChannelId", "ticketCategoryId", "ticketSupportRoleId", "ticketAdminRoleId", "levelAnnouncementChannelId", "suggestionChannelId", "starboardChannelId", "colorRoleChannelId", "colorRoleRequiredRoleId"]) if (key in input) { if (input[key] !== null && (typeof input[key] !== "string" || !/^\d{10,}$/.test(input[key]))) throw new TypeError(`${key} must be a Discord ID or null.`); patch[key] = input[key]; }
  for (const [key, max, fallback] of [["reactionRoleTitle", 100, "Choose your roles"], ["ticketPanelTitle", 100, "Duck Support"]]) if (key in input) { if (typeof input[key] !== "string") throw new TypeError(`${key} must be text.`); patch[key] = input[key].trim().slice(0, max) || fallback; }
  if ("reactionRoleOptions" in input) {
    const limit = plus ? 25 : 10;
    if (!Array.isArray(input.reactionRoleOptions) || input.reactionRoleOptions.length > limit) throw new TypeError(`Reaction roles must contain up to ${limit} options on this plan.`);
    patch.reactionRoleOptions = input.reactionRoleOptions.map((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["roleId", "label", "emoji"].includes(key)) || !/^\d{10,}$/.test(item.roleId || "") || typeof item.label !== "string" || typeof item.emoji !== "string") throw new TypeError(`Reaction role ${index + 1} is invalid.`); const label = item.label.trim(); const emoji = item.emoji.trim(); if (!label || label.length > 80 || emoji.length > 32) throw new TypeError(`Reaction role ${index + 1} has invalid text.`); return { roleId: item.roleId, label, emoji }; });
  }
  if ("ticketOptions" in input) {
    const limit = plus ? 10 : 5;
    if (!Array.isArray(input.ticketOptions) || input.ticketOptions.length > limit) throw new TypeError(`Tickets must contain up to ${limit} options on this plan.`);
    patch.ticketOptions = input.ticketOptions.map((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "label", "description", "emoji", "type", "verificationLabel", "additionalMessage"].includes(key)) || !/^[a-z0-9_-]{1,24}$/.test(item.id || "") || typeof item.label !== "string" || typeof item.description !== "string" || typeof item.emoji !== "string" || (item.type !== undefined && !["support", "verification", "image_verification"].includes(item.type)) || (item.verificationLabel !== undefined && typeof item.verificationLabel !== "string") || (item.additionalMessage !== undefined && typeof item.additionalMessage !== "string")) throw new TypeError(`Ticket option ${index + 1} is invalid.`); const label = item.label.trim(); const description = item.description.trim(); const emoji = item.emoji.trim(); const type = ["verification", "image_verification"].includes(item.type) ? item.type : "support"; const verificationLabel = String(item.verificationLabel || "").trim(); const additionalMessage = String(item.additionalMessage || "").trim(); if (!label || label.length > 80 || description.length > 200 || emoji.length > 32 || verificationLabel.length > 80 || additionalMessage.length > 500) throw new TypeError(`Ticket option ${index + 1} has invalid text.`); return { id: item.id, label, description, emoji, type, verificationLabel, additionalMessage }; });
  }
  if ("reactionRoleMode" in input) { if (!["normal", "exclusive"].includes(input.reactionRoleMode)) throw new TypeError("Unsupported reaction-role mode."); if (input.reactionRoleMode === "exclusive" && !plus) throw new TypeError("Exclusive reaction roles require Duck Plus."); patch.reactionRoleMode = input.reactionRoleMode; }
  if ("reactionRoleLimit" in input) { if (!Number.isInteger(input.reactionRoleLimit) || input.reactionRoleLimit < 0 || input.reactionRoleLimit > 25) throw new TypeError("Reaction-role limit must be 0-25."); if (input.reactionRoleLimit > 0 && !plus) throw new TypeError("Reaction-role selection limits require Duck Plus."); patch.reactionRoleLimit = input.reactionRoleLimit; }
  for (const key of ["ticketTranscriptsEnabled", "suggestionAnonymousEnabled", "starboardAllowNsfw"]) if (input[key] === true && !plus) throw new TypeError(`${key} requires Duck Plus.`);
  for (const key of ["autoroleRoleIds", "levelIgnoredChannelIds"]) if (key in input) { const max = key === "autoroleRoleIds" ? (plus ? 5 : 1) : 25; if (!Array.isArray(input[key]) || input[key].length > max || input[key].some((id) => typeof id !== "string" || !/^\d{10,}$/.test(id))) throw new TypeError(`${key} must contain up to ${max} Discord IDs.`); patch[key] = [...new Set(input[key])]; }
  if ("levelRewards" in input) { if (!plus && input.levelRewards?.length) throw new TypeError("Level reward roles require Duck Plus."); if (!Array.isArray(input.levelRewards) || input.levelRewards.length > 10) throw new TypeError("Level rewards must contain up to 10 entries."); patch.levelRewards = input.levelRewards.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["level", "roleId"].includes(key)) || !Number.isInteger(item.level) || item.level < 1 || item.level > 100 || !/^\d{10,}$/.test(item.roleId || "")) throw new TypeError("Each level reward needs a level from 1-100 and a role."); return { level: item.level, roleId: item.roleId }; }); if (new Set(patch.levelRewards.map(({ level }) => level)).size !== patch.levelRewards.length) throw new TypeError("Level rewards cannot repeat a level."); }
  if ("starboardThreshold" in input) { if (!Number.isInteger(input.starboardThreshold) || input.starboardThreshold < 2 || input.starboardThreshold > 50) throw new TypeError("Starboard threshold must be 2-50."); patch.starboardThreshold = input.starboardThreshold; }
  if ("starboardEmoji" in input) { if (typeof input.starboardEmoji !== "string" || !input.starboardEmoji.trim() || input.starboardEmoji.trim().length > 32) throw new TypeError("Starboard emoji is invalid."); if (input.starboardEmoji.trim() !== "⭐" && !plus) throw new TypeError("Custom starboard emoji requires Duck Plus."); patch.starboardEmoji = input.starboardEmoji.trim(); }
  if ("starboardColor" in input) { if (typeof input.starboardColor !== "string" || !/^#[0-9a-f]{6}$/i.test(input.starboardColor)) throw new TypeError("Starboard color must be a hex color."); if (input.starboardColor.toLowerCase() !== "#f2c85b" && !plus) throw new TypeError("Custom starboard color requires Duck Plus."); patch.starboardColor = Number.parseInt(input.starboardColor.slice(1), 16); }
  if ("scheduledPosts" in input) { if (!plus && input.scheduledPosts?.length) throw new TypeError("Scheduled pond posts require Duck Plus."); if (!Array.isArray(input.scheduledPosts) || input.scheduledPosts.length > 10) throw new TypeError("Scheduled posts must contain up to 10 entries."); patch.scheduledPosts = input.scheduledPosts.map((item, index) => { const keys = new Set(["id", "name", "enabled", "channelId", "intervalMinutes", "message"]); if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !keys.has(key)) || !/^[a-zA-Z0-9_-]{1,36}$/.test(item.id || "") || typeof item.name !== "string" || typeof item.enabled !== "boolean" || !/^\d{10,}$/.test(item.channelId || "") || !Number.isInteger(item.intervalMinutes) || item.intervalMinutes < 15 || item.intervalMinutes > 10_080 || typeof item.message !== "string") throw new TypeError(`Scheduled post ${index + 1} is invalid.`); const name = item.name.trim(); const message = item.message.trim(); if (!name || name.length > 60 || !message || message.length > 1_000) throw new TypeError(`Scheduled post ${index + 1} has invalid text.`); return { id: item.id, name, enabled: item.enabled, channelId: item.channelId, intervalMinutes: item.intervalMinutes, message }; }); if (new Set(patch.scheduledPosts.map(({ id }) => id)).size !== patch.scheduledPosts.length) throw new TypeError("Scheduled post IDs must be unique."); }
  for (const [key, max, fallback] of [["colorRoleTitle", 100, "Duck Color Dock"], ["colorRoleDescription", 500, "Pick one color for your name."]]) if (key in input) { if (typeof input[key] !== "string") throw new TypeError(`${key} must be text.`); patch[key] = input[key].trim().slice(0, max) || fallback; }
  if ("colorRoleAccent" in input) { if (typeof input.colorRoleAccent !== "string" || !/^#[0-9a-f]{6}$/i.test(input.colorRoleAccent)) throw new TypeError("Color Dock accent must be a hex color."); patch.colorRoleAccent = Number.parseInt(input.colorRoleAccent.slice(1), 16); }
  if (input.colorRoleRandomOnJoin === true && !plus) throw new TypeError("Random join color assignment requires Duck Plus.");
  if ("colorRoleOptions" in input) { const limit = plus ? 30 : 12; if (!Array.isArray(input.colorRoleOptions) || input.colorRoleOptions.length > limit) throw new TypeError(`Color Dock supports up to ${limit} colors on this plan.`); patch.colorRoleOptions = input.colorRoleOptions.map((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["roleId", "label", "color"].includes(key)) || (item.roleId !== null && !/^\d{10,}$/.test(item.roleId || "")) || typeof item.label !== "string" || typeof item.color !== "string" || !/^#[0-9a-f]{6}$/i.test(item.color)) throw new TypeError(`Color ${index + 1} is invalid.`); const label = item.label.trim(); if (!label || label.length > 80) throw new TypeError(`Color ${index + 1} needs a label of 1-80 characters.`); return { roleId: item.roleId, label, color: Number.parseInt(item.color.slice(1), 16) }; }); if (new Set(patch.colorRoleOptions.map(({ label }) => label.toLocaleLowerCase("en-US"))).size !== patch.colorRoleOptions.length) throw new TypeError("Color labels must be unique."); const assignedRoleIds = patch.colorRoleOptions.map(({ roleId }) => roleId).filter(Boolean); if (new Set(assignedRoleIds).size !== assignedRoleIds.length) throw new TypeError("A Discord role cannot appear twice in Color Dock."); }
  if ("automodCustomWords" in input) {
    if (!Array.isArray(input.automodCustomWords) || input.automodCustomWords.length > 100) throw new TypeError("Custom words must be a list of up to 100 entries.");
    if (input.automodCustomWords.some((value) => typeof value !== "string")) throw new TypeError("Every custom word must be text.");
    if (!hasPlusEntitlement(current, now) && input.automodCustomWords.length) { const error = new Error("Custom AutoMod words require Duck Plus."); error.code = "plus_required"; throw error; }
    const words = [...new Set(input.automodCustomWords.map((value) => value.trim().toLocaleLowerCase("en-US")).filter(Boolean))];
    if (words.some((value) => value.length > 40)) throw new TypeError("Each custom word must be 40 characters or fewer.");
    patch.automodCustomWords = words;
  }
  for (const key of ["automodViolationsBeforeWarn", "automodWarningsBeforeAction"]) if (key in input) { if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 20) throw new TypeError(`${key} must be an integer from 1 to 20.`); patch[key] = input[key]; }
  if ("automodEscalation" in input) { if (!["kick", "softban"].includes(input.automodEscalation)) throw new TypeError("Unsupported AutoMod escalation."); patch.automodEscalation = input.automodEscalation; }
  if ("automodGlobalSlowmodeSeconds" in input) { if (!Number.isInteger(input.automodGlobalSlowmodeSeconds) || input.automodGlobalSlowmodeSeconds < 0 || input.automodGlobalSlowmodeSeconds > 21_600) throw new TypeError("Global rate guard must be 0-21600 seconds."); patch.automodGlobalSlowmodeSeconds = input.automodGlobalSlowmodeSeconds; }
  if ("automodChannelSlowmodes" in input) {
    if (!Array.isArray(input.automodChannelSlowmodes) || input.automodChannelSlowmodes.length > 50) throw new TypeError("Channel rate guards must be a list of up to 50 channels.");
    patch.automodChannelSlowmodes = input.automodChannelSlowmodes.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["channelId", "seconds"].includes(key)) || typeof item.channelId !== "string" || !/^\d{10,}$/.test(item.channelId) || !Number.isInteger(item.seconds) || item.seconds < 0 || item.seconds > 21_600) throw new TypeError("Each channel rate guard needs a valid channel and 0-21600 seconds."); return { channelId: item.channelId, seconds: item.seconds }; });
    if (new Set(patch.automodChannelSlowmodes.map(({ channelId }) => channelId)).size !== patch.automodChannelSlowmodes.length) throw new TypeError("Channel rate guards cannot contain duplicate channels.");
  }
  if ("customActions" in input) {
    if (!Array.isArray(input.customActions)) throw new TypeError("Custom actions must be a list.");
    const loyalty = getPlusLoyalty(current, now); if (loyalty.customActionLimit !== null && input.customActions.length > loyalty.customActionLimit) throw new TypeError(`This server can have up to ${loyalty.customActionLimit} custom actions.`);
    patch.customActions = input.customActions.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`Custom action ${index + 1} is invalid.`);
      const actionKeys = new Set(["id", "name", "enabled", "triggerType", "triggerValue", "channelId", "userId", "actionType", "response"]); if (Object.keys(item).some((key) => !actionKeys.has(key))) throw new TypeError(`Custom action ${index + 1} has an unknown field.`);
      if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,36}$/.test(item.id)) throw new TypeError(`Custom action ${index + 1} needs a valid ID.`);
      if (typeof item.name !== "string" || ("enabled" in item && typeof item.enabled !== "boolean")) throw new TypeError(`Custom action ${index + 1} has invalid types.`);
      const name = item.name.trim(); if (!name || name.length > 40) throw new TypeError(`Custom action ${index + 1} needs a 1-40 character name.`);
      if (!CUSTOM_ACTION_TRIGGERS.has(item.triggerType) || !CUSTOM_ACTION_TYPES.has(item.actionType)) throw new TypeError(`Custom action ${index + 1} has an unsupported trigger or action.`);
      if (["warn", "timeout", "kick", "softban"].includes(item.actionType) && !hasPlusEntitlement(current, now)) { const error = new Error("Automated moderation actions require Duck Plus."); error.code = "plus_required"; throw error; }
      if (typeof item.triggerValue !== "string" || typeof item.response !== "string") throw new TypeError(`Custom action ${index + 1} trigger and response must be text.`);
      const triggerValue = item.triggerValue.trim(); if (item.triggerType !== "message" && (!triggerValue || triggerValue.length > 80)) throw new TypeError(`Custom action ${index + 1} needs a 1-80 character trigger.`);
      const response = item.response.trim(); if (["reply", "react"].includes(item.actionType) && (!response || response.length > 500)) throw new TypeError(`Custom action ${index + 1} needs a bounded response.`);
      if ((item.channelId != null && typeof item.channelId !== "string") || (item.userId != null && typeof item.userId !== "string")) throw new TypeError(`Custom action ${index + 1} channel and user IDs must be text.`);
      const channelId = item.channelId || null; const userId = item.userId || null;
      if (channelId && !/^\d{10,}$/.test(channelId)) throw new TypeError(`Custom action ${index + 1} has an invalid channel.`);
      if (userId && !/^\d{10,}$/.test(userId)) throw new TypeError(`Custom action ${index + 1} has an invalid user.`);
      return { id: item.id, name, enabled: item.enabled !== false, triggerType: item.triggerType, triggerValue, channelId, userId, actionType: item.actionType, response };
    });
    if (new Set(patch.customActions.map(({ id }) => id)).size !== patch.customActions.length) throw new TypeError("Custom action IDs must be unique.");
  }
  for (const command of FUN_COMMANDS) {
    if (command.tier === "plus" && input[command.key] === true && !hasPlusEntitlement(current, now)) {
      const error = new Error(`${command.label} requires Duck Plus.`);
      error.code = "plus_required";
      throw error;
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
    const model = TTS_MODELS.find(({ id }) => id === input.ttsModel);
    if (!model || !TTS_MODEL_IDS.has(input.ttsModel)) throw new TypeError("Unsupported TTS model.");
    if (model.tier === "plus" && !hasPlusEntitlement(current, now)) {
      const error = new Error("ElevenLabs TTS requires Duck Plus.");
      error.code = "plus_required";
      throw error;
    }
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
    if (typeof input.aiPersonality !== "string") throw new TypeError("AI personality must be text.");
    const personality = input.aiPersonality.trim();
    if (personality.length > 240) throw new TypeError("AI personality must be 240 characters or fewer.");
    patch.aiPersonality = personality;
  }
  if ("capabilityMode" in input) {
    if (!CAPABILITY_MODES.has(input.capabilityMode)) throw new TypeError("Unsupported approval mode.");
    patch.capabilityMode = input.capabilityMode;
  }
  if ("commandPrefix" in input) {
    if (typeof input.commandPrefix !== "string") throw new TypeError("Prefix must be text.");
    const prefix = input.commandPrefix;
    if (!/^\S{1,5}$/u.test(prefix) || /[@#`]/u.test(prefix)) throw new TypeError("Prefix must be 1-5 non-space characters and cannot contain @, #, or `.");
    patch.commandPrefix = prefix;
  }
  for (const key of ["modChannelId", "welcomeChannelId"]) {
    if (key in input) {
      if (input[key] !== null && (typeof input[key] !== "string" || !/^\d{10,}$/.test(input[key]))) throw new TypeError(`${key} must be a Discord channel ID or null.`);
      patch[key] = input[key];
    }
  }
  if ("logChannelId" in input) {
    if (input.logChannelId !== null && (typeof input.logChannelId !== "string" || !/^\d{10,}$/.test(input.logChannelId))) throw new TypeError("logChannelId must be a Discord channel ID or null.");
    patch.entryChannels = { ...(current.entryChannels || {}), logChannelId: input.logChannelId };
  }
  for (const key of ["welcomeMessage", "farewellMessage"]) {
    if (key in input) {
      if (typeof input[key] !== "string") throw new TypeError(`${key} must be text.`);
      const value = input[key].trim();
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
  FUN_COMMANDS,
  getFunCommandAccess,
  getAiModelDefinition,
  getDefaultAiModel,
  getPublicGuildSettings,
  getPublicModelCatalog,
  getPlusLoyalty,
  getBrandingEligibleAt,
  hasMaturePlusEntitlement,
  hasPlusEntitlement,
  makeSettingsPatch,
};
