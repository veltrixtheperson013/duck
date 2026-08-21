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
]);

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
  const paid = plus && subscription.provider === "stripe";
  const startedAt = paid ? Date.parse(subscription.startedAt || "") : NaN;
  const threeAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 3) || "") : NaN;
  const sixAt = paid ? Date.parse(addSubscriptionMonths(subscription.startedAt, 6) || "") : NaN;
  const months = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / (30.4375 * 24 * 60 * 60_000))) : 0;
  const level = !plus ? "free" : Number.isFinite(sixAt) && now >= sixAt ? "plus_6" : Number.isFinite(threeAt) && now >= threeAt ? "plus_3" : "plus";
  const customActionLimit = level === "plus_6" ? null : level === "plus_3" ? 50 : plus ? 25 : 5;
  const memoryReplies = level === "plus_6" ? 50 : level === "plus_3" ? 30 : plus ? 16 : 6;
  const nextAt = level === "plus" && Number.isFinite(threeAt) ? new Date(threeAt).toISOString() : level === "plus_3" && Number.isFinite(sixAt) ? new Date(sixAt).toISOString() : null;
  const progressStart = level === "plus" ? startedAt : level === "plus_3" ? threeAt : NaN;
  const progressEnd = level === "plus" ? threeAt : level === "plus_3" ? sixAt : NaN;
  const progress = Number.isFinite(progressStart) && Number.isFinite(progressEnd) ? Math.max(0, Math.min(1, (now - progressStart) / (progressEnd - progressStart))) : level === "plus_6" ? 1 : 0;
  return { level, paid, months, startedAt: paid ? subscription.startedAt : null, nextAt, progress, customActionLimit, memoryReplies };
}

function hasMaturePlusEntitlement(settings, now = Date.now()) {
  if (!hasPlusEntitlement(settings, now) || settings?.subscription?.provider !== "stripe") return false;
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
    reactionRoleOptions: Array.isArray(settings.reactionRoleOptions) ? settings.reactionRoleOptions.slice(0, 10) : [],
    ticketsEnabled: settings.ticketsEnabled === true,
    ticketPanelChannelId: /^\d{10,}$/.test(settings.ticketPanelChannelId || "") ? settings.ticketPanelChannelId : null,
    ticketCategoryId: /^\d{10,}$/.test(settings.ticketCategoryId || "") ? settings.ticketCategoryId : null,
    ticketSupportRoleId: /^\d{10,}$/.test(settings.ticketSupportRoleId || "") ? settings.ticketSupportRoleId : null,
    ticketAdminRoleId: /^\d{10,}$/.test(settings.ticketAdminRoleId || "") ? settings.ticketAdminRoleId : null,
    ticketPanelTitle: typeof settings.ticketPanelTitle === "string" ? settings.ticketPanelTitle : "Duck Support",
    ticketOptions: Array.isArray(settings.ticketOptions) ? settings.ticketOptions.slice(0, 5) : [],
    customActions,
    loyalty,
    subscription: {
      tier: plus ? "plus" : "free",
      status: plus ? subscription.status : "inactive",
      source: plus && subscription.provider === "owner" ? "owner" : plus ? "stripe" : null,
      expiresAt: plus ? subscription.expiresAt ?? null : null,
      cancelAtPeriodEnd: plus ? Boolean(subscription.cancelAtPeriodEnd) : false,
      brandingEligible: hasMaturePlusEntitlement(settings, now),
      brandingEligibleAt: plus ? getBrandingEligibleAt(settings) : null,
    },
  };
}

function makeSettingsPatch(current, input, configuredModel = "", now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings must be a JSON object.");
  const allowed = new Set(["aiChatEnabled", "aiModel", "aiVisionEnabled", "aiContextMode", "aiResponseStyle", "aiChannelMode", "aiPersonality", "aiScanEnabled", "aiScanChannelIds", "aiScanFlagChannelId", "aiScanRulesChannelId", "aiScanSensitivity", "reactionRolesEnabled", "reactionRoleChannelId", "reactionRoleTitle", "reactionRoleOptions", "ticketsEnabled", "ticketPanelChannelId", "ticketCategoryId", "ticketSupportRoleId", "ticketAdminRoleId", "ticketPanelTitle", "ticketOptions", "ttsEnabled", "ttsModel", "ttsAnnounceNames", "capabilityMode", "commandPrefix", "modChannelId", "welcomeChannelId", "welcomeMessage", "farewellMessage", "logChannelId", "funCommandsEnabled", "automodEnabled", "automodHoneypotEnabled", "automodHoneypotChannelId", "automodSwearFilter", "automodNsfwFilter", "automodInviteFilter", "automodCapsFilter", "automodMentionLimit", "automodCustomWords", "automodViolationsBeforeWarn", "automodWarningsBeforeAction", "automodEscalation", "automodGlobalSlowmodeSeconds", "automodChannelSlowmodes", "customActions", ...FUN_COMMANDS.map(({ key }) => key)]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unknown setting.");
  const patch = {};
  for (const key of ["aiChatEnabled", "aiVisionEnabled", "aiScanEnabled", "reactionRolesEnabled", "ticketsEnabled", "ttsEnabled", "ttsAnnounceNames", "funCommandsEnabled", "automodEnabled", "automodHoneypotEnabled", "automodSwearFilter", "automodNsfwFilter", "automodInviteFilter", "automodCapsFilter", ...FUN_COMMANDS.map(({ key }) => key)]) {
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
  for (const key of ["reactionRoleChannelId", "ticketPanelChannelId", "ticketCategoryId", "ticketSupportRoleId", "ticketAdminRoleId"]) if (key in input) { if (input[key] !== null && (typeof input[key] !== "string" || !/^\d{10,}$/.test(input[key]))) throw new TypeError(`${key} must be a Discord ID or null.`); patch[key] = input[key]; }
  for (const [key, max, fallback] of [["reactionRoleTitle", 100, "Choose your roles"], ["ticketPanelTitle", 100, "Duck Support"]]) if (key in input) { if (typeof input[key] !== "string") throw new TypeError(`${key} must be text.`); patch[key] = input[key].trim().slice(0, max) || fallback; }
  if ("reactionRoleOptions" in input) {
    if (!Array.isArray(input.reactionRoleOptions) || input.reactionRoleOptions.length > 10) throw new TypeError("Reaction roles must contain up to 10 options.");
    patch.reactionRoleOptions = input.reactionRoleOptions.map((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["roleId", "label", "emoji"].includes(key)) || !/^\d{10,}$/.test(item.roleId || "") || typeof item.label !== "string" || typeof item.emoji !== "string") throw new TypeError(`Reaction role ${index + 1} is invalid.`); const label = item.label.trim(); const emoji = item.emoji.trim(); if (!label || label.length > 80 || emoji.length > 32) throw new TypeError(`Reaction role ${index + 1} has invalid text.`); return { roleId: item.roleId, label, emoji }; });
  }
  if ("ticketOptions" in input) {
    if (!Array.isArray(input.ticketOptions) || input.ticketOptions.length > 5) throw new TypeError("Tickets must contain up to 5 options.");
    patch.ticketOptions = input.ticketOptions.map((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "label", "description", "emoji"].includes(key)) || !/^[a-z0-9_-]{1,24}$/.test(item.id || "") || typeof item.label !== "string" || typeof item.description !== "string" || typeof item.emoji !== "string") throw new TypeError(`Ticket option ${index + 1} is invalid.`); const label = item.label.trim(); const description = item.description.trim(); const emoji = item.emoji.trim(); if (!label || label.length > 80 || description.length > 200 || emoji.length > 32) throw new TypeError(`Ticket option ${index + 1} has invalid text.`); return { id: item.id, label, description, emoji }; });
  }
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
