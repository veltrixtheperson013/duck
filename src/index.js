import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ActivityType,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

const dataDir = path.join(process.cwd(), "data");
const settingsPath = path.join(dataDir, "settings.json");
const pendingActionsPath = path.join(dataDir, "pending-actions.json");
const warningsPath = path.join(dataDir, "warnings.json");
const quotesPath = path.join(dataDir, "quotes.json");

const pendingActions = new Map();
const pendingByChannel = new Map();
const pendingExpiryTimers = new Map();
const serverContextCache = new Map();
const messageHistoryCache = new Map();
const resourceFetchCache = new Map();
const jsonFileCache = new Map();
const pendingJsonWrites = new Map();
let cacheMaintenanceTimer = null;
let packageInfo = { name: "duck-discord-ai-moderator", version: "unknown" };
let buildInfo = {
  commit: process.env.DUCK_COMMIT || process.env.COMMIT_SHA || process.env.GIT_COMMIT || "unknown",
  commitName: process.env.DUCK_COMMIT_NAME || process.env.COMMIT_MESSAGE || "unknown",
  branch: process.env.DUCK_BRANCH || process.env.BRANCH || process.env.GIT_BRANCH || "unknown",
};

try {
  packageInfo = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
} catch {
  // Version logging is best-effort.
}

function isDebugEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.DUCK_DEBUG || "true");
}

function shouldLogAiBodies() {
  return /^(1|true|yes|on)$/i.test(process.env.DUCK_DEBUG_AI_BODY || "");
}

function timestamp() {
  return new Date().toISOString();
}

function redact(value) {
  if (value == null) return value;
  const text = String(value);
  if (!text || /^(optional_|your_|placeholder)/i.test(text)) return text;
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function logInfo(event, details = {}) {
  console.log(`[${timestamp()}] [duck] ${event}`, details);
}

function logDebug(event, details = {}) {
  if (isDebugEnabled()) {
    console.log(`[${timestamp()}] [duck:debug] ${event}`, details);
  }
}

function logWarn(event, details = {}) {
  console.warn(`[${timestamp()}] [duck:warn] ${event}`, details);
}

function logError(event, err, details = {}) {
  console.error(`[${timestamp()}] [duck:error] ${event}`, {
    ...details,
    error: err?.stack || err?.message || String(err),
  });
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function limitDiscordContent(content, maxLength = 1900) {
  const text = String(content ?? "").trim();
  if (!text) return "Duck has nothing to send.";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20).trim()}...`;
}

function splitDiscordLines(lines, maxLength = 1900) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const safeLine = limitDiscordContent(line, maxLength);
    const next = current ? `${current}\n${safeLine}` : safeLine;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = safeLine;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : ["Duck has nothing to send."];
}

function readGitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function loadBuildInfo() {
  const commit = readGitValue(["rev-parse", "--short", "HEAD"]);
  const commitName = readGitValue(["log", "-1", "--pretty=%s"]);
  const branch = readGitValue(["branch", "--show-current"]);

  buildInfo = {
    commit: commit || buildInfo.commit,
    commitName: commitName || buildInfo.commitName,
    branch: branch || buildInfo.branch,
  };
}

class AiServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AiServiceError";
    this.details = details;
  }
}

function makeAiUserError(err, fallback = "AI failed before it could answer.") {
  if (err instanceof AiServiceError) return err.message;
  return fallback;
}

const TOOL_DEFINITIONS = [
  {
    name: "ban_member",
    risk: "high",
    description: "Ban a mentioned server member.",
  },
  {
    name: "kick_member",
    risk: "high",
    description: "Kick a mentioned server member.",
  },
  {
    name: "timeout_member",
    risk: "medium",
    description: "Temporarily timeout a mentioned server member.",
  },
  {
    name: "delete_channel",
    risk: "critical",
    description: "Delete a server channel only when the request explicitly mentions the channel, gives its ID, or uses its exact name. Administrator confirmation required.",
  },
  {
    name: "purge_messages",
    risk: "medium",
    description: "Bulk delete recent messages in the current channel.",
  },
  {
    name: "grep_messages",
    risk: "medium",
    description: "Search recent readable messages in the current or mentioned text channel for keywords.",
  },
  {
    name: "warn_member",
    risk: "medium",
    description: "Warn a mentioned server member, store the warning, and direct message them when possible.",
  },
  {
    name: "view_warnings",
    risk: "medium",
    description: "Show stored warnings for a mentioned server member.",
  },
  {
    name: "clear_warnings",
    risk: "medium",
    description: "Clear a requested number of stored warnings for a mentioned server member.",
  },
  {
    name: "untimeout_member",
    risk: "medium",
    description: "Remove timeout from a mentioned server member.",
  },
  {
    name: "set_slowmode",
    risk: "medium",
    description: "Set slowmode for the current or mentioned text channel.",
  },
  {
    name: "lock_channel",
    risk: "high",
    description: "Stop @everyone from sending messages in the current or mentioned channel.",
  },
  {
    name: "unlock_channel",
    risk: "high",
    description: "Allow @everyone to send messages again in the current or mentioned channel.",
  },
  {
    name: "softban_member",
    risk: "high",
    description: "Ban and immediately unban a mentioned member to remove recent messages.",
  },
  {
    name: "delete_user_messages",
    risk: "medium",
    description: "Delete recent messages by a mentioned member in the current channel.",
  },
  {
    name: "set_nickname",
    risk: "medium",
    description: "Change a mentioned member's server nickname.",
  },
  {
    name: "add_role",
    risk: "high",
    description: "Add a server role to a mentioned member.",
  },
  {
    name: "remove_role",
    risk: "high",
    description: "Remove a server role from a mentioned member.",
  },
  {
    name: "disconnect_member",
    risk: "medium",
    description: "Disconnect a mentioned member from voice.",
  },
  {
    name: "move_member",
    risk: "medium",
    description: "Move a mentioned member to a mentioned voice channel.",
  },
  {
    name: "voice_mute_member",
    risk: "medium",
    description: "Server-mute a mentioned member in voice.",
  },
  {
    name: "voice_unmute_member",
    risk: "medium",
    description: "Remove server voice mute from a mentioned member.",
  },
  {
    name: "deafen_member",
    risk: "medium",
    description: "Server-deafen a mentioned member in voice.",
  },
  {
    name: "undeafen_member",
    risk: "medium",
    description: "Remove server deafen from a mentioned member.",
  },
  {
    name: "create_text_channel",
    risk: "high",
    description: "Create a text channel.",
  },
  {
    name: "create_voice_channel",
    risk: "high",
    description: "Create a voice channel.",
  },
  {
    name: "rename_channel",
    risk: "high",
    description: "Rename a text or voice channel.",
  },
  {
    name: "set_channel_topic",
    risk: "medium",
    description: "Set a text channel topic.",
  },
  {
    name: "speak",
    risk: "medium",
    description: "Send an approved message as Duck in the current or mentioned text channel.",
  },
  {
    name: "pin_message",
    risk: "medium",
    description: "Pin a replied-to or specified message in a text channel.",
  },
  {
    name: "unpin_message",
    risk: "medium",
    description: "Unpin a replied-to or specified message in a text channel.",
  },
  {
    name: "create_thread",
    risk: "medium",
    description: "Create a public thread in the current or mentioned text channel.",
  },
  {
    name: "set_role_color",
    risk: "high",
    description: "Change an editable role color.",
  },
  {
    name: "create_poll",
    risk: "medium",
    description: "Create a simple reaction poll in a text channel.",
  },
  {
    name: "create_role",
    risk: "high",
    description: "Create a server role.",
  },
  {
    name: "delete_role",
    risk: "high",
    description: "Delete a server role.",
  },
];

const UTILITY_COMMANDS = [
  "`duck userinfo @user` / `duck whois @user`",
  "`duck avatar @user`",
  "`duck serverinfo`",
  "`duck channelinfo #channel`",
  "`duck roleinfo @role`",
  "`duck warnings @user`",
  "`duck poll \"Question\" \"Option A\" \"Option B\"`",
  "Reply with `duck pin this` / `duck unpin this`",
  "`duck create thread \"topic\" in #channel`",
  "`duck set @role color #3B82F6`",
  "`duck quote` / `duck quote add <text>` / `duck quote list`",
  "`duck ship @user [@user]`",
  "`duck curse [@user]`",
  "`duck spinwheel pizza, tacos, sushi`",
  "`duck remind 10m check the logs`",
  "`duck rules`",
  "`duck ping`",
  "`duck botinfo`",
];

const DEFAULT_QUOTES = [
  "Silence is golden. Duct tape is silver.",
  "I'm not arguing, I'm just explaining why I'm right.",
  "Common sense is not a super power. It's just not common.",
];

const CURSES = [
  "may your next click always land 1px off the button you meant.",
  "may your chat always say 'typing...' right when you have nothing left to say.",
  "may your food always be one bite too hot.",
  "may you forever queue behind the slowest walker in every hallway.",
  "may your phone always be at 12% with no charger in sight.",
];

const BLESSINGS = [
  "may every green light be in your favor today.",
  "may your snacks always be perfectly portioned.",
  "may your wifi never lag mid-clutch.",
  "may your favorite song always play at the right moment.",
];

let keepAliveServer = null;
let inviteCleanupTimer = null;

const TOOL_REQUIREMENTS = {
  ban_member: PermissionsBitField.Flags.BanMembers,
  kick_member: PermissionsBitField.Flags.KickMembers,
  timeout_member: PermissionsBitField.Flags.ModerateMembers,
  delete_channel: PermissionsBitField.Flags.ManageChannels,
  purge_messages: PermissionsBitField.Flags.ManageMessages,
  grep_messages: PermissionsBitField.Flags.ReadMessageHistory,
  warn_member: PermissionsBitField.Flags.ModerateMembers,
  view_warnings: PermissionsBitField.Flags.ModerateMembers,
  clear_warnings: PermissionsBitField.Flags.ModerateMembers,
  untimeout_member: PermissionsBitField.Flags.ModerateMembers,
  set_slowmode: PermissionsBitField.Flags.ManageChannels,
  lock_channel: PermissionsBitField.Flags.ManageChannels,
  unlock_channel: PermissionsBitField.Flags.ManageChannels,
  softban_member: PermissionsBitField.Flags.BanMembers,
  delete_user_messages: PermissionsBitField.Flags.ManageMessages,
  set_nickname: PermissionsBitField.Flags.ManageNicknames,
  add_role: PermissionsBitField.Flags.ManageRoles,
  remove_role: PermissionsBitField.Flags.ManageRoles,
  disconnect_member: PermissionsBitField.Flags.MoveMembers,
  move_member: PermissionsBitField.Flags.MoveMembers,
  voice_mute_member: PermissionsBitField.Flags.MuteMembers,
  voice_unmute_member: PermissionsBitField.Flags.MuteMembers,
  deafen_member: PermissionsBitField.Flags.DeafenMembers,
  undeafen_member: PermissionsBitField.Flags.DeafenMembers,
  create_text_channel: PermissionsBitField.Flags.ManageChannels,
  create_voice_channel: PermissionsBitField.Flags.ManageChannels,
  rename_channel: PermissionsBitField.Flags.ManageChannels,
  set_channel_topic: PermissionsBitField.Flags.ManageChannels,
  speak: PermissionsBitField.Flags.SendMessages,
  pin_message: PermissionsBitField.Flags.ManageMessages,
  unpin_message: PermissionsBitField.Flags.ManageMessages,
  create_thread: [PermissionsBitField.Flags.CreatePublicThreads, PermissionsBitField.Flags.SendMessages],
  set_role_color: PermissionsBitField.Flags.ManageRoles,
  create_poll: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AddReactions],
  create_role: PermissionsBitField.Flags.ManageRoles,
  delete_role: PermissionsBitField.Flags.ManageRoles,
};

const RISK_COPY = {
  medium: "This action needs Administrator confirmation before I do anything.",
  high: "This moderation action needs Administrator confirmation before I do anything.",
  critical: "I'm sorry, I need approval from a person that has Administrator.",
};

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  let loaded = 0;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const splitAt = trimmed.indexOf("=");
    if (splitAt === -1) continue;

    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  logDebug("dotenv.loaded", { path: envPath, keys: loaded });
}

function loadJsonConfig() {
  const configPath = path.join(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    let loaded = 0;
    for (const [key, value] of Object.entries(config)) {
      if (process.env[key] == null && typeof value === "string") {
        process.env[key] = value;
        loaded += 1;
      }
    }
    logDebug("config-json.loaded", { path: configPath, keys: loaded });
  } catch (err) {
    throw new Error(`Could not read config.json: ${err.message}`);
  }
}

function loadSettings() {
  const settings = loadJsonFile(settingsPath, { guilds: {} });
  settings.guilds ??= {};
  return settings;
}

function saveSettings(settings) {
  saveJsonFile(settingsPath, settings);
}

function loadJsonFile(filePath, fallback) {
  if (jsonFileCache.has(filePath)) return jsonFileCache.get(filePath);

  try {
    const loaded = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
    jsonFileCache.set(filePath, loaded);
    return loaded;
  } catch {
    jsonFileCache.set(filePath, fallback);
    return fallback;
  }
}

function writeJsonFileNow(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getJsonWriteDebounceMs() {
  return Math.max(0, Math.min(Number(process.env.DUCK_JSON_WRITE_DEBOUNCE_MS) || 500, 10_000));
}

function saveJsonFile(filePath, data, options = {}) {
  jsonFileCache.set(filePath, data);
  const debounceMs = options.immediate ? 0 : getJsonWriteDebounceMs();
  const pending = pendingJsonWrites.get(filePath);
  if (pending?.timer) clearTimeout(pending.timer);

  if (debounceMs <= 0) {
    writeJsonFileNow(filePath, data);
    pendingJsonWrites.delete(filePath);
    return;
  }

  const timer = setTimeout(() => {
    const latest = pendingJsonWrites.get(filePath)?.data ?? jsonFileCache.get(filePath);
    writeJsonFileNow(filePath, latest);
    pendingJsonWrites.delete(filePath);
  }, debounceMs);
  pendingJsonWrites.set(filePath, { data, timer });
}

function flushJsonWrites() {
  for (const [filePath, pending] of pendingJsonWrites.entries()) {
    if (pending.timer) clearTimeout(pending.timer);
    writeJsonFileNow(filePath, pending.data);
    pendingJsonWrites.delete(filePath);
  }
}

function loadWarnings() {
  const warnings = loadJsonFile(warningsPath, { guilds: {} });
  warnings.guilds ??= {};
  return warnings;
}

function saveWarnings(warnings) {
  saveJsonFile(warningsPath, warnings);
}

function getMemberWarnings(guildId, memberId) {
  const warnings = loadWarnings();
  return [...(warnings.guilds?.[guildId]?.[memberId] ?? [])];
}

function addMemberWarning(guildId, memberId, warning) {
  const warnings = loadWarnings();
  warnings.guilds[guildId] ??= {};
  warnings.guilds[guildId][memberId] ??= [];
  warnings.guilds[guildId][memberId].push(warning);
  saveWarnings(warnings);
  return warnings.guilds[guildId][memberId].length;
}

function clearMemberWarnings(guildId, memberId, count) {
  const warnings = loadWarnings();
  const memberWarnings = warnings.guilds?.[guildId]?.[memberId] ?? [];
  const removedCount = Math.min(memberWarnings.length, count);
  if (removedCount <= 0) return { removedCount: 0, remainingCount: memberWarnings.length };

  memberWarnings.splice(Math.max(0, memberWarnings.length - removedCount), removedCount);
  if (memberWarnings.length === 0) {
    delete warnings.guilds[guildId][memberId];
  }
  saveWarnings(warnings);
  return { removedCount, remainingCount: memberWarnings.length };
}

function getPendingActionTtlMs() {
  return Math.max(60_000, Number(process.env.PENDING_ACTION_TTL_MS) || 30 * 60 * 1000);
}

function getServerContextCacheTtlMs() {
  return Math.max(0, Number(process.env.AI_CONTEXT_CACHE_TTL_MS) || 15_000);
}

function getAiContextMemberLimit() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MEMBER_LIMIT) || 500, 1000));
}

function getAiContextChannelLimit() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_CHANNEL_LIMIT) || 250, 500));
}

function getAiContextRoleLimit() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_ROLE_LIMIT) || 250, 500));
}

function getAiContextMessageChannelLimit() {
  if (/^all$/i.test(process.env.AI_CONTEXT_CHANNELS || "")) return 500;
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_CHANNELS) || 500, 500));
}

function getAiContextMaxChars() {
  return Math.max(8_000, Math.min(Number(process.env.AI_CONTEXT_MAX_CHARS) || 32_000, 120_000));
}

function getAiContextMessageChars() {
  return Math.max(60, Math.min(Number(process.env.AI_CONTEXT_MESSAGE_CHARS) || 160, 500));
}

function getMessageCacheTtlMs() {
  return Math.max(5_000, Math.min(Number(process.env.DUCK_MESSAGE_CACHE_TTL_MS) || 60_000, 10 * 60 * 1000));
}

function getMessageCacheLimit() {
  return Math.max(25, Math.min(Number(process.env.DUCK_MESSAGE_CACHE_LIMIT) || 150, 500));
}

function getQueueMessage() {
  return process.env.DUCK_QUEUE_MESSAGE || "Duck is thinking...";
}

function getEnvBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function getEnvId(name) {
  const value = String(process.env[name] || "").trim();
  return /^\d{10,}$/.test(value) ? value : null;
}

function getLegacyCommandPrefixes() {
  return (process.env.DUCK_LEGACY_PREFIXES || "!,!!")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function getLegacyCommandContent(content) {
  const prefixes = getLegacyCommandPrefixes();
  const prefix = prefixes.find((candidate) => content.startsWith(candidate));
  if (!prefix) return null;
  return content.slice(prefix.length).trim();
}

function getEntryChannelConfig(guildId) {
  const guildSettings = getGuildSettings(guildId);
  const saved = guildSettings.entryChannels ?? {};
  return {
    enabled: saved.enabled ?? getEnvBoolean("DUCK_CREATE_ENTRY_CHANNELS", false),
    categoryId: saved.categoryId ?? getEnvId("DUCK_ENTRY_CATEGORY_ID"),
    rulesUrl: saved.rulesUrl ?? process.env.DUCK_RULES_URL ?? "",
    announcementsUrl: saved.announcementsUrl ?? process.env.DUCK_ANNOUNCEMENTS_URL ?? "",
    logChannelId: saved.logChannelId ?? getEnvId("DUCK_LOG_CHANNEL_ID"),
  };
}

function updateEntryChannelConfig(guildId, patch) {
  const guildSettings = getGuildSettings(guildId);
  const current = guildSettings.entryChannels ?? {};
  updateGuildSettings(guildId, {
    entryChannels: {
      ...current,
      ...patch,
    },
  });
  return getEntryChannelConfig(guildId);
}

function getAiChatMaxTokens() {
  return Math.max(64, Math.min(Number(process.env.AI_CHAT_MAX_TOKENS) || 700, 4000));
}

function getAiChatMaxAttempts() {
  return Math.max(1, Math.min(Number(process.env.AI_CHAT_MAX_ATTEMPTS) || 3, 10));
}

function shouldExcludeReasoning(config) {
  if (/^(0|false|no|off)$/i.test(process.env.AI_EXCLUDE_REASONING || "")) return false;
  return config?.providerName === "OpenRouter" || /openrouter\.ai/i.test(config?.baseUrl || "");
}

function savePendingActions() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pendingActionsPath, JSON.stringify([...pendingActions.values()], null, 2));
  logDebug("pending-actions.saved", { count: pendingActions.size });
}

function getActionRequestChannelId(action) {
  return action.requestChannelId || action.channelId;
}

function schedulePendingExpiry(action) {
  if (pendingExpiryTimers.has(action.id)) {
    clearTimeout(pendingExpiryTimers.get(action.id));
  }

  const expiresAt = action.expiresAt ?? action.createdAt + getPendingActionTtlMs();
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    const requestChannelId = getActionRequestChannelId(action);
    logInfo("pending-action.expired", {
      actionId: action.id,
      tool: action.tool,
      requestChannelId,
      targetChannelId: action.channelId,
    });
    pendingActions.delete(action.id);
    pendingExpiryTimers.delete(action.id);
    if (pendingByChannel.get(requestChannelId) === action.id) {
      pendingByChannel.delete(requestChannelId);
    }
    savePendingActions();
  }, delay);

  pendingExpiryTimers.set(action.id, timer);
}

function rebuildPendingByChannel() {
  pendingByChannel.clear();
  const actions = [...pendingActions.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const action of actions) {
    pendingByChannel.set(getActionRequestChannelId(action), action.id);
  }
}

function loadPendingActions() {
  try {
    if (!fs.existsSync(pendingActionsPath)) return;

    const saved = JSON.parse(fs.readFileSync(pendingActionsPath, "utf8"));
    const now = Date.now();
    const ttl = getPendingActionTtlMs();

    let skipped = 0;
    for (const action of saved) {
      if (!action?.id || !action.guildId || !getActionRequestChannelId(action)) continue;

      const expiresAt = action.expiresAt ?? action.createdAt + ttl;
      if (expiresAt <= now) {
        skipped += 1;
        continue;
      }

      const hydrated = { ...action, requestChannelId: getActionRequestChannelId(action), expiresAt };
      pendingActions.set(hydrated.id, hydrated);
      schedulePendingExpiry(hydrated);
    }

    rebuildPendingByChannel();
    savePendingActions();
    logInfo("pending-actions.loaded", { restored: pendingActions.size, expiredSkipped: skipped });
  } catch (err) {
    logError("pending-actions.load-failed", err);
  }
}

function getGuildSettings(guildId) {
  const settings = loadSettings();
  settings.guilds[guildId] ??= {};
  return settings.guilds[guildId];
}

function updateGuildSettings(guildId, patch) {
  const settings = loadSettings();
  settings.guilds[guildId] = {
    ...(settings.guilds[guildId] ?? {}),
    ...patch,
  };
  saveSettings(settings);
}

function requireConfig() {
  loadDotEnv();
  loadJsonConfig();
  loadBuildInfo();
  logInfo("startup.config", {
    package: packageInfo.name,
    version: packageInfo.version,
    commit: buildInfo.commit,
    commitName: buildInfo.commitName,
    branch: buildInfo.branch,
    node: process.version,
    debug: isDebugEnabled(),
    aiProvider: process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "none"),
    openRouterModel: process.env.OPENROUTER_MODEL || null,
    openRouterKey: redact(process.env.OPENROUTER_API_KEY),
    contextChannels: process.env.AI_CONTEXT_CHANNELS || "all",
    contextMessagesPerChannel: process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL || "10",
    contextMaxMessages: process.env.AI_CONTEXT_MAX_MESSAGES || "500",
    contextCacheTtlMs: getServerContextCacheTtlMs(),
    contextMemberLimit: getAiContextMemberLimit(),
    contextChannelLimit: getAiContextChannelLimit(),
    contextRoleLimit: getAiContextRoleLimit(),
    contextMaxChars: getAiContextMaxChars(),
    contextMessageChars: getAiContextMessageChars(),
    chatMaxTokens: getAiChatMaxTokens(),
    chatMaxAttempts: getAiChatMaxAttempts(),
    excludeReasoning: !/^(0|false|no|off)$/i.test(process.env.AI_EXCLUDE_REASONING || "true"),
    pendingActionTtlMs: getPendingActionTtlMs(),
  });

  if (!process.env.DISCORD_TOKEN) {
    throw new Error("Missing DISCORD_TOKEN. Copy config.example.json to config.json and fill it in.");
  }

  if (!process.env.CLIENT_ID) {
    throw new Error("Missing CLIENT_ID. Copy config.example.json to config.json and fill it in.");
  }
}

function normalizeText(input) {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseDurationMs(text) {
  const match = text.match(/\b(\d{1,3})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (!match) return 10 * 60 * 1000;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith("s")) return amount * 1000;
  if (unit.startsWith("m")) return amount * 60 * 1000;
  if (unit.startsWith("h")) return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function parseSlowmodeSeconds(text) {
  const match = text.match(/\b(\d{1,4})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i);
  if (!match) return 5;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  let seconds = amount;

  if (unit.startsWith("m")) seconds = amount * 60;
  if (unit.startsWith("h")) seconds = amount * 60 * 60;

  return Math.max(0, Math.min(seconds, 21600));
}

function parseMessageCount(text, fallback = 10) {
  const match = text.match(/\b(\d{1,2})\b/);
  if (!match) return fallback;
  return Math.max(1, Math.min(Number(match[1]), 99));
}

function parseGrepResultCount(text, fallback = 10) {
  const match = text.match(/\b(?:limit|top|first|show)\s+(\d{1,2})\b/i) ?? text.match(/\b(\d{1,2})\s+(?:matches|results)\b/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(Number(match[1]), 20));
}

function parseWarningClearCount(text) {
  if (/\b(all|every)\b/i.test(text)) return "all";
  const match = text.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  return Math.max(1, Math.min(Number(match[1]), 999));
}

function extractQuotedName(text) {
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1].trim();
  return null;
}

function extractGrepQuery(text) {
  const quoted = extractQuotedName(text);
  if (quoted) return limitDiscordContent(quoted, 120);

  const match = text.match(/\b(?:grep|search|find|look\s+for)\b(?:\s+(?:messages?|chat|history))?(?:\s+(?:for|containing|with|about))?\s+(.+)$/i);
  const raw = (match?.[1] ?? text)
    .replace(/<#\d+>/g, " ")
    .replace(/\b(?:in|from)\s+#?[a-z0-9-_]+\b/gi, " ")
    .replace(/\b(?:limit|top|first|show)\s+\d{1,2}\b/gi, " ")
    .replace(/\b\d{1,2}\s+(?:matches|results)\b/gi, " ")
    .replace(/\b(?:grep|search|find|look\s+for|messages?|chat|history|for|containing|with|about|keyword|keywords)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return raw ? limitDiscordContent(raw, 120) : null;
}

function extractNickname(text) {
  const quoted = extractQuotedName(text);
  if (quoted) return quoted.slice(0, 32);

  const match = text.match(/\b(?:nickname|nick|rename)\b[^<@]*<@!?\d+>\s+(.+)$/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim().slice(0, 32) || null;
}

function extractReason(text, commandWords) {
  let reason = text;
  for (const word of commandWords) {
    reason = reason.replace(new RegExp(`\\b${word}\\b`, "i"), "");
  }
  reason = reason.replace(/<@!?\d+>/g, "").replace(/\b\d{1,3}\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/gi, "");
  reason = reason
    .replace(/\b(hey|hi|hello|yo|duck|can you|could you|would you|please)\b/gi, " ")
    .replace(/\b(for|because|reason is|reason:)\b/gi, " ")
    .replace(/[?.,!]+/g, " ");
  return reason.replace(/\s+/g, " ").trim() || "No reason provided.";
}

function inferReasonFromRequest(message, toolName) {
  const commandWords = {
    ban_member: ["ban", "banish"],
    softban_member: ["soft", "softban", "ban"],
    kick_member: ["kick"],
    timeout_member: ["timeout", "mute"],
    warn_member: ["warn", "warning"],
    view_warnings: ["view", "show", "list", "warning", "warnings", "warns"],
    clear_warnings: ["clear", "remove", "delete", "warning", "warnings", "warns"],
    untimeout_member: ["untimeout", "unmute", "remove", "timeout", "mute"],
    delete_user_messages: ["delete", "purge", "messages"],
    set_nickname: ["nickname", "nick", "rename"],
    add_role: ["add", "give", "grant", "role", "to"],
    remove_role: ["remove", "take", "role", "from"],
    disconnect_member: ["disconnect", "voice", "kick"],
    move_member: ["move", "voice", "channel", "to"],
    voice_mute_member: ["voice", "server", "mute"],
    voice_unmute_member: ["voice", "server", "unmute"],
    deafen_member: ["deafen"],
    undeafen_member: ["undeafen"],
    create_voice_channel: ["create", "make", "new", "voice", "channel"],
    rename_channel: ["rename", "channel"],
    set_channel_topic: ["topic", "channel", "set"],
    speak: ["say", "speak", "send", "post", "announce", "message"],
    pin_message: ["pin", "message"],
    unpin_message: ["unpin", "remove", "pin", "message"],
    create_thread: ["create", "make", "start", "new", "thread"],
    set_role_color: ["set", "change", "update", "role", "color", "colour", "to"],
    create_poll: ["create", "make", "start", "poll", "vote"],
    create_role: ["create", "make", "new", "role"],
    delete_role: ["delete", "remove", "role"],
  }[toolName] ?? [];

  const reason = extractReason(message.content, commandWords);
  return reason === "No reason provided." ? null : reason;
}

function extractChannelReason(text, commandWords) {
  let reason = text;
  for (const word of commandWords) {
    reason = reason.replace(new RegExp(`\\b${word}\\b`, "i"), "");
  }
  reason = reason.replace(/<#\d+>/g, "").replace(/\b\d{1,4}\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/gi, "");
  return reason.replace(/\s+/g, " ").trim() || "No reason provided.";
}

function findChannelByNameOrMention(message, text) {
  const mentioned = message.mentions.channels.first();
  if (mentioned) return mentioned;

  const quotedName = extractQuotedName(text);
  const rawName = quotedName ?? text
    .replace(/\b(can you|please|delete|remove|the|a|an|text|channel)\b/gi, " ")
    .trim();
  const wanted = normalizeMemberLookup(rawName);

  if (!wanted) return null;

  let best = null;
  let bestScore = 0;
  for (const channel of message.guild.channels.cache.values()) {
    if (!channel.name) continue;
    const channelName = normalizeMemberLookup(channel.name);
    if (!channelName) continue;

    let score = 0;
    if (channelName === wanted) score = 1000;
    else if (wanted.includes(channelName) || channelName.includes(wanted)) score = Math.min(channelName.length, wanted.length);
    else {
      const wantedWords = rawName.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = wantedWords.filter((word) => channel.name.toLowerCase().includes(word.replace(/^#/, ""))).length;
      score = matches * 10;
    }

    if (score > bestScore) {
      best = channel;
      bestScore = score;
    }
  }

  return bestScore >= 10 ? best : null;
}

function findRoleByNameOrMention(message, text) {
  const mentioned = message.mentions.roles.first();
  if (mentioned) return mentioned;

  const quotedName = extractQuotedName(text);
  const cleaned = quotedName ?? text.replace(/<@!?\d+>/g, "").replace(/\b(add|give|grant|remove|take|role|from|to)\b/gi, "").trim();
  const wanted = cleaned.replace(/^@/, "").toLowerCase();
  if (!wanted) return null;

  return message.guild.roles.cache.find((role) => role.name.toLowerCase() === wanted);
}

function findVoiceChannelByNameOrMention(message, text) {
  const mentioned = message.mentions.channels.find((channel) => channel.type === ChannelType.GuildVoice);
  if (mentioned) return mentioned;

  const quotedName = extractQuotedName(text);
  const wanted = (quotedName ?? text.replace(/<@!?\d+>/g, "").replace(/\b(move|voice|channel|to)\b/gi, "").trim()).toLowerCase();
  if (!wanted) return null;

  return message.guild.channels.cache.find((channel) => {
    return channel.type === ChannelType.GuildVoice && channel.name?.toLowerCase() === wanted;
  });
}

function findChannelByToolTarget(message, target) {
  const text = String(target || "").trim();
  const channelId = text.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{10,}$/.test(text) ? text : null);
  if (channelId) return message.guild.channels.cache.get(channelId) ?? null;

  const exact = text.replace(/^#/, "").toLowerCase();
  return message.guild.channels.cache.find((channel) => channel.name?.toLowerCase() === exact)
    ?? findChannelByNameOrMention(message, text);
}

function channelNameMatchesExactTarget(channel, target) {
  const text = String(target || "").trim().replace(/^#/, "");
  if (!text || !channel?.name) return false;

  return channel.name.toLowerCase() === text.toLowerCase()
    || normalizeMemberLookup(channel.name) === normalizeMemberLookup(text);
}

function findExactChannelByToolTarget(message, target) {
  const text = String(target || "").trim();
  const channelId = text.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{10,}$/.test(text) ? text : null);
  if (channelId) return message.guild.channels.cache.get(channelId) ?? null;

  return message.guild.channels.cache.find((channel) => channelNameMatchesExactTarget(channel, text)) ?? null;
}

function findRoleByToolTarget(message, target) {
  const text = String(target || "").trim();
  const roleId = text.match(/^<@&(\d+)>$/)?.[1] ?? (/^\d{10,}$/.test(text) ? text : null);
  if (roleId) return message.guild.roles.cache.get(roleId) ?? null;

  const exact = text.replace(/^@/, "").toLowerCase();
  return message.guild.roles.cache.find((role) => role.name.toLowerCase() === exact) ?? null;
}

function canManageRole(botMember, role) {
  return role && !role.managed && role.id !== role.guild.id && role.position < botMember.roles.highest.position;
}

function summarizeMemberName(member) {
  return `${member.displayName}, ${member.user.username}`;
}

function memberActionBlockReason(action, botMember, member) {
  if (!member) return "I could not find that member.";
  if (member.id === botMember.id) return "I cannot target myself with that moderation action.";
  if (member.id === member.guild.ownerId) return `I cannot ${commandLabel(action).toLowerCase()} the server owner.`;

  const name = summarizeMemberName(member);
  if (action.tool === "ban_member" || action.tool === "softban_member") {
    return member.bannable ? null : `I cannot ban ${name} because they are at/above Duck's highest role or otherwise protected.`;
  }

  if (action.tool === "kick_member") {
    return member.kickable ? null : `I cannot kick ${name} because they are at/above Duck's highest role or otherwise protected.`;
  }

  if (action.tool === "timeout_member" || action.tool === "untimeout_member") {
    return member.moderatable ? null : `I cannot update timeout for ${name} because they are an Administrator, at/above Duck's highest role, or otherwise protected.`;
  }

  if (action.tool === "set_nickname") {
    return member.manageable ? null : `I cannot change ${name}'s nickname because they are at/above Duck's highest role or otherwise protected.`;
  }

  if (["add_role", "remove_role", "disconnect_member", "move_member", "voice_mute_member", "voice_unmute_member", "deafen_member", "undeafen_member"].includes(action.tool)) {
    return member.manageable ? null : `I cannot manage ${name} because they are at/above Duck's highest role or otherwise protected.`;
  }

  return null;
}

function extractNewChannelName(text) {
  const quoted = extractQuotedName(text);
  const raw = quoted ?? text.replace(/\b(create|make|new|text|channel)\b/gi, "").trim();
  const name = raw
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return name.slice(0, 100) || null;
}

function extractPlainName(text, maxLength = 100) {
  const quoted = extractQuotedName(text);
  const raw = (quoted ?? text).trim();
  return raw
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || null;
}

function extractSpeakMessage(text) {
  const quoted = extractQuotedName(text);
  if (quoted) return limitDiscordContent(quoted, 1900);

  const cleaned = text
    .replace(/<#\d+>/g, " ")
    .replace(/\b(duck|can you|could you|would you|please|say|speak|send|post|announce|message|saying|as|in|to|channel)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? limitDiscordContent(cleaned, 1900) : null;
}

function isLikelySpeakRequest(text) {
  return /\b(say|speak|send|post|announce|announcement)\b/i.test(text);
}

function isDraftSpeakRequest(text) {
  return /\b(make|draft|write|prepare|create)\b.*\b(announcement|message|post)\b/i.test(text);
}

function hasExplicitSpeakMessage(text) {
  if (extractQuotedName(text)) return true;
  return /^(please\s+)?(say|speak)\s+\S/i.test(normalizeText(text));
}

function extractMessageTarget(text) {
  const linkMatch = String(text || "").match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/i);
  if (linkMatch) return { channelId: linkMatch[1], messageId: linkMatch[2] };

  const labeled = String(text || "").match(/\b(?:message|msg)\s*(?:id)?\s*:?\s*(\d{17,22})\b/i);
  if (labeled) return { channelId: null, messageId: labeled[1] };

  return null;
}

function extractMessageId(text) {
  return extractMessageTarget(text)?.messageId ?? null;
}

function resolveMessageTargetForPlan(message, plan = {}) {
  const linkTarget = extractMessageTarget(`${plan.messageUrl || ""} ${message.content || ""}`);
  const messageId = String(plan.messageId || linkTarget?.messageId || message.reference?.messageId || "").trim();
  const channelId = String(plan.channelId || linkTarget?.channelId || message.reference?.channelId || message.channelId || "").trim();
  if (!messageId || !channelId) return null;

  const channel = message.guild.channels.cache.get(channelId) ?? message.channel;
  if (!channel?.isTextBased?.() || !("messages" in channel)) return null;
  return { channel, messageId };
}

function extractThreadName(text) {
  const quoted = extractQuotedName(text);
  if (quoted) return extractPlainName(quoted, 100);

  const raw = String(text || "")
    .replace(/<#\d+>/g, " ")
    .replace(/\b(create|make|start|new|public|thread|called|named|with|topic|about|in|channel|please|duck)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return extractPlainName(raw, 100);
}

const ROLE_COLOR_NAMES = {
  red: 0xff0000,
  orange: 0xff9500,
  yellow: 0xffcc00,
  green: 0x22c55e,
  blue: 0x3b82f6,
  purple: 0x8b5cf6,
  pink: 0xec4899,
  black: 0x000001,
  white: 0xffffff,
  gray: 0x808080,
  grey: 0x808080,
};

function parseRoleColor(text) {
  const input = String(text || "").trim().toLowerCase();
  const hex = input.match(/#?([0-9a-f]{6})\b/i);
  if (hex) return Number.parseInt(hex[1], 16);

  for (const [name, value] of Object.entries(ROLE_COLOR_NAMES)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(input)) return value;
  }

  return null;
}

function formatRoleColor(color) {
  return `#${Number(color).toString(16).padStart(6, "0").toUpperCase()}`;
}

function extractPollParts(text) {
  const quoted = [...String(text || "").matchAll(/["']([^"']+)["']/g)].map((match) => match[1].trim()).filter(Boolean);
  if (quoted.length >= 3) {
    return {
      question: limitDiscordContent(quoted[0], 200),
      options: quoted.slice(1, 11).map((option) => limitDiscordContent(option, 80)),
    };
  }

  const cleaned = String(text || "")
    .replace(/<#\d+>/g, " ")
    .replace(/\b(duck|can you|could you|would you|please|create|make|start|poll|vote|with|options?|choices?|in|channel)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(/\s*\|\s*|\s*,\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return { question: null, options: [] };

  return {
    question: limitDiscordContent(parts[0], 200),
    options: parts.slice(1, 11).map((option) => limitDiscordContent(option, 80)),
  };
}

function extractRoleName(text) {
  return extractPlainName(text.replace(/\b(create|make|new|role|delete|remove)\b/gi, " "), 100);
}

function extractVoiceChannelName(text) {
  return extractNewChannelName(text.replace(/\b(create|make|new|voice|channel)\b/gi, " "));
}

function getTextChannelTarget(message, text) {
  const channel = message.mentions.channels.first() ?? message.channel;
  if (!channel?.isTextBased()) return null;
  return channel;
}

function summarizeChannel(channel) {
  return channel.name ? `#${channel.name}` : `channel ${channel.id}`;
}

function normalizeMemberLookup(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getMemberNames(member) {
  const names = [
    member.displayName,
    member.nickname,
    member.user?.username ?? member.username,
    member.user?.globalName,
  ];

  return names.filter((name) => typeof name === "string" && name.trim());
}

function textReferencesMember(text, member) {
  const lower = text.toLowerCase();
  const compact = normalizeMemberLookup(text);

  if (member.id && new RegExp(`<@!?${member.id}>`).test(text)) return true;

  return getMemberNames(member).some((name) => {
    const trimmed = name.trim().toLowerCase();
    if (normalizeMemberLookup(trimmed).length < 3) return false;

    return lower.includes(`@${trimmed}`)
      || lower.includes(trimmed)
      || compact.includes(normalizeMemberLookup(trimmed));
  });
}

function findMemberByTextReference(message, text) {
  let best = null;
  let bestScore = 0;

  for (const member of message.guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (!textReferencesMember(text, member)) continue;

    const score = Math.max(...getMemberNames(member).map((name) => normalizeMemberLookup(name).length));
    if (score > bestScore) {
      best = member;
      bestScore = score;
    }
  }

  return best;
}

function findMentionedMemberForPlan(message, text) {
  const mentionIds = [...text.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]);
  for (const id of mentionIds) {
    const member = message.mentions.members.get(id);
    if (member && !member.user.bot) return member;
  }

  return message.mentions.members.find((member) => !member.user.bot)
    ?? findMemberByTextReference(message, text)
    ?? message.mentions.members.first();
}

function planLocalModerationTool(message) {
  return planModerationToolFromText(message, message.content);
}

function planModerationTool(message) {
  return planLocalModerationTool(message);
}

function isLikelyModerationRequest(rawText) {
  const normalized = normalizeText(rawText);
  return /\b(ban|banish|soft\s*ban|kick|timeout|mute|untimeout|unmute|warn|warning|warnings|warns|slowmode|lock|lockdown|unlock|purge|delete|remove|clear|view|show|list|grep|search|find|nickname|nick|rename|topic|role|color|colour|disconnect|voice kick|voice mute|voice unmute|server mute|server unmute|deafen|undeafen|move|create|make|new|say|speak|send|post|announce|pin|unpin|thread|poll|vote)\b/.test(normalized)
    && /\b(member|user|person|him|her|them|message|messages|channel|role|color|colour|topic|slowmode|timeout|mute|unmute|deafen|undeafen|ban|kick|warn|warning|warnings|warns|nickname|nick|voice|purge|delete|remove|clear|view|show|list|grep|search|find|lock|unlock|create|make|say|speak|send|post|announce|pin|unpin|thread|poll|vote)\b|<@!?(\d+)>|<#(\d+)>|<@&(\d+)>/.test(normalized);
}

function planModerationToolFromText(message, rawText) {
  const text = rawText.trim();
  const normalized = normalizeText(text);
  const member = findMentionedMemberForPlan(message, text);

  if (/\b(ban|banish)\b/.test(normalized) && !/\bsoft\s*ban\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to ban by mentioning them." };
    return {
      tool: "ban_member",
      risk: "high",
      targetId: member.id,
      reason: extractReason(text, ["ban", "banish"]),
      summary: `ban ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\bsoft\s*ban\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to softban by mentioning them." };
    return {
      tool: "softban_member",
      risk: "high",
      targetId: member.id,
      deleteMessageSeconds: Math.min(Math.max(Math.round(parseDurationMs(text) / 1000), 0), 7 * 24 * 60 * 60),
      reason: extractReason(text, ["soft", "softban", "ban"]),
      summary: `softban ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\bkick\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to kick by mentioning them." };
    return {
      tool: "kick_member",
      risk: "high",
      targetId: member.id,
      reason: extractReason(text, ["kick"]),
      summary: `kick ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(nickname|nick|rename)\b/.test(normalized)) {
    if (!member) return { error: "Tell me whose nickname to change by mentioning them." };
    const nickname = extractNickname(text);
    if (!nickname) return { error: "Tell me the new nickname in quotes or after the mention." };
    return {
      tool: "set_nickname",
      risk: "medium",
      targetId: member.id,
      nickname,
      reason: extractReason(text, ["nickname", "nick", "rename"]),
      summary: `set ${member.displayName}, ${member.user.username}'s nickname to "${nickname}"`,
    };
  }

  if (/\b(add|give|grant)\b.*\brole\b|\brole\b.*\b(to|add|give|grant)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who should get the role by mentioning them." };
    const role = findRoleByNameOrMention(message, text);
    if (!role) return { error: "Tell me which role to add by mentioning it or quoting its name." };
    return {
      tool: "add_role",
      risk: "high",
      targetId: member.id,
      roleId: role.id,
      roleName: role.name,
      reason: extractReason(text, ["add", "give", "grant", "role", "to"]),
      summary: `add @${role.name} to ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(remove|take)\b.*\brole\b|\brole\b.*\b(from|remove|take)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who should lose the role by mentioning them." };
    const role = findRoleByNameOrMention(message, text);
    if (!role) return { error: "Tell me which role to remove by mentioning it or quoting its name." };
    return {
      tool: "remove_role",
      risk: "high",
      targetId: member.id,
      roleId: role.id,
      roleName: role.name,
      reason: extractReason(text, ["remove", "take", "role", "from"]),
      summary: `remove @${role.name} from ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(timeout|mute)\b/.test(normalized) && !/\b(untimeout|unmute|remove timeout|remove mute)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to timeout by mentioning them." };
    const durationMs = Math.min(parseDurationMs(text), 28 * 24 * 60 * 60 * 1000);
    return {
      tool: "timeout_member",
      risk: "medium",
      targetId: member.id,
      durationMs,
      reason: extractReason(text, ["timeout", "mute"]),
      summary: `timeout ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(disconnect|voice kick)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to disconnect by mentioning them." };
    return {
      tool: "disconnect_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["disconnect", "voice", "kick"]),
      summary: `disconnect ${member.displayName}, ${member.user.username} from voice`,
    };
  }

  if (/\b(voice\s+mute|server\s+mute)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to voice mute by mentioning them." };
    return {
      tool: "voice_mute_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["voice", "server", "mute"]),
      summary: `voice mute ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(voice\s+unmute|server\s+unmute)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to voice unmute by mentioning them." };
    return {
      tool: "voice_unmute_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["voice", "server", "unmute"]),
      summary: `voice unmute ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\bdeafen\b/.test(normalized) && !/\bundeafen\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to deafen by mentioning them." };
    return {
      tool: "deafen_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["deafen"]),
      summary: `deafen ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\bundeafen\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to undeafen by mentioning them." };
    return {
      tool: "undeafen_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["undeafen"]),
      summary: `undeafen ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\bmove\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to move by mentioning them." };
    const channel = findVoiceChannelByNameOrMention(message, text);
    if (!channel) return { error: "Tell me which voice channel to move them to." };
    return {
      tool: "move_member",
      risk: "medium",
      targetId: member.id,
      channelId: channel.id,
      channelName: channel.name,
      reason: extractReason(text, ["move", "voice", "channel", "to"]),
      summary: `move ${member.displayName}, ${member.user.username} to ${channel.name}`,
    };
  }

  if (/\b(untimeout|unmute|remove timeout|remove mute)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to remove timeout from by mentioning them." };
    return {
      tool: "untimeout_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["untimeout", "unmute", "remove", "timeout", "mute"]),
      summary: `remove timeout from ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(view|show|list)\b.*\b(warning|warnings|warns)\b|\b(warning|warnings|warns)\b.*\b(for|on|of)\b|^(warning|warnings|warns)\b/.test(normalized)) {
    if (!member) return { error: "Tell me whose warnings to view by mentioning them." };
    return {
      tool: "view_warnings",
      risk: "medium",
      targetId: member.id,
      reason: "Warning history lookup.",
      summary: `view warnings for ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(clear|remove|delete)\b.*\b(warning|warnings|warns)\b/.test(normalized)) {
    if (!member) return { error: "Tell me whose warnings to clear by mentioning them." };
    const count = parseWarningClearCount(text);
    if (!count) return { error: "Tell me how many warnings to clear, or say `all warnings`." };
    return {
      tool: "clear_warnings",
      risk: "medium",
      targetId: member.id,
      count,
      reason: extractReason(text, ["clear", "remove", "delete", "warning", "warnings", "warns"]),
      summary: `clear ${count === "all" ? "all" : count} warning${count === 1 ? "" : "s"} for ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(warn|warning)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to warn by mentioning them." };
    return {
      tool: "warn_member",
      risk: "medium",
      targetId: member.id,
      reason: extractReason(text, ["warn", "warning"]),
      summary: `warn ${member.displayName}, ${member.user.username}`,
    };
  }

  if (/\b(slowmode|set slowmode)\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("setRateLimitPerUser" in channel)) return { error: "I can only set slowmode in a text channel." };
    const seconds = parseSlowmodeSeconds(text);
    return {
      tool: "set_slowmode",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      seconds,
      reason: extractChannelReason(text, ["slowmode", "set"]),
      summary: `set ${summarizeChannel(channel)} slowmode to ${seconds} second${seconds === 1 ? "" : "s"}`,
    };
  }

  if (/\b(lock|lockdown)\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("permissionOverwrites" in channel)) return { error: "I can only lock a guild text channel." };
    return {
      tool: "lock_channel",
      risk: "high",
      channelId: channel.id,
      channelName: channel.name,
      reason: extractChannelReason(text, ["lock", "lockdown"]),
      summary: `lock ${summarizeChannel(channel)}`,
    };
  }

  if (/\b(unlock|open channel)\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("permissionOverwrites" in channel)) return { error: "I can only unlock a guild text channel." };
    return {
      tool: "unlock_channel",
      risk: "high",
      channelId: channel.id,
      channelName: channel.name,
      reason: extractChannelReason(text, ["unlock", "open", "channel"]),
      summary: `unlock ${summarizeChannel(channel)}`,
    };
  }

  if (/\bdelete channel\b/.test(normalized)) {
    const target = extractQuotedName(text) ?? text
      .replace(/\b(can you|please|delete|remove|the|a|an|text|channel)\b/gi, " ")
      .trim();
    const channel = findExactChannelByToolTarget(message, target);
    if (!channel) return { error: "Mention the channel, use its ID, or use its exact name so I can safely delete the right channel." };
    return {
      tool: "delete_channel",
      risk: "critical",
      channelId: channel.id,
      channelName: channel.name,
      summary: `delete the channel "${channel.name}"`,
    };
  }

  if (/\b(grep|search|find|look\s+for)\b/.test(normalized) && /\b(messages?|chat|history|keyword|keywords|containing|with|about)\b|<#\d+>/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("messages" in channel)) return { error: "I can only search messages in a text channel." };
    const query = extractGrepQuery(text);
    if (!query) return { error: "Tell me which keyword or phrase to search for." };
    const count = parseGrepResultCount(text);
    return {
      tool: "grep_messages",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      query,
      count,
      reason: `Search recent messages for "${query}".`,
      summary: `search recent messages in ${summarizeChannel(channel)} for "${query}"`,
    };
  }

  const wantsDuckToSpeak = hasExplicitSpeakMessage(text)
    && (/^(please\s+)?(say|speak)\b/.test(normalized)
      || /\b(send|post|announce)\b/.test(normalized));
  if (wantsDuckToSpeak) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("send" in channel)) return { error: "I can only speak in a text channel." };
    const messageText = extractSpeakMessage(text);
    if (!messageText) return { error: "Tell me what message Duck should send." };
    return {
      tool: "speak",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      messageText,
      reason: "Approved speak request.",
      summary: `send a message in ${summarizeChannel(channel)}`,
    };
  }

  if (/\b(unpin|remove pin)\b/.test(normalized)) {
    const target = resolveMessageTargetForPlan(message, {});
    if (!target) return { error: "Reply to the message to unpin, or include a Discord message link." };
    return {
      tool: "unpin_message",
      risk: "medium",
      channelId: target.channel.id,
      channelName: target.channel.name,
      messageId: target.messageId,
      reason: "Approved unpin request.",
      summary: `unpin message ${target.messageId} in ${summarizeChannel(target.channel)}`,
    };
  }

  if (/\b(pin|pin this|pin message)\b/.test(normalized)) {
    const target = resolveMessageTargetForPlan(message, {});
    if (!target) return { error: "Reply to the message to pin, or include a Discord message link." };
    return {
      tool: "pin_message",
      risk: "medium",
      channelId: target.channel.id,
      channelName: target.channel.name,
      messageId: target.messageId,
      reason: "Approved pin request.",
      summary: `pin message ${target.messageId} in ${summarizeChannel(target.channel)}`,
    };
  }

  if (/\b(create|make|start|new)\b.*\bthread\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("threads" in channel)) return { error: "I can only create threads in a text channel that supports threads." };
    const threadName = extractThreadName(text);
    if (!threadName) return { error: "Tell me the thread name in quotes." };
    return {
      tool: "create_thread",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      threadName,
      reason: "Approved thread creation request.",
      summary: `create thread "${threadName}" in ${summarizeChannel(channel)}`,
    };
  }

  if (/\b(color|colour)\b/.test(normalized) && /\brole\b/.test(normalized)) {
    const role = findRoleByNameOrMention(message, text);
    if (!role) return { error: "Tell me which role to recolor by mentioning it or quoting its name." };
    const color = parseRoleColor(text);
    if (color == null) return { error: "Tell me the role color as a hex value like `#3B82F6` or a basic color name." };
    return {
      tool: "set_role_color",
      risk: "high",
      roleId: role.id,
      roleName: role.name,
      color,
      reason: extractReason(text, ["set", "change", "update", "role", "color", "colour", "to"]),
      summary: `set @${role.name} color to ${formatRoleColor(color)}`,
    };
  }

  if (/\b(create|make|start)\b.*\b(poll|vote)\b|\bpoll\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text);
    if (!channel || !("send" in channel)) return { error: "I can only create polls in a text channel." };
    const { question, options } = extractPollParts(text);
    if (!question || options.length < 2) return { error: "Use `duck poll \"Question\" \"Option A\" \"Option B\"` or separate options with `|`." };
    return {
      tool: "create_poll",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      pollQuestion: question,
      pollOptions: options,
      reason: "Approved poll creation request.",
      summary: `create poll "${question}" in ${summarizeChannel(channel)}`,
    };
  }

  if (/\b(delete|purge)\b/.test(normalized) && (/<@!?\d+>/.test(normalized) || member) && /\bmessages?\b/.test(normalized)) {
    if (!member) return { error: "Tell me whose messages to delete by mentioning them." };
    const count = parseMessageCount(text);
    return {
      tool: "delete_user_messages",
      risk: "medium",
      targetId: member.id,
      count,
      channelId: message.channelId,
      reason: extractReason(text, ["delete", "purge", "messages"]),
      summary: `delete up to ${count} recent message${count === 1 ? "" : "s"} by ${member.displayName}, ${member.user.username}`,
    };
  }

  const purgeMatch = normalized.match(/\b(purge|delete)\s+(\d{1,2})(\s+messages?)?/);
  if (purgeMatch) {
    const count = Math.max(1, Math.min(Number(purgeMatch[2]), 99));
    return {
      tool: "purge_messages",
      risk: "medium",
      count,
      channelId: message.channelId,
      summary: `delete ${count} recent message${count === 1 ? "" : "s"} in this channel`,
    };
  }

  if (/\b(create|make|new)\b.*\bvoice\s+channel\b|\b(create|make|new)\b.*\bvc\b/.test(normalized)) {
    const channelName = extractVoiceChannelName(text);
    if (!channelName) return { error: "Tell me the voice channel name in quotes." };
    return {
      tool: "create_voice_channel",
      risk: "high",
      channelName,
      reason: extractChannelReason(text, ["create", "make", "new", "voice", "channel", "vc"]),
      summary: `create voice channel ${channelName}`,
    };
  }

  if (/\b(create|make|new)\b.*\b(text\s+)?channel\b/.test(normalized)) {
    const channelName = extractNewChannelName(text);
    if (!channelName) return { error: "Tell me the channel name in quotes." };
    return {
      tool: "create_text_channel",
      risk: "high",
      channelName,
      reason: extractChannelReason(text, ["create", "make", "new", "text", "channel"]),
      summary: `create #${channelName}`,
    };
  }

  if (/\brename\b.*\bchannel\b|\bchannel\b.*\brename\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text) ?? findChannelByNameOrMention(message, text);
    if (!channel) return { error: "Tell me which channel to rename." };
    const newName = extractNewChannelName(text.replace(channel.name ?? "", ""));
    if (!newName) return { error: "Tell me the new channel name in quotes." };
    return {
      tool: "rename_channel",
      risk: "high",
      channelId: channel.id,
      channelName: channel.name,
      newName,
      reason: extractChannelReason(text, ["rename", "channel", "to"]),
      summary: `rename ${summarizeChannel(channel)} to ${newName}`,
    };
  }

  if (/\b(set|change|update)\b.*\b(topic)\b/.test(normalized)) {
    const channel = getTextChannelTarget(message, text) ?? findChannelByNameOrMention(message, text);
    if (!channel || !("setTopic" in channel)) return { error: "I can only set topics in a text channel." };
    const topic = extractPlainName(text.replace(/\b(set|change|update|topic|channel|to)\b/gi, " "), 1024);
    if (!topic) return { error: "Tell me the new channel topic in quotes." };
    return {
      tool: "set_channel_topic",
      risk: "medium",
      channelId: channel.id,
      channelName: channel.name,
      topic,
      reason: "Channel topic update.",
      summary: `set ${summarizeChannel(channel)} topic`,
    };
  }

  if (/\b(create|make|new)\b.*\brole\b/.test(normalized)) {
    const roleName = extractRoleName(text);
    if (!roleName) return { error: "Tell me the role name in quotes." };
    return {
      tool: "create_role",
      risk: "high",
      roleName,
      reason: extractReason(text, ["create", "make", "new", "role"]),
      summary: `create role @${roleName}`,
    };
  }

  if (/\b(delete|remove)\b.*\brole\b/.test(normalized)) {
    const role = findRoleByNameOrMention(message, text);
    if (!role) return { error: "Tell me which role to delete by mentioning it or quoting its name." };
    return {
      tool: "delete_role",
      risk: "high",
      roleId: role.id,
      roleName: role.name,
      reason: extractReason(text, ["delete", "remove", "role"]),
      summary: `delete role @${role.name}`,
    };
  }

  return null;
}

function cleanJsonResponse(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function getMentionContext(message) {
  const members = [...(message.mentions.members?.values() ?? [])]
    .filter((member) => !member.user.bot)
    .map((member) => ({
      id: member.id,
      displayName: member.displayName,
      username: member.user.username,
    }));

  const repliedUserId = message.mentions.repliedUser?.id;
  const repliedMember = repliedUserId ? message.guild.members.cache.get(repliedUserId) : null;
  if (repliedMember && !repliedMember.user.bot && !members.some((member) => member.id === repliedMember.id)) {
    members.push({
      id: repliedMember.id,
      displayName: repliedMember.displayName,
      username: repliedMember.user.username,
      replyAuthor: true,
    });
  }

  const mentionedChannels = [...message.mentions.channels.values()].map((channel) => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
  }));

  if (!mentionedChannels.some((channel) => channel.id === message.channelId)) {
    mentionedChannels.push({
      id: message.channelId,
      name: message.channel.name,
      type: message.channel.type,
      current: true,
    });
  }

  const roles = [...message.mentions.roles.values()].map((role) => ({
    id: role.id,
    name: role.name,
  }));

  return { members, channels: mentionedChannels, roles };
}

function summarizeMember(member) {
  return {
    id: member.id,
    displayName: member.displayName,
    username: member.user.username,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    roles: member.roles.cache
      .filter((role) => role.id !== member.guild.id)
      .map((role) => role.name)
      .slice(0, 20),
    voiceChannelId: member.voice?.channelId ?? null,
  };
}

function summarizeChannelForContext(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentName: channel.parent?.name ?? null,
  };
}

function summarizeMessageForContext(item, channel) {
  return {
    id: item.id,
    channelId: channel.id,
    channelName: channel.name,
    authorId: item.author.id,
    authorTag: item.author.tag,
    authorDisplayName: item.member?.displayName ?? item.author.globalName ?? item.author.username,
    createdAt: item.createdAt.toISOString(),
    content: item.cleanContent.replace(/\s+/g, " ").slice(0, getAiContextMessageCharLimit()),
    attachmentCount: item.attachments.size,
    embedCount: item.embeds.length,
  };
}

async function getReferencedMessageContext(message) {
  const reference = message.reference;
  if (!reference?.messageId) return null;

  const channel = message.guild.channels.cache.get(reference.channelId ?? message.channelId) ?? message.channel;
  if (!channel?.isTextBased?.() || !("messages" in channel)) {
    return {
      id: reference.messageId,
      channelId: reference.channelId ?? message.channelId,
      readable: false,
      skippedReason: "referenced_channel_not_text",
    };
  }

  const botMember = await cachedBotMember(message.guild);
  if (!canIncludeChannelMessages(message, channel, botMember)) {
    return {
      id: reference.messageId,
      channelId: channel.id,
      channelName: channel.name,
      readable: false,
      skippedReason: channelIsPrivate(channel) ? "private_channel_requires_requester_admin" : "bot_missing_view_or_history_permission",
    };
  }

  try {
    const referenced = await channel.messages.fetch(reference.messageId);
    const summary = summarizeMessageForContext(referenced, channel);
    const member = referenced.member ?? message.guild.members.cache.get(referenced.author.id);
    return {
      ...summary,
      readable: true,
      authorMember: member && !member.user.bot ? summarizeMember(member) : null,
    };
  } catch {
    return {
      id: reference.messageId,
      channelId: channel.id,
      channelName: channel.name,
      readable: false,
      skippedReason: "referenced_message_fetch_failed",
    };
  }
}

function channelIsPrivate(channel) {
  const everyone = channel.guild.roles.everyone;
  return !channel.permissionsFor(everyone)?.has(PermissionsBitField.Flags.ViewChannel);
}

function canIncludeChannelMessages(message, channel, botMember) {
  const botPermissions = channel.permissionsFor(botMember);
  if (!botPermissions?.has(PermissionsBitField.Flags.ViewChannel) || !botPermissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
    return false;
  }

  if (!channelIsPrivate(channel)) return true;
  return message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function getChannelCacheKey(channel) {
  return `${channel.guildId}:${channel.id}`;
}

function normalizeCachedMessages(messages) {
  const seen = new Set();
  return messages
    .filter((item) => item?.id && !seen.has(item.id) && item.createdTimestamp)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .filter((item) => {
      seen.add(item.id);
      return true;
    })
    .slice(0, getMessageCacheLimit());
}

function rememberMessage(message) {
  if (!message.guild || !message.channel?.isTextBased?.() || !("messages" in message.channel)) return;

  const key = getChannelCacheKey(message.channel);
  const cached = messageHistoryCache.get(key);
  const messages = normalizeCachedMessages([message, ...(cached?.messages ?? [])]);
  messageHistoryCache.set(key, {
    channelId: message.channelId,
    guildId: message.guildId,
    fetchedAt: cached?.fetchedAt ?? 0,
    touchedAt: Date.now(),
    messages,
  });
}

function removeCachedMessage(message) {
  if (!message.guildId || !message.channelId) return;
  const key = `${message.guildId}:${message.channelId}`;
  const cached = messageHistoryCache.get(key);
  if (!cached) return;
  cached.messages = cached.messages.filter((item) => item.id !== message.id);
  cached.touchedAt = Date.now();
}

function removeCachedMessages(messages) {
  for (const message of messages.values()) {
    removeCachedMessage(message);
  }
}

function invalidateChannelMessageCache(channelId, guildId) {
  if (!channelId || !guildId) return;
  messageHistoryCache.delete(`${guildId}:${channelId}`);
}

async function getRecentChannelMessages(channel, limit, options = {}) {
  const wanted = Math.max(1, Math.min(limit, 100));
  const key = getChannelCacheKey(channel);
  const cached = messageHistoryCache.get(key);
  const now = Date.now();
  const ttl = getMessageCacheTtlMs();

  const cacheAge = cached ? now - Math.max(cached.fetchedAt || 0, cached.touchedAt || 0) : Infinity;
  if (!options.forceFetch && cached && cached.messages.length >= wanted && cacheAge <= ttl) {
    logDebug("message-cache.hit", { guildId: channel.guildId, channelId: channel.id, wanted, cached: cached.messages.length });
    return cached.messages.slice(0, wanted);
  }

  if (cached?.fetchPromise) {
    await cached.fetchPromise;
    const refreshed = messageHistoryCache.get(key);
    if (refreshed?.messages?.length) return refreshed.messages.slice(0, wanted);
  }

  const fetchLimit = Math.min(100, Math.max(wanted, Math.min(getMessageCacheLimit(), 100)));
  const fetchPromise = channel.messages.fetch({ limit: fetchLimit });
  messageHistoryCache.set(key, {
    channelId: channel.id,
    guildId: channel.guildId,
    fetchedAt: cached?.fetchedAt ?? 0,
    touchedAt: now,
    messages: cached?.messages ?? [],
    fetchPromise,
  });

  try {
    const fetched = await fetchPromise;
    const fetchedMessages = [...fetched.values()];
    const messages = normalizeCachedMessages([...(cached?.messages ?? []), ...fetchedMessages]);
    messageHistoryCache.set(key, {
      channelId: channel.id,
      guildId: channel.guildId,
      fetchedAt: now,
      touchedAt: now,
      messages,
    });
    logDebug("message-cache.fetch", { guildId: channel.guildId, channelId: channel.id, wanted, fetched: fetchedMessages.length, cached: messages.length });
    return messages.slice(0, wanted);
  } catch (err) {
    if (cached) {
      messageHistoryCache.set(key, { ...cached, touchedAt: now });
    } else {
      messageHistoryCache.delete(key);
    }
    throw err;
  }
}

function getResourceCacheTtlMs() {
  return Math.max(5_000, Math.min(Number(process.env.DUCK_RESOURCE_CACHE_TTL_MS) || 60_000, 10 * 60 * 1000));
}

async function cachedResourceFetch(key, fallbackValue, fetcher) {
  const now = Date.now();
  const cached = resourceFetchCache.get(key);
  if (cached?.value && cached.expiresAt > now) {
    cached.touchedAt = now;
    return cached.value;
  }
  if (cached?.promise) return cached.promise;
  if (fallbackValue) {
    resourceFetchCache.set(key, {
      value: fallbackValue,
      expiresAt: now + getResourceCacheTtlMs(),
      touchedAt: now,
    });
    return fallbackValue;
  }

  const promise = Promise.resolve()
    .then(fetcher)
    .then((value) => {
      resourceFetchCache.set(key, {
        value,
        expiresAt: Date.now() + getResourceCacheTtlMs(),
        touchedAt: Date.now(),
      });
      return value;
    })
    .catch((err) => {
      resourceFetchCache.delete(key);
      throw err;
    });
  resourceFetchCache.set(key, { promise, touchedAt: now, expiresAt: now + getResourceCacheTtlMs() });
  return promise;
}

function cachedGuild(guildId) {
  const cached = client.guilds.cache.get(guildId);
  return cachedResourceFetch(`guild:${guildId}`, cached, () => client.guilds.fetch(guildId));
}

function cachedBotMember(guild) {
  return cachedResourceFetch(`member:${guild.id}:me`, guild.members.me, () => guild.members.fetchMe());
}

function cachedMember(guild, memberId) {
  const cached = guild.members.cache.get(String(memberId));
  return cachedResourceFetch(`member:${guild.id}:${memberId}`, cached, () => guild.members.fetch(memberId));
}

function cachedChannel(guild, channelId) {
  const cached = guild.channels.cache.get(String(channelId));
  return cachedResourceFetch(`channel:${guild.id}:${channelId}`, cached, () => guild.channels.fetch(channelId));
}

function cachedRole(guild, roleId) {
  const cached = guild.roles.cache.get(String(roleId));
  return cachedResourceFetch(`role:${guild.id}:${roleId}`, cached, () => guild.roles.fetch(roleId));
}

function getCacheSweepMs() {
  return Math.max(30_000, Math.min(Number(process.env.DUCK_CACHE_SWEEP_MS) || 120_000, 30 * 60 * 1000));
}

function pruneMapToLimit(map, limit) {
  if (map.size <= limit) return 0;
  const removable = [...map.entries()]
    .sort((a, b) => (a[1].touchedAt ?? a[1].fetchedAt ?? 0) - (b[1].touchedAt ?? b[1].fetchedAt ?? 0))
    .slice(0, map.size - limit);
  for (const [key] of removable) map.delete(key);
  return removable.length;
}

function pruneRuntimeCaches() {
  const now = Date.now();
  let removedMessages = 0;
  let removedResources = 0;
  let removedContexts = 0;
  const messageMaxAge = Math.max(getMessageCacheTtlMs() * 3, 60_000);
  const resourceMaxAge = Math.max(getResourceCacheTtlMs() * 3, 60_000);

  for (const [key, entry] of messageHistoryCache.entries()) {
    if (now - Math.max(entry.touchedAt || 0, entry.fetchedAt || 0) > messageMaxAge) {
      messageHistoryCache.delete(key);
      removedMessages += 1;
    }
  }
  removedMessages += pruneMapToLimit(messageHistoryCache, Math.max(10, Number(process.env.DUCK_MESSAGE_CACHE_MAX_CHANNELS) || 100));

  for (const [key, entry] of resourceFetchCache.entries()) {
    if (!entry.promise && now - (entry.touchedAt || 0) > resourceMaxAge) {
      resourceFetchCache.delete(key);
      removedResources += 1;
    }
  }
  removedResources += pruneMapToLimit(resourceFetchCache, Math.max(50, Number(process.env.DUCK_RESOURCE_CACHE_MAX_ITEMS) || 500));

  for (const [key, entry] of serverContextCache.entries()) {
    if (entry.expiresAt <= now) {
      serverContextCache.delete(key);
      removedContexts += 1;
    }
  }

  flushJsonWrites();
  logDebug("cache.sweep", {
    messageChannels: messageHistoryCache.size,
    resources: resourceFetchCache.size,
    contexts: serverContextCache.size,
    removedMessages,
    removedResources,
    removedContexts,
  });
}

function startCacheMaintenance() {
  if (cacheMaintenanceTimer) return;
  cacheMaintenanceTimer = setInterval(pruneRuntimeCaches, getCacheSweepMs());
}

function flushRuntimeStateAndExit(signal) {
  try {
    pruneRuntimeCaches();
  } catch (err) {
    logWarn("cache.shutdown-flush-failed", { signal, error: err?.message || String(err) });
  }
  process.exit(0);
}

function findHistoryChannelTarget(message, text) {
  const mentioned = message.mentions.channels.find((channel) => channel.isTextBased?.() && "messages" in channel);
  if (mentioned) return mentioned;

  const normalizedText = normalizeMemberLookup(text);
  if (!normalizedText) return null;

  let best = null;
  let bestScore = 0;
  for (const channel of message.guild.channels.cache.values()) {
    if (!channel.isTextBased?.() || !("messages" in channel) || !channel.name) continue;

    const normalizedName = normalizeMemberLookup(channel.name);
    if (normalizedName.length < 3) continue;

    let score = 0;
    if (normalizedText.includes(normalizedName)) score = normalizedName.length;
    if (new RegExp(`(^|\\s|#)${channel.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s|[?.!,])`, "i").test(text)) {
      score += 1000;
    }

    if (score > bestScore) {
      best = channel;
      bestScore = score;
    }
  }

  return bestScore >= 3 ? best : null;
}

function getContextPriorityChannels(message) {
  const channels = [
    findHistoryChannelTarget(message, message.content),
    message.reference?.channelId ? message.guild.channels.cache.get(message.reference.channelId) : null,
    message.channel,
    ...message.mentions.channels.filter((channel) => channel.isTextBased?.() && "messages" in channel).values(),
  ];

  const seen = new Set();
  return channels.filter((channel) => {
    if (!channel || seen.has(channel.id)) return false;
    seen.add(channel.id);
    return true;
  });
}

async function collectRecentMessages(message) {
  const startedAt = Date.now();
  const maxChannels = getAiContextMessageChannelLimit();
  const perChannel = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL) || 10, 50));
  const maxTotal = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MAX_MESSAGES) || 500, 500));
  const maxMessageChars = getAiContextMessageChars();
  const seen = new Set();
  const botMember = await cachedBotMember(message.guild);
  const priorityChannels = getContextPriorityChannels(message);
  const candidates = [
    ...priorityChannels,
    ...message.guild.channels.cache
      .filter((channel) => !priorityChannels.some((priority) => priority.id === channel.id) && channel.isTextBased?.() && "messages" in channel)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];
  const recentMessages = [];
  const channelMessages = [];
  const errors = [];
  const skippedPrivate = [];
  const skippedUnreadable = [];

  for (const channel of candidates) {
    if (seen.has(channel.id) || seen.size >= maxChannels || recentMessages.length >= maxTotal) continue;
    seen.add(channel.id);
    if (!channel.isTextBased?.() || !("messages" in channel)) continue;
    const isPrivate = channelIsPrivate(channel);
    if (!canIncludeChannelMessages(message, channel, botMember)) {
      if (isPrivate) skippedPrivate.push(channel.id);
      else skippedUnreadable.push(channel.id);
      channelMessages.push({
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        parentName: channel.parent?.name ?? null,
        private: isPrivate,
        readable: false,
        skippedReason: isPrivate ? "private_channel_requires_requester_admin" : "bot_missing_view_or_history_permission",
        messages: [],
      });
      continue;
    }

    try {
      const fetched = await getRecentChannelMessages(channel, perChannel);
      const messagesForChannel = [];
      for (const item of fetched) {
        if (recentMessages.length >= maxTotal) break;
        const summary = {
          id: item.id,
          channelId: channel.id,
          channelName: channel.name,
          authorId: item.author.id,
          authorTag: item.author.tag,
          createdAt: item.createdAt.toISOString(),
          content: item.cleanContent.replace(/\s+/g, " ").slice(0, maxMessageChars),
          attachmentCount: item.attachments.size,
        };
        recentMessages.push(summary);
        messagesForChannel.push({
          id: summary.id,
          authorId: summary.authorId,
          authorTag: summary.authorTag,
          createdAt: summary.createdAt,
          content: summary.content,
          attachmentCount: summary.attachmentCount,
        });
      }

      channelMessages.push({
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        parentName: channel.parent?.name ?? null,
        private: isPrivate,
        readable: true,
        messages: messagesForChannel,
      });

      if (recentMessages.length >= maxTotal) {
        break;
      }
    } catch {
      errors.push(channel.id);
      channelMessages.push({
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        parentName: channel.parent?.name ?? null,
        private: isPrivate,
        readable: false,
        skippedReason: "message_fetch_failed",
        messages: [],
      });
    }
  }

  logDebug("context.recent-messages", {
    guildId: message.guildId,
    channelId: message.channelId,
    channelReads: seen.size,
    messages: recentMessages.length,
    channelMessageGroups: channelMessages.length,
    failedChannels: errors.length,
    skippedPrivateChannels: skippedPrivate.length,
    skippedUnreadableChannels: skippedUnreadable.length,
    ms: elapsedMs(startedAt),
  });

  return { recentMessages, channelMessages };
}

function measureContextChars(context) {
  return JSON.stringify(context).length;
}

function compactServerContext(context) {
  const maxChars = getAiContextMaxChars();
  const compacted = {
    ...context,
    memberCandidates: [...context.memberCandidates],
    availableChannels: [...context.availableChannels],
    availableRoles: [...context.availableRoles],
    recentMessages: [...context.recentMessages],
    channelMessages: context.channelMessages.map((channel) => ({
      ...channel,
      messages: [...channel.messages],
    })),
  };

  let truncated = false;
  const original = {
    chars: measureContextChars(compacted),
    recentMessages: compacted.recentMessages.length,
    channelMessages: compacted.channelMessages.reduce((sum, channel) => sum + channel.messages.length, 0),
    memberCandidates: compacted.memberCandidates.length,
    availableRoles: compacted.availableRoles.length,
    availableChannels: compacted.availableChannels.length,
  };

  // recentMessages duplicates channelMessages, so keep only a small compatibility view.
  if (measureContextChars(compacted) > maxChars && compacted.recentMessages.length > 40) {
    compacted.recentMessages = compacted.recentMessages.slice(0, 40);
    truncated = true;
  }

  while (measureContextChars(compacted) > maxChars) {
    const channel = [...compacted.channelMessages]
      .reverse()
      .find((candidate) => candidate.messages.length > 1);
    if (!channel) break;
    channel.messages.pop();
    truncated = true;
  }

  while (measureContextChars(compacted) > maxChars) {
    const channel = [...compacted.channelMessages]
      .reverse()
      .find((candidate) => candidate.messages.length > 0);
    if (!channel) break;
    channel.messages.pop();
    truncated = true;
  }

  if (measureContextChars(compacted) > maxChars && compacted.memberCandidates.length > 100) {
    compacted.memberCandidates = compacted.memberCandidates.slice(0, 100);
    truncated = true;
  }

  if (measureContextChars(compacted) > maxChars && compacted.availableRoles.length > 100) {
    compacted.availableRoles = compacted.availableRoles.slice(0, 100);
    truncated = true;
  }

  if (measureContextChars(compacted) > maxChars && compacted.availableChannels.length > 150) {
    compacted.availableChannels = compacted.availableChannels.slice(0, 150);
    truncated = true;
  }

  compacted.contextBudget = {
    maxChars,
    actualChars: measureContextChars(compacted),
    truncated,
    original,
    final: {
      recentMessages: compacted.recentMessages.length,
      channelMessages: compacted.channelMessages.reduce((sum, channel) => sum + channel.messages.length, 0),
      memberCandidates: compacted.memberCandidates.length,
      availableRoles: compacted.availableRoles.length,
      availableChannels: compacted.availableChannels.length,
    },
  };

  return compacted;
}

async function buildCurrentMessageContext(message) {
  return {
    id: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.cleanContent.replace(/\s+/g, " ").slice(0, 500),
    createdAt: message.createdAt.toISOString(),
    replyTo: await getReferencedMessageContext(message),
  };
}

async function collectServerContext(message) {
  const startedAt = Date.now();
  const cacheTtl = getServerContextCacheTtlMs();
  const requesterScope = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ? "admin" : "public";
  const focusChannels = getContextPriorityChannels(message).map((channel) => channel.id).join(",");
  const cacheKey = `${message.guildId}:${message.channelId}:${requesterScope}:${focusChannels}`;
  const cached = serverContextCache.get(cacheKey);
  if (cacheTtl > 0 && cached && cached.expiresAt > Date.now()) {
    logDebug("context.cache-hit", {
      cacheKey,
      ttlRemainingMs: cached.expiresAt - Date.now(),
      ms: elapsedMs(startedAt),
    });
    return {
      ...cached.context,
      currentMessage: await buildCurrentMessageContext(message),
    };
  }

  const mentioned = getMentionContext(message);
  const memberCandidates = message.guild.members.cache
    .filter((member) => !member.user.bot)
    .map(summarizeMember)
    .slice(0, getAiContextMemberLimit());
  const channels = message.guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(summarizeChannelForContext)
    .slice(0, getAiContextChannelLimit());
  const roles = message.guild.roles.cache
    .filter((role) => role.id !== message.guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
    }))
    .slice(0, getAiContextRoleLimit());

  const messageContext = await collectRecentMessages(message);
  const rawContext = {
    guild: {
      id: message.guild.id,
      name: message.guild.name,
      memberCount: message.guild.memberCount,
    },
    currentChannel: summarizeChannelForContext(message.channel),
    requester: summarizeMember(message.member),
    mentionedMembers: [...(message.mentions.members?.values() ?? [])]
      .filter((member) => !member.user.bot)
      .map(summarizeMember),
    memberCandidates,
    mentionedChannels: mentioned.channels,
    mentionedRoles: mentioned.roles,
    availableChannels: channels,
    availableRoles: roles,
    recentMessages: messageContext.recentMessages,
    channelMessages: messageContext.channelMessages,
    currentMessage: await buildCurrentMessageContext(message),
  };
  const context = compactServerContext(rawContext);

  if (cacheTtl > 0) {
    serverContextCache.set(cacheKey, {
      expiresAt: Date.now() + cacheTtl,
      context,
    });
  }

  logDebug("context.cache-miss", {
    cacheKey,
    ttlMs: cacheTtl,
    channels: channels.length,
    roles: roles.length,
    memberCandidates: memberCandidates.length,
    recentMessages: context.recentMessages.length,
    channelMessageGroups: context.channelMessages.length,
    contextChars: context.contextBudget.actualChars,
    contextTruncated: context.contextBudget.truncated,
    ms: elapsedMs(startedAt),
  });

  return context;
}

function resolveMemberForPlan(message, plan, allowedMembers) {
  const targetId = String(plan.targetId ?? "");
  const allowed = allowedMembers.find((candidate) => candidate.id === targetId);
  if (allowed) return allowed;

  const cached = targetId ? message.guild.members.cache.get(targetId) : null;
  if (cached && !cached.user.bot && message.mentions.repliedUser?.id === cached.id) {
    return summarizeMember(cached);
  }
  if (cached && !cached.user.bot && textReferencesMember(message.content, cached)) {
    return summarizeMember(cached);
  }

  const targetName = typeof plan.targetName === "string" ? plan.targetName.trim() : "";
  if (targetName) {
    const named = findMemberByTextReference(message, targetName);
    if (named) return summarizeMember(named);
  }

  const referenced = findMemberByTextReference(message, message.content);
  return referenced ? summarizeMember(referenced) : null;
}

function validateAiPlan(message, plan, serverContext = null) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.tool === "none") return null;

  const tool = TOOL_DEFINITIONS.find((definition) => definition.name === plan.tool);
  if (!tool) return null;

  const context = serverContext ?? getMentionContext(message);
  const inferredReason = inferReasonFromRequest(message, tool.name);
  const base = {
    tool: tool.name,
    risk: tool.risk,
    reason: typeof plan.reason === "string" && plan.reason.trim() ? plan.reason.trim() : inferredReason ?? "No reason provided.",
  };

  if ([
    "ban_member",
    "kick_member",
    "timeout_member",
    "warn_member",
    "view_warnings",
    "clear_warnings",
    "untimeout_member",
    "softban_member",
    "set_nickname",
    "add_role",
    "remove_role",
    "disconnect_member",
    "move_member",
    "voice_mute_member",
    "voice_unmute_member",
    "deafen_member",
    "undeafen_member",
    "delete_user_messages",
  ].includes(tool.name)) {
    const allowedMembers = [
      ...(context.members ?? context.mentionedMembers ?? []),
      ...(context.currentMessage?.replyTo?.authorMember ? [context.currentMessage.replyTo.authorMember] : []),
    ];
    const member = resolveMemberForPlan(message, plan, allowedMembers);
    if (!member) return { error: "I know the action, but I could not resolve the member. Use a real Discord mention or their exact server name." };

    const result = {
      ...base,
      targetId: member.id,
      summary: `${commandLabel({ tool: tool.name }).toLowerCase()} ${member.displayName}, ${member.username}`,
    };

    if (tool.name === "timeout_member") {
      const durationMs = Math.min(Math.max(Number(plan.durationMs) || parseDurationMs(message.content), 1000), 28 * 24 * 60 * 60 * 1000);
      result.durationMs = durationMs;
    }

    if (tool.name === "softban_member") {
      result.deleteMessageSeconds = Math.min(Math.max(Number(plan.deleteMessageSeconds) || 7 * 24 * 60 * 60, 0), 7 * 24 * 60 * 60);
    }

    if (tool.name === "delete_user_messages") {
      const count = Math.max(1, Math.min(Number(plan.count) || parseMessageCount(message.content), 99));
      result.count = count;
      result.channelId = message.channelId;
      result.summary = `delete up to ${count} recent message${count === 1 ? "" : "s"} by ${member.displayName}, ${member.username}`;
    }

    if (tool.name === "view_warnings") {
      result.reason = "Warning history lookup.";
      result.summary = `view warnings for ${member.displayName}, ${member.username}`;
    }

    if (tool.name === "clear_warnings") {
      const parsedCount = plan.count === "all" ? "all" : parseWarningClearCount(message.content);
      const count = parsedCount === "all" ? "all" : Math.max(1, Math.min(Number(plan.count) || Number(parsedCount) || 0, 999));
      if (!count) return { error: "Tell me how many warnings to clear, or say `all warnings`." };
      result.count = count;
      result.summary = `clear ${count === "all" ? "all" : count} warning${count === 1 ? "" : "s"} for ${member.displayName}, ${member.username}`;
    }

    if (tool.name === "set_nickname") {
      const nickname = typeof plan.nickname === "string" ? plan.nickname.replace(/\s+/g, " ").trim().slice(0, 32) : extractNickname(message.content);
      if (!nickname) return { error: "Tell me the new nickname in quotes or after the mention." };
      result.nickname = nickname;
      result.summary = `set ${member.displayName}, ${member.username}'s nickname to "${nickname}"`;
    }

    if (tool.name === "add_role" || tool.name === "remove_role") {
      const role = message.guild.roles.cache.get(String(plan.roleId)) ?? findRoleByToolTarget(message, plan.roleName || plan.targetRoleName || "");
      if (!role || role.id === message.guild.id || role.managed) {
        return { error: "Tell me which editable role to use by mentioning it or quoting its name." };
      }
      result.roleId = role.id;
      result.roleName = role.name;
      result.summary = `${tool.name === "add_role" ? "add" : "remove"} @${role.name} ${tool.name === "add_role" ? "to" : "from"} ${member.displayName}, ${member.username}`;
    }

    if (tool.name === "move_member") {
      const channel = message.guild.channels.cache.get(String(plan.channelId)) ?? findChannelByToolTarget(message, plan.channelName || "");
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return { error: "Tell me which voice channel to move them to." };
      }
      result.channelId = channel.id;
      result.channelName = channel.name;
      result.summary = `move ${member.displayName}, ${member.username} to ${channel.name}`;
    }

    if (["voice_mute_member", "voice_unmute_member", "deafen_member", "undeafen_member"].includes(tool.name)) {
      result.summary = `${commandLabel({ tool: tool.name }).toLowerCase()} ${member.displayName}, ${member.username}`;
    }

    return result;
  }

  if (tool.name === "purge_messages") {
    const count = Math.max(1, Math.min(Number(plan.count) || 10, 99));
    return {
      ...base,
      count,
      channelId: message.channelId,
      summary: `delete ${count} recent message${count === 1 ? "" : "s"} in this channel`,
    };
  }

  if (tool.name === "grep_messages") {
    const targetChannelId = String(plan.channelId || message.channelId);
    const channel = message.guild.channels.cache.get(targetChannelId)
      ?? findChannelByToolTarget(message, plan.channelName || plan.targetName || "");
    if (!channel?.isTextBased?.() || !("messages" in channel)) {
      return { error: "Mention the text channel I should search, or use this in the channel to search." };
    }

    const rawQuery = plan.query || plan.keyword || plan.keywords || plan.search || plan.reason || "";
    const query = typeof rawQuery === "string" ? limitDiscordContent(rawQuery.replace(/\s+/g, " ").trim(), 120) : "";
    if (!query || query === "No reason provided.") return { error: "Tell me which keyword or phrase to search for." };

    const count = Math.max(1, Math.min(Number(plan.count) || parseGrepResultCount(message.content), 20));
    return {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      query,
      count,
      reason: `Search recent messages for "${query}".`,
      summary: `search recent messages in ${channel.name ? `#${channel.name}` : `channel ${channel.id}`} for "${query}"`,
    };
  }

  if (tool.name === "delete_channel") {
    const targetText = plan.channelName || plan.targetName || "";
    const channel = String(plan.channelId || "").trim()
      ? message.guild.channels.cache.get(String(plan.channelId))
      : findExactChannelByToolTarget(message, targetText);

    if (!channel) {
      return { error: "Mention the channel, use its ID, or use its exact name so I can safely delete the right channel." };
    }

    if (targetText && !channelNameMatchesExactTarget(channel, targetText) && !/^<#\d+>$/.test(String(targetText).trim()) && !/^\d{10,}$/.test(String(targetText).trim())) {
      return { error: "That channel name does not exactly match the channel I found. Mention it or use the exact channel name." };
    }

    return {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      summary: `delete ${channel.name ? `#${channel.name}` : `channel ${channel.id}`}`,
    };
  }

  if (["set_slowmode", "lock_channel", "unlock_channel"].includes(tool.name)) {
    const targetChannelId = String(plan.channelId || message.channelId);
    const allowed = message.guild.channels.cache.get(targetChannelId) ?? findChannelByToolTarget(message, plan.channelName || "");
    if (!allowed) return { error: "Mention the channel so I can target the right one." };

    const result = {
      ...base,
      channelId: allowed.id,
      channelName: allowed.name,
      summary: `${commandLabel({ tool: tool.name }).toLowerCase()} ${allowed.name ? `#${allowed.name}` : `channel ${allowed.id}`}`,
    };

    if (tool.name === "set_slowmode") {
      const seconds = Math.max(0, Math.min(Number(plan.seconds) || parseSlowmodeSeconds(message.content), 21600));
      result.seconds = seconds;
      result.summary = `set ${allowed.name ? `#${allowed.name}` : `channel ${allowed.id}`} slowmode to ${seconds} second${seconds === 1 ? "" : "s"}`;
    }

    return result;
  }

  if (["rename_channel", "set_channel_topic"].includes(tool.name)) {
    const targetChannelId = String(plan.channelId || "");
    const channel = message.guild.channels.cache.get(targetChannelId) ?? findChannelByToolTarget(message, plan.channelName || plan.targetName || "");
    if (!channel) return { error: "Mention the channel or use its exact name so I can target the right channel." };

    const result = {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      summary: `${commandLabel({ tool: tool.name }).toLowerCase()} ${channel.name ? `#${channel.name}` : `channel ${channel.id}`}`,
    };

    if (tool.name === "rename_channel") {
      const newName = extractNewChannelName(plan.newName || plan.channelName || message.content);
      if (!newName) return { error: "Tell me the new channel name in quotes." };
      result.newName = newName;
      result.summary = `rename ${channel.name ? `#${channel.name}` : `channel ${channel.id}`} to ${newName}`;
    }

    if (tool.name === "set_channel_topic") {
      if (!("setTopic" in channel)) return { error: "I can only set topics in a text channel." };
      const topic = extractPlainName(plan.topic || plan.channelTopic || plan.reason || "", 1024);
      if (!topic) return { error: "Tell me the new channel topic." };
      result.topic = topic;
      result.summary = `set ${channel.name ? `#${channel.name}` : `channel ${channel.id}`} topic`;
    }

    return result;
  }

  if (tool.name === "speak") {
    if (isDraftSpeakRequest(message.content) && !hasExplicitSpeakMessage(message.content)) {
      return { error: "Tell me the exact message Duck should send, preferably in quotes." };
    }

    const targetChannelId = String(plan.channelId || "");
    const targetChannelText = plan.channelName || plan.targetName || "";
    const channel = message.guild.channels.cache.get(targetChannelId)
      ?? findChannelByToolTarget(message, targetChannelText)
      ?? (targetChannelId || targetChannelText ? null : message.channel);
    if (!channel && (targetChannelId || targetChannelText)) {
      return { error: "I could not resolve the channel Duck should speak in. Mention the channel or use its exact name." };
    }
    if (!channel?.isTextBased?.() || !("send" in channel)) return { error: "I can only speak in a text channel." };

    const rawMessageText = plan.messageText || plan.content || plan.text || "";
    const messageText = typeof rawMessageText === "string" ? limitDiscordContent(rawMessageText, 1900) : null;
    if (!messageText) return { error: "Tell me what message Duck should send." };

    return {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      messageText,
      reason: base.reason === "No reason provided." ? "Approved speak request." : base.reason,
      summary: `send a message in ${channel.name ? `#${channel.name}` : `channel ${channel.id}`}`,
    };
  }

  if (tool.name === "pin_message" || tool.name === "unpin_message") {
    const target = resolveMessageTargetForPlan(message, plan);
    if (!target) return { error: "Reply to the message or include a Discord message link so I know exactly what to pin or unpin." };

    return {
      ...base,
      channelId: target.channel.id,
      channelName: target.channel.name,
      messageId: target.messageId,
      reason: base.reason === "No reason provided." ? `Approved ${tool.name === "pin_message" ? "pin" : "unpin"} request.` : base.reason,
      summary: `${tool.name === "pin_message" ? "pin" : "unpin"} message ${target.messageId} in ${target.channel.name ? `#${target.channel.name}` : `channel ${target.channel.id}`}`,
    };
  }

  if (tool.name === "create_thread") {
    const targetChannelId = String(plan.channelId || message.channelId);
    const channel = message.guild.channels.cache.get(targetChannelId)
      ?? findChannelByToolTarget(message, plan.channelName || plan.targetName || "");
    if (!channel?.isTextBased?.() || !("threads" in channel)) {
      return { error: "I can only create public threads in a text channel that supports threads." };
    }

    const threadName = extractPlainName(plan.threadName || plan.name || plan.topic || plan.channelName || extractThreadName(message.content) || "", 100);
    if (!threadName) return { error: "Tell me the thread name in quotes." };

    return {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      threadName,
      reason: base.reason === "No reason provided." ? "Approved thread creation request." : base.reason,
      summary: `create thread "${threadName}" in ${channel.name ? `#${channel.name}` : `channel ${channel.id}`}`,
    };
  }

  if (tool.name === "set_role_color") {
    const role = message.guild.roles.cache.get(String(plan.roleId))
      ?? findRoleByToolTarget(message, plan.roleName || plan.targetName || "");
    if (!role || role.id === message.guild.id || role.managed) {
      return { error: "Tell me which editable role to recolor by mentioning it or quoting its name." };
    }

    const numericColor = Number(plan.color);
    const color = Number.isFinite(numericColor) && numericColor >= 0 && numericColor <= 0xffffff
      ? numericColor
      : parseRoleColor(plan.color || plan.roleColor || plan.reason || message.content);
    if (color == null) return { error: "Tell me the role color as a hex value like `#3B82F6` or a basic color name." };

    return {
      ...base,
      roleId: role.id,
      roleName: role.name,
      color,
      summary: `set @${role.name} color to ${formatRoleColor(color)}`,
    };
  }

  if (tool.name === "create_poll") {
    const targetChannelId = String(plan.channelId || message.channelId);
    const channel = message.guild.channels.cache.get(targetChannelId)
      ?? findChannelByToolTarget(message, plan.channelName || plan.targetName || "");
    if (!channel?.isTextBased?.() || !("send" in channel)) return { error: "I can only create polls in a text channel." };

    const fallbackPoll = extractPollParts(message.content);
    const question = limitDiscordContent(String(plan.pollQuestion || plan.question || fallbackPoll.question || "").replace(/\s+/g, " ").trim(), 200);
    const rawOptions = Array.isArray(plan.pollOptions)
      ? plan.pollOptions
      : Array.isArray(plan.options)
        ? plan.options
        : fallbackPoll.options;
    const options = rawOptions
      .map((option) => limitDiscordContent(String(option).replace(/\s+/g, " ").trim(), 80))
      .filter(Boolean)
      .slice(0, 10);

    if (!question || options.length < 2) {
      return { error: "Use `duck poll \"Question\" \"Option A\" \"Option B\"` or separate options with `|`." };
    }

    return {
      ...base,
      channelId: channel.id,
      channelName: channel.name,
      pollQuestion: question,
      pollOptions: options,
      reason: base.reason === "No reason provided." ? "Approved poll creation request." : base.reason,
      summary: `create poll "${question}" in ${channel.name ? `#${channel.name}` : `channel ${channel.id}`}`,
    };
  }

  if (tool.name === "create_text_channel" || tool.name === "create_voice_channel") {
    const channelName = typeof plan.channelName === "string" ? extractNewChannelName(plan.channelName) : extractNewChannelName(message.content);
    if (!channelName) return { error: "Tell me the channel name in quotes." };
    return {
      ...base,
      channelName,
      summary: tool.name === "create_voice_channel" ? `create voice channel ${channelName}` : `create #${channelName}`,
    };
  }

  if (tool.name === "create_role") {
    const roleName = extractPlainName(plan.roleName || plan.targetName || plan.reason || "", 100);
    if (!roleName) return { error: "Tell me the role name in quotes." };
    return {
      ...base,
      roleName,
      summary: `create role @${roleName}`,
    };
  }

  if (tool.name === "delete_role") {
    const role = message.guild.roles.cache.get(String(plan.roleId)) ?? findRoleByToolTarget(message, plan.roleName || plan.targetName || "");
    if (!role || role.id === message.guild.id || role.managed) {
      return { error: "Tell me which editable role to delete by mentioning it or quoting its name." };
    }
    return {
      ...base,
      roleId: role.id,
      roleName: role.name,
      summary: `delete role @${role.name}`,
    };
  }

  return null;
}

async function makePlannerMessages(message, providedContext = null) {
  const context = providedContext ?? await collectServerContext(message);
  const tools = TOOL_DEFINITIONS.map((tool) => `${tool.name} (${tool.risk})`).join(", ");
  return [
    {
      role: "system",
      content: [
        "You are Duck's moderation intent planner.",
        "Return only JSON. Do not explain.",
        `Available tools: ${tools}.`,
        "Schema: {\"tool\":\"none|ban_member|kick_member|timeout_member|delete_channel|purge_messages|grep_messages|warn_member|view_warnings|clear_warnings|untimeout_member|set_slowmode|lock_channel|unlock_channel|softban_member|delete_user_messages|set_nickname|add_role|remove_role|disconnect_member|move_member|voice_mute_member|voice_unmute_member|deafen_member|undeafen_member|create_text_channel|create_voice_channel|rename_channel|set_channel_topic|speak|pin_message|unpin_message|create_thread|set_role_color|create_poll|create_role|delete_role\",\"targetId\":\"member id when needed\",\"targetName\":\"member name only if id is unavailable\",\"channelId\":\"channel id when needed\",\"messageId\":\"message id when pinning/unpinning\",\"roleId\":\"role id when needed\",\"roleName\":\"role name when needed\",\"targetRoleName\":\"role name for add/remove role\",\"channelName\":\"new or target channel name when needed\",\"newName\":\"new channel name when renaming\",\"threadName\":\"thread name when creating a thread\",\"topic\":\"new channel topic\",\"messageText\":\"message Duck should send when using speak\",\"query\":\"keyword or phrase when using grep_messages\",\"pollQuestion\":\"poll question\",\"pollOptions\":[\"poll option\"],\"color\":\"role color hex or name\",\"nickname\":\"new nickname when needed\",\"count\":number,\"durationMs\":number,\"deleteMessageSeconds\":number,\"seconds\":number,\"reason\":\"short reason\"}.",
        "Tool calling tutorial: identify the user's moderation intent, choose exactly one tool, fill only the fields that tool needs, and use IDs from serverContext instead of names whenever targeting existing objects. If a user typed @name but no ID is obvious, put that exact name in targetName.",
        "Use ban_member for permanent bans, softban_member for ban-and-unban cleanup, kick_member for removing without banning, timeout_member for temporary mutes, untimeout_member to clear a timeout, warn_member to store and DM a warning, view_warnings to list stored warnings for one member, clear_warnings to clear a requested warning count for one member, purge_messages for channel-wide recent deletion, grep_messages to search recent messages for a keyword or phrase, delete_user_messages for one mentioned user's recent messages, set_slowmode for channel rate limits, lock_channel and unlock_channel for @everyone send permissions, set_nickname for nickname changes, add_role and remove_role for role edits, disconnect_member, move_member, voice_mute_member, voice_unmute_member, deafen_member, and undeafen_member for voice moderation, create_text_channel/create_voice_channel for new channels, rename_channel and set_channel_topic for channel edits, speak to send an approved message as Duck in the current or mentioned text channel, pin_message/unpin_message only for a replied-to message or explicit message link/ID, create_thread for a new public thread, set_role_color for role color changes, create_poll for reaction polls with 2-10 options, create_role/delete_role for role management, and delete_channel only when the user explicitly asks to delete a channel.",
        "Only use speak when the user explicitly gives the exact message Duck should send. If the user asks Duck to make, draft, write, or prepare an announcement, return {\"tool\":\"none\"} and let chat draft it first.",
        "Use serverContext.channelMessages for per-channel recent message context. It groups messages by channel so you can understand what happened in each readable channel.",
        "Use serverContext.currentMessage.replyTo when the user is replying to another message. It contains the referenced message text, channel, author, timestamp, and authorMember when available.",
        "Only choose member IDs, channel IDs, and role IDs from the supplied context.",
        "Member-targeting tools require a real Discord mention or an exact visible member name from the user's request.",
        "Never invent IDs, never target an unmentioned member, never chain multiple tools, and return {\"tool\":\"none\"} when the request is vague, non-moderation, or only asks a question.",
        "Every returned tool is only a plan. Duck will show an Administrator-only confirmation prompt before execution.",
        "If the request is not a moderation action, return {\"tool\":\"none\"}.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        request: message.content,
        currentChannelId: message.channelId,
        serverContext: context,
      }),
    },
  ];
}

function makePlannerResponseFormat(kind) {
  if (kind === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: "duck_moderation_plan",
        schema: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: [
                "none",
                "ban_member",
                "kick_member",
                "timeout_member",
                "delete_channel",
                "purge_messages",
                "grep_messages",
                "warn_member",
                "view_warnings",
                "clear_warnings",
                "untimeout_member",
                "set_slowmode",
                "lock_channel",
                "unlock_channel",
                "softban_member",
                "delete_user_messages",
                "set_nickname",
                "add_role",
                "remove_role",
                "disconnect_member",
                "move_member",
                "voice_mute_member",
                "voice_unmute_member",
                "deafen_member",
                "undeafen_member",
                "create_text_channel",
                "create_voice_channel",
                "rename_channel",
                "set_channel_topic",
                "speak",
                "pin_message",
                "unpin_message",
                "create_thread",
                "set_role_color",
                "create_poll",
                "create_role",
                "delete_role",
              ],
            },
            targetId: { type: "string" },
            targetName: { type: "string" },
            channelId: { type: "string" },
            messageId: { type: "string" },
            roleId: { type: "string" },
            roleName: { type: "string" },
            targetRoleName: { type: "string" },
            channelName: { type: "string" },
            newName: { type: "string" },
            threadName: { type: "string" },
            topic: { type: "string" },
            messageText: { type: "string" },
            query: { type: "string" },
            pollQuestion: { type: "string" },
            pollOptions: {
              type: "array",
              items: { type: "string" },
            },
            color: { type: "string" },
            nickname: { type: "string" },
            count: { type: "number" },
            durationMs: { type: "number" },
            deleteMessageSeconds: { type: "number" },
            seconds: { type: "number" },
            reason: { type: "string" },
          },
          required: ["tool"],
          additionalProperties: false,
        },
      },
    };
  }

  if (kind === "json_object") {
    return { type: "json_object" };
  }

  return null;
}

async function planWithOpenAiCompatible(message, providerName, baseUrl, apiKey, model, extraHeaders = {}, responseFormatKind = "json_object") {
  if (!apiKey || !model) return null;

  const startedAt = Date.now();
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const serverContext = await collectServerContext(message);
  const plannerMessages = await makePlannerMessages(message, serverContext);
  logDebug("ai.planner.request", {
    providerName,
    model,
    responseFormatKind,
    messageId: message.id,
    channelId: message.channelId,
  });

  const requestPlanner = (formatKind) => {
    const responseFormat = makePlannerResponseFormat(formatKind);
    const body = {
      model,
      temperature: 0,
      messages: plannerMessages,
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }

    if (shouldExcludeReasoning({ providerName, baseUrl })) {
      body.reasoning = { exclude: true };
      body.include_reasoning = false;
    }

    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  };

  let response;
  try {
    response = await requestPlanner(responseFormatKind);
  } catch (err) {
    logError("ai.planner.request-failed", err, { providerName, model, ms: elapsedMs(startedAt) });
    throw new AiServiceError(`${providerName} planner failed before it got a response: ${err?.message || String(err)}`, {
      providerName,
      model,
    });
  }

  logDebug("ai.planner.http", {
    providerName,
    model,
    status: response.status,
    ok: response.ok,
    ms: elapsedMs(startedAt),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const canRetryWithoutFormat = responseFormatKind !== "none"
      && response.status === 400
      && /response_?format|json_object|json_schema/i.test(errorText);

    if (canRetryWithoutFormat) {
      logWarn("ai.planner.response-format-retry", {
        providerName,
        model,
        status: response.status,
        ms: elapsedMs(startedAt),
        error: errorText.slice(0, 500),
      });
      try {
        response = await requestPlanner("none");
      } catch (err) {
        logError("ai.planner.retry-failed", err, { providerName, model, ms: elapsedMs(startedAt) });
        throw new AiServiceError(`${providerName} planner retry failed before it got a response: ${err?.message || String(err)}`, {
          providerName,
          model,
        });
      }
      logDebug("ai.planner.retry-http", {
        providerName,
        model,
        status: response.status,
        ok: response.ok,
        ms: elapsedMs(startedAt),
      });
    }

    if (!response.ok) {
      const retryError = await response.text();
      logWarn("ai.planner.http-failed", {
        providerName,
        model,
        status: response.status,
        ms: elapsedMs(startedAt),
        error: retryError.slice(0, 800),
      });
      throw new AiServiceError(`${providerName} planner returned HTTP ${response.status}: ${retryError.slice(0, 220)}`, {
        providerName,
        model,
        status: response.status,
      });
    }
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    logWarn("ai.planner.empty-content", { providerName, model, ms: elapsedMs(startedAt) });
    throw new AiServiceError(`${providerName} planner returned an empty response.`, { providerName, model });
  }

  try {
    const parsed = JSON.parse(cleanJsonResponse(content));
    const plan = validateAiPlan(message, parsed, serverContext);
    logDebug("ai.planner.result", {
      providerName,
      model,
      tool: parsed.tool,
      valid: Boolean(plan),
      error: plan?.error,
      ms: elapsedMs(startedAt),
      raw: shouldLogAiBodies() ? content.slice(0, 1000) : undefined,
    });
    return plan;
  } catch (err) {
    logError("ai.planner.invalid-json", err, {
      providerName,
      model,
      ms: elapsedMs(startedAt),
      raw: shouldLogAiBodies() ? content.slice(0, 1000) : undefined,
    });
    throw new AiServiceError(`${providerName} planner returned invalid JSON instead of a tool plan.`, {
      providerName,
      model,
    });
  }
}

async function planWithOllama(message) {
  const model = process.env.OLLAMA_MODEL || process.env.AI_MODEL || "llama3.1:8b";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const startedAt = Date.now();
  let response;
  const serverContext = await collectServerContext(message);
  const plannerMessages = await makePlannerMessages(message, serverContext);
  logDebug("ai.ollama.planner.request", { model, baseUrl, messageId: message.id, channelId: message.channelId });

  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: {
          temperature: 0,
        },
        messages: plannerMessages,
      }),
    });
  } catch (err) {
    logError("ai.ollama.planner.request-failed", err, { model, baseUrl, ms: elapsedMs(startedAt) });
    throw new AiServiceError(`Ollama planner failed before it got a response: ${err?.message || String(err)}`, {
      model,
      baseUrl,
    });
  }

  if (!response.ok) {
    logWarn("ai.ollama.planner.http-failed", {
      model,
      baseUrl,
      status: response.status,
      ms: elapsedMs(startedAt),
      error: (await response.text()).slice(0, 800),
    });
    throw new AiServiceError(`Ollama planner returned HTTP ${response.status}.`, { model, baseUrl, status: response.status });
  }

  const body = await response.json();
  const content = body.message?.content;
  if (!content) {
    logWarn("ai.ollama.planner.empty-content", { model, baseUrl, ms: elapsedMs(startedAt) });
    throw new AiServiceError("Ollama planner returned an empty response.", { model, baseUrl });
  }

  try {
    const parsed = JSON.parse(cleanJsonResponse(content));
    const plan = validateAiPlan(message, parsed, serverContext);
    logDebug("ai.ollama.planner.result", {
      model,
      tool: parsed.tool,
      valid: Boolean(plan),
      error: plan?.error,
      ms: elapsedMs(startedAt),
      raw: shouldLogAiBodies() ? content.slice(0, 1000) : undefined,
    });
    return plan;
  } catch (err) {
    logError("ai.ollama.planner.invalid-json", err, {
      model,
      ms: elapsedMs(startedAt),
      raw: shouldLogAiBodies() ? content.slice(0, 1000) : undefined,
    });
    throw new AiServiceError("Ollama planner returned invalid JSON instead of a tool plan.", { model, baseUrl });
  }
}

async function planWithConfiguredAi(message) {
  const provider = (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "")).toLowerCase();
  logDebug("ai.planner.provider", {
    provider,
    messageId: message.id,
    channelId: message.channelId,
  });

  if (provider === "ollama") {
    return planWithOllama(message);
  }

  if (provider === "openai-compatible") {
    return planWithOpenAiCompatible(
      message,
      process.env.AI_PROVIDER_NAME || "OpenAI-compatible",
      process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
      process.env.AI_API_KEY,
      process.env.AI_MODEL,
    );
  }

  if (provider === "openrouter") {
    return planWithOpenAiCompatible(
      message,
      "OpenRouter",
      "https://openrouter.ai/api/v1",
      process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY,
      process.env.OPENROUTER_MODEL || process.env.AI_MODEL || "tencent/hy3:free",
      {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://duck.local",
        "X-OpenRouter-Title": process.env.OPENROUTER_APP_NAME || "Duck Discord Bot",
      },
      "json_schema",
    );
  }

  if (provider === "groq") {
    return planWithOpenAiCompatible(
      message,
      "Groq",
      "https://api.groq.com/openai/v1",
      process.env.GROQ_API_KEY,
      process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    );
  }

  return null;
}

function getConfiguredAiProvider() {
  return (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "")).toLowerCase();
}

function getOpenAiCompatibleConfig() {
  const provider = getConfiguredAiProvider();

  if (provider === "openrouter") {
    return {
      providerName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY,
      model: process.env.OPENROUTER_MODEL || process.env.AI_MODEL || "tencent/hy3:free",
      extraHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://duck.local",
        "X-OpenRouter-Title": process.env.OPENROUTER_APP_NAME || "Duck Discord Bot",
      },
    };
  }

  if (provider === "openai-compatible") {
    return {
      providerName: process.env.AI_PROVIDER_NAME || "OpenAI-compatible",
      baseUrl: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL,
      extraHeaders: {},
    };
  }

  if (provider === "groq") {
    return {
      providerName: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      extraHeaders: {},
    };
  }

  return null;
}

function hasConfiguredAi() {
  const provider = getConfiguredAiProvider();
  if (provider === "ollama") return true;

  const config = getOpenAiCompatibleConfig();
  return Boolean(config?.apiKey && config?.model);
}

async function makeChatMessages(message) {
  const context = await collectServerContext(message);
  return [
    {
      role: "system",
      content: [
        "You are Duck, a concise Discord AI chatbot with moderation tools.",
        "Respond naturally to the current message using the server context and recent chat.",
        "If the current message is a reply, use serverContext.currentMessage.replyTo as direct reply context before broader channel history.",
        "Use serverContext.channelMessages to answer questions about recent messages in specific channels. It groups readable recent messages by channel.",
        "Use the wider server context to answer questions about members, channels, roles, and what has been happening across the server when you can.",
        "Duck also supports utility commands for userinfo, serverinfo, channelinfo, roleinfo, warnings, quotes, ship, curse, spinwheel, reminders, rules, and ping.",
        "Keep replies short, casual, and useful. Do not dump tool instructions unless asked.",
        "You have tools for moderation actions, but you cannot execute moderation directly from chat.",
        "When the user asks for moderation, include exactly one hidden tool marker at the end of your reply using {{tool::target::reason}}.",
        "Use tools ban, softban, kick, timeout, warn, view_warnings, clear_warnings, untimeout, purge, grep_messages, delete_user_messages, slowmode, lock, unlock, nickname, add_role, remove_role, disconnect, move, create_channel, create_voice_channel, rename_channel, set_topic, speak, pin_message, unpin_message, create_thread, set_role_color, create_poll, create_role, delete_role, or delete_channel.",
        "Voice tools are also available: voice_mute, voice_unmute, deafen, and undeafen.",
        "Example: I can prepare that warning for approval. {{warn::Ryzen 9 9950X3D2::testing purposes}}",
        "For two-target tools, put both targets in the target slot separated by |. Examples: {{add_role::Ryzen 9 9950X3D2|Member::testing}}, {{move::Ryzen 9 9950X3D2|General Voice::testing}}, {{rename_channel::general|new-general::cleanup}}, {{speak::general|hello everyone::approved speak request}}, {{grep_messages::general|keyword::search request}}, {{create_thread::general|bug reports::organize reports}}, {{set_role_color::Member|#3B82F6::visual update}}, {{create_poll::general|Best snack?|chips|cookies::poll request}}.",
        "Only use speak when the user gives the exact message Duck should send. If the user asks you to draft, write, make, or prepare an announcement, draft the text and ask for confirmation without a marker.",
        "The target must be a visible member/channel/role name or ID from context. The reason must preserve the user's stated reason.",
        "Never say the action is done. Duck will hide the marker, validate it, and show an Administrator confirmation embed.",
        "If a user asks for moderation but the target or reason is missing, ask a short follow-up and do not include a marker.",
        "Be honest when you are missing context, permissions, or tool access.",
        "Do not claim an action was done unless Duck has already confirmed execution.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        request: message.content,
        currentChannelId: message.channelId,
        serverContext: context,
      }),
    },
  ];
}

async function chatWithOpenAiCompatible(message, config) {
  if (!config?.apiKey || !config?.model) return null;

  const startedAt = Date.now();
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = await makeChatMessages(message);
  logDebug("ai.chat.request", {
    providerName: config.providerName,
    model: config.model,
    maxTokens: getAiChatMaxTokens(),
    maxAttempts: getAiChatMaxAttempts(),
    excludeReasoning: shouldExcludeReasoning(config),
    messageId: message.id,
    channelId: message.channelId,
  });

  const requestBody = {
    model: config.model,
    temperature: 0.4,
    max_tokens: getAiChatMaxTokens(),
    messages,
  };

  if (shouldExcludeReasoning(config)) {
    requestBody.reasoning = { exclude: true };
    requestBody.include_reasoning = false;
  }

  const requestChat = () => fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...config.extraHeaders,
    },
    body: JSON.stringify(requestBody),
  });

  const maxAttempts = config.providerName === "OpenRouter" ? getAiChatMaxAttempts() : 1;
  let body = null;
  let choiceMessage = null;
  let content = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await requestChat();
    } catch (err) {
      logError("ai.chat.request-failed", err, {
        providerName: config.providerName,
        model: config.model,
        attempt,
        attempts: maxAttempts,
        ms: elapsedMs(startedAt),
      });
      throw new AiServiceError(`${config.providerName} chat failed before it got a response: ${err?.message || String(err)}`, {
        providerName: config.providerName,
        model: config.model,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      logWarn("ai.chat.http-failed", {
        providerName: config.providerName,
        model: config.model,
        attempt,
        attempts: maxAttempts,
        status: response.status,
        ms: elapsedMs(startedAt),
        error: errorText.slice(0, 800),
      });
      throw new AiServiceError(`${config.providerName} chat returned HTTP ${response.status}: ${errorText.slice(0, 220)}`, {
        providerName: config.providerName,
        model: config.model,
        status: response.status,
      });
    }

    body = await response.json();
    choiceMessage = body.choices?.[0]?.message;
    content = extractAiTextContent(choiceMessage);
    if (typeof content === "string" && content.trim()) break;

    logWarn("ai.chat.empty-content-retry", {
      providerName: config.providerName,
      model: config.model,
      attempt,
      attempts: maxAttempts,
      finishReason: body.choices?.[0]?.finish_reason,
      hasReasoning: typeof choiceMessage?.reasoning === "string" && Boolean(choiceMessage.reasoning.trim()),
      ms: elapsedMs(startedAt),
    });
  }

  logDebug("ai.chat.result", {
    providerName: config.providerName,
    model: config.model,
    hasContent: typeof content === "string" && Boolean(content.trim()),
    ms: elapsedMs(startedAt),
    raw: shouldLogAiBodies() && typeof content === "string" ? content.slice(0, 1000) : undefined,
    finishReason: body.choices?.[0]?.finish_reason,
    contentType: Array.isArray(choiceMessage?.content) ? "array" : typeof choiceMessage?.content,
    hasReasoning: typeof choiceMessage?.reasoning === "string" && Boolean(choiceMessage.reasoning.trim()),
  });
  if (typeof content === "string" && content.trim()) return content.trim().slice(0, 1800);

  if (typeof choiceMessage?.reasoning === "string" && choiceMessage.reasoning.trim()) {
    throw new AiServiceError(`${config.providerName} chat returned internal reasoning without visible message content.`, {
      providerName: config.providerName,
      model: config.model,
    });
  }

  throw new AiServiceError(`${config.providerName} chat returned an empty response.`, {
    providerName: config.providerName,
    model: config.model,
  });
}

async function chatWithOllama(message) {
  const model = process.env.OLLAMA_MODEL || process.env.AI_MODEL || "llama3.1:8b";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const startedAt = Date.now();
  const messages = await makeChatMessages(message);
  logDebug("ai.ollama.chat.request", { model, baseUrl, messageId: message.id, channelId: message.channelId });

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        options: {
          temperature: 0.4,
          num_predict: 220,
        },
        messages,
      }),
    });
  } catch (err) {
    logError("ai.ollama.chat.request-failed", err, { model, baseUrl, ms: elapsedMs(startedAt) });
    throw new AiServiceError(`Ollama chat failed before it got a response: ${err?.message || String(err)}`, {
      model,
      baseUrl,
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    logWarn("ai.ollama.chat.http-failed", {
      model,
      baseUrl,
      status: response.status,
      ms: elapsedMs(startedAt),
      error: errorText.slice(0, 800),
    });
    throw new AiServiceError(`Ollama chat returned HTTP ${response.status}: ${errorText.slice(0, 220)}`, {
      model,
      baseUrl,
      status: response.status,
    });
  }

  const body = await response.json();
  const content = extractAiTextContent(body.message);
  logDebug("ai.ollama.chat.result", {
    model,
    hasContent: typeof content === "string" && Boolean(content.trim()),
    ms: elapsedMs(startedAt),
    raw: shouldLogAiBodies() && typeof content === "string" ? content.slice(0, 1000) : undefined,
  });
  if (typeof content === "string" && content.trim()) return content.trim().slice(0, 1800);
  throw new AiServiceError("Ollama chat returned an empty response.", { model, baseUrl });
}

function extractAiTextContent(aiMessage) {
  const content = aiMessage?.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("")
      .trim();
  }

  if (typeof aiMessage?.text === "string") return aiMessage.text;
  return "";
}

const INLINE_TOOL_MAP = {
  ban: "ban_member",
  ban_member: "ban_member",
  softban: "softban_member",
  soft_ban: "softban_member",
  softban_member: "softban_member",
  kick: "kick_member",
  kick_member: "kick_member",
  timeout: "timeout_member",
  mute: "timeout_member",
  timeout_member: "timeout_member",
  warn: "warn_member",
  warning: "warn_member",
  warn_member: "warn_member",
  view_warnings: "view_warnings",
  view_warning: "view_warnings",
  view_warns: "view_warnings",
  warnings: "view_warnings",
  warning_list: "view_warnings",
  warns: "view_warnings",
  clear_warnings: "clear_warnings",
  clear_warning: "clear_warnings",
  clear_warns: "clear_warnings",
  untimeout: "untimeout_member",
  unmute: "untimeout_member",
  untimeout_member: "untimeout_member",
  purge: "purge_messages",
  purge_messages: "purge_messages",
  delete_messages: "purge_messages",
  grep: "grep_messages",
  grep_messages: "grep_messages",
  search_messages: "grep_messages",
  search: "grep_messages",
  find_messages: "grep_messages",
  delete_user_messages: "delete_user_messages",
  slowmode: "set_slowmode",
  set_slowmode: "set_slowmode",
  lock: "lock_channel",
  lock_channel: "lock_channel",
  unlock: "unlock_channel",
  unlock_channel: "unlock_channel",
  nickname: "set_nickname",
  nick: "set_nickname",
  set_nickname: "set_nickname",
  add_role: "add_role",
  remove_role: "remove_role",
  disconnect: "disconnect_member",
  disconnect_member: "disconnect_member",
  move: "move_member",
  move_member: "move_member",
  voice_mute: "voice_mute_member",
  server_mute: "voice_mute_member",
  voice_mute_member: "voice_mute_member",
  voice_unmute: "voice_unmute_member",
  server_unmute: "voice_unmute_member",
  voice_unmute_member: "voice_unmute_member",
  deafen: "deafen_member",
  deafen_member: "deafen_member",
  undeafen: "undeafen_member",
  undeafen_member: "undeafen_member",
  create_channel: "create_text_channel",
  create_text_channel: "create_text_channel",
  create_voice_channel: "create_voice_channel",
  create_vc: "create_voice_channel",
  rename_channel: "rename_channel",
  set_topic: "set_channel_topic",
  set_channel_topic: "set_channel_topic",
  topic: "set_channel_topic",
  speak: "speak",
  say: "speak",
  send_message: "speak",
  post: "speak",
  announce: "speak",
  pin: "pin_message",
  pin_message: "pin_message",
  unpin: "unpin_message",
  unpin_message: "unpin_message",
  create_thread: "create_thread",
  thread: "create_thread",
  set_role_color: "set_role_color",
  role_color: "set_role_color",
  color_role: "set_role_color",
  create_poll: "create_poll",
  poll: "create_poll",
  create_role: "create_role",
  delete_role: "delete_role",
  delete_channel: "delete_channel",
};

function parseInlineToolCall(message, content) {
  if (typeof content !== "string") return { content, plan: null };

  const marker = content.match(/\{\{\s*([a-zA-Z0-9_ -]+)\s*::\s*([\s\S]*?)\s*::\s*([\s\S]*?)\s*\}\}/);
  const cleanContent = content
    .replace(/\{\{\s*[a-zA-Z0-9_ -]+\s*::[\s\S]*?::[\s\S]*?\s*\}\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!marker) return { content: cleanContent || content, plan: null };

  const toolKey = marker[1].trim().toLowerCase().replace(/[\s-]+/g, "_");
  const tool = INLINE_TOOL_MAP[toolKey];
  const target = marker[2].trim();
  const reason = marker[3].trim();
  if (!tool || !target || !reason) return { content: cleanContent, plan: null };
  const targetParts = target.split("|").map((part) => part.trim()).filter(Boolean);
  const primaryTarget = targetParts[0] ?? target;

  const rawPlan = {
    tool,
    reason,
    targetName: primaryTarget,
    targetId: primaryTarget.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{10,}$/.test(primaryTarget) ? primaryTarget : undefined),
    channelId: primaryTarget.match(/^<#(\d+)>$/)?.[1],
    roleId: primaryTarget.match(/^<@&(\d+)>$/)?.[1],
  };

  if (["set_slowmode", "lock_channel", "unlock_channel", "delete_channel", "rename_channel", "set_channel_topic", "speak", "grep_messages", "pin_message", "unpin_message", "create_thread", "create_poll"].includes(tool)) {
    const channel = tool === "delete_channel"
      ? findExactChannelByToolTarget(message, primaryTarget)
      : findChannelByToolTarget(message, primaryTarget);
    if (channel) rawPlan.channelId = channel.id;
  }

  if (tool === "add_role" || tool === "remove_role") {
    const role = findRoleByToolTarget(message, targetParts[1] ?? reason);
    if (role) rawPlan.roleId = role.id;
  }

  if (tool === "move_member") {
    const channel = findChannelByToolTarget(message, targetParts[1] ?? reason);
    if (channel) rawPlan.channelId = channel.id;
  }

  if (tool === "purge_messages" || tool === "delete_user_messages") {
    rawPlan.count = parseMessageCount(reason, parseMessageCount(message.content));
  }
  if (tool === "grep_messages") {
    rawPlan.channelName = primaryTarget;
    rawPlan.query = targetParts[1] ?? reason;
    rawPlan.count = parseGrepResultCount(`${target} ${reason} ${message.content}`);
  }
  if (tool === "clear_warnings") rawPlan.count = parseWarningClearCount(`${target} ${reason} ${message.content}`);
  if (tool === "timeout_member") rawPlan.durationMs = parseDurationMs(`${message.content} ${reason}`);
  if (tool === "set_slowmode") rawPlan.seconds = parseSlowmodeSeconds(`${target} ${reason} ${message.content}`);
  if (tool === "set_nickname") rawPlan.nickname = reason;
  if (tool === "create_text_channel") rawPlan.channelName = target;
  if (tool === "create_voice_channel") rawPlan.channelName = target;
  if (tool === "rename_channel") rawPlan.newName = targetParts[1] ?? reason;
  if (tool === "set_channel_topic") rawPlan.topic = reason;
  if (tool === "speak") {
    rawPlan.channelName = primaryTarget;
    rawPlan.messageText = targetParts[1] ?? reason;
  }
  if (tool === "pin_message" || tool === "unpin_message") {
    const messageTarget = extractMessageTarget(`${target} ${reason}`);
    rawPlan.messageId = messageTarget?.messageId || message.reference?.messageId;
    rawPlan.channelId = messageTarget?.channelId || rawPlan.channelId || message.reference?.channelId || message.channelId;
  }
  if (tool === "create_thread") {
    rawPlan.channelName = primaryTarget;
    rawPlan.threadName = targetParts[1] ?? reason;
  }
  if (tool === "set_role_color") {
    const role = findRoleByToolTarget(message, primaryTarget);
    if (role) rawPlan.roleId = role.id;
    rawPlan.roleName = primaryTarget;
    rawPlan.color = targetParts[1] ?? reason;
  }
  if (tool === "create_poll") {
    rawPlan.channelName = primaryTarget;
    const pollParts = extractPollParts(targetParts[1] ? targetParts.slice(1).join("|") : reason);
    rawPlan.pollQuestion = pollParts.question ?? targetParts[1] ?? "";
    rawPlan.pollOptions = pollParts.options;
  }
  if (tool === "create_role") rawPlan.roleName = target;
  if (tool === "delete_role") {
    const role = findRoleByToolTarget(message, primaryTarget);
    if (role) rawPlan.roleId = role.id;
    rawPlan.roleName = primaryTarget;
  }

  const plan = validateAiPlan(message, rawPlan);
  return {
    content: cleanContent || "I can prepare that for Administrator approval.",
    plan,
  };
}

async function generateChatResponse(message) {
  const provider = getConfiguredAiProvider();
  logDebug("ai.chat.provider", { provider, messageId: message.id, channelId: message.channelId });
  try {
    if (provider === "ollama") {
      return { content: await chatWithOllama(message), error: null };
    }

    const config = getOpenAiCompatibleConfig();
    if (config) {
      return { content: await chatWithOpenAiCompatible(message, config), error: null };
    }

    return { content: null, error: "AI is not configured, so I cannot answer as a chatbot right now." };
  } catch (err) {
    logError("ai.chat.failed", err, {
      provider,
      messageId: message.id,
      channelId: message.channelId,
    });
    return { content: null, error: makeAiUserError(err, "AI failed before it could answer.") };
  }
}

async function planModerationRequest(message) {
  let aiError = null;
  try {
    const aiPlan = await planWithConfiguredAi(message);
    if (aiPlan) return aiPlan;
  } catch (err) {
    aiError = makeAiUserError(err, "AI failed before it could plan that tool.");
    logWarn("planner.ai-failed-local-fallback", {
      messageId: message.id,
      channelId: message.channelId,
      error: aiError,
    });
  }

  const localPlan = planLocalModerationTool(message);
  if (localPlan && aiError) {
    localPlan.aiWarning = `AI planning failed, so I used my local parser instead. ${aiError}`;
  }
  logDebug("planner.local-fallback", {
    messageId: message.id,
    hasPlan: Boolean(localPlan),
    tool: localPlan?.tool,
    error: localPlan?.error,
  });
  if (!localPlan && aiError) {
    return { error: `I tried to use AI for that tool request, but it failed. ${aiError}` };
  }
  return localPlan;
}

function hasPermission(member, permission) {
  if (!permission) return true;
  const permissions = Array.isArray(permission) ? permission : [permission];
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || permissions.every((item) => member.permissions.has(item));
}

function describePermissionRequirement(permission) {
  const permissions = Array.isArray(permission) ? permission : [permission];
  return permissions.map((item) => {
    const entry = Object.entries(PermissionsBitField.Flags).find(([, value]) => value === item);
    return `\`${entry?.[0] ?? String(item)}\``;
  }).join(", ");
}

function canApprove(action, member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function commandLabel(action) {
  if (action.tool === "ban_member") return "Ban";
  if (action.tool === "kick_member") return "Kick";
  if (action.tool === "timeout_member") return "Timeout";
  if (action.tool === "delete_channel") return "Delete Channel";
  if (action.tool === "purge_messages") return "Delete Messages";
  if (action.tool === "grep_messages") return "Search Messages";
  if (action.tool === "warn_member") return "Warn";
  if (action.tool === "view_warnings") return "View Warnings";
  if (action.tool === "clear_warnings") return "Clear Warnings";
  if (action.tool === "untimeout_member") return "Remove Timeout";
  if (action.tool === "set_slowmode") return "Set Slowmode";
  if (action.tool === "lock_channel") return "Lock Channel";
  if (action.tool === "unlock_channel") return "Unlock Channel";
  if (action.tool === "softban_member") return "Softban";
  if (action.tool === "delete_user_messages") return "Delete User Messages";
  if (action.tool === "set_nickname") return "Set Nickname";
  if (action.tool === "add_role") return "Add Role";
  if (action.tool === "remove_role") return "Remove Role";
  if (action.tool === "disconnect_member") return "Disconnect Voice";
  if (action.tool === "move_member") return "Move Voice";
  if (action.tool === "voice_mute_member") return "Voice Mute";
  if (action.tool === "voice_unmute_member") return "Voice Unmute";
  if (action.tool === "deafen_member") return "Deafen";
  if (action.tool === "undeafen_member") return "Undeafen";
  if (action.tool === "create_text_channel") return "Create Text Channel";
  if (action.tool === "create_voice_channel") return "Create Voice Channel";
  if (action.tool === "rename_channel") return "Rename Channel";
  if (action.tool === "set_channel_topic") return "Set Channel Topic";
  if (action.tool === "speak") return "Speak";
  if (action.tool === "pin_message") return "Pin Message";
  if (action.tool === "unpin_message") return "Unpin Message";
  if (action.tool === "create_thread") return "Create Thread";
  if (action.tool === "set_role_color") return "Set Role Color";
  if (action.tool === "create_poll") return "Create Poll";
  if (action.tool === "create_role") return "Create Role";
  if (action.tool === "delete_role") return "Delete Role";
  return "Moderate";
}

function makeConfirmationRows(actionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`duck_confirm:${actionId}`)
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`duck_cancel:${actionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function formatWarningsForMember(member, warnings) {
  if (!warnings.length) {
    return `${member.displayName}, ${member.user.username} has no stored warnings.`;
  }

  const lines = warnings.map((warning, index) => {
    const timestampText = warning.createdAt ? `<t:${Math.floor(new Date(warning.createdAt).getTime() / 1000)}:f>` : "unknown time";
    const moderator = warning.moderatorTag || warning.moderatorId || "unknown moderator";
    const reason = String(warning.reason || "No reason provided.").slice(0, 300);
    return `${index + 1}. ${timestampText} - warned by ${moderator}: ${reason}`;
  });

  return [
    `Stored warnings for ${member.displayName}, ${member.user.username}:`,
    ...lines,
  ].join("\n");
}

function makeActionEmbed(action) {
  const embed = new EmbedBuilder()
    .setTitle(`${commandLabel(action)} Pending Approval`)
    .setDescription(RISK_COPY[action.risk])
    .setColor(action.risk === "critical" ? 0xff3b30 : action.risk === "high" ? 0xff9500 : 0x3b82f6)
    .addFields(
      { name: "Tool", value: `\`${action.tool}\``, inline: true },
      { name: "Target", value: action.summary?.slice(0, 1024) || "Unknown", inline: false },
      { name: "Reason", value: (action.reason || "No reason provided.").slice(0, 1024), inline: false },
    )
    .setFooter({ text: "An Administrator must confirm before Duck runs this." });

  const details = [];
  if (action.durationMs) details.push(`Duration: ${Math.round(action.durationMs / 60000)} minute(s)`);
  if (action.seconds != null) details.push(`Slowmode: ${action.seconds} second(s)`);
  if (action.count != null) details.push(`Count: ${action.count}`);
  if (action.nickname) details.push(`Nickname: ${action.nickname}`);
  if (action.roleName) details.push(`Role: @${action.roleName}`);
  if (action.color != null) details.push(`Color: ${formatRoleColor(action.color)}`);
  if (action.newName) details.push(`New name: ${action.newName}`);
  if (action.threadName) details.push(`Thread: ${action.threadName}`);
  if (action.topic) details.push(`Topic: ${action.topic}`);
  if (action.messageId) details.push(`Message ID: ${action.messageId}`);
  if (action.messageText) details.push(`Message: ${action.messageText}`);
  if (action.query) details.push(`Query: ${action.query}`);
  if (action.pollQuestion) details.push(`Poll: ${action.pollQuestion}`);
  if (action.pollOptions?.length) details.push(`Options: ${action.pollOptions.join(" | ")}`);
  if (action.channelName && action.tool !== "delete_channel") details.push(`Channel: ${action.channelName}`);
  if (action.aiWarning) details.push(`AI note: ${action.aiWarning}`);
  if (details.length) embed.addFields({ name: "Details", value: details.join("\n").slice(0, 1024), inline: false });

  return embed;
}

function describeAction(action) {
  const lines = [
    RISK_COPY[action.risk],
    `Planned tool: \`${action.tool}\``,
    `Action: **${commandLabel(action)}**`,
    `Target: ${action.summary}`,
  ];

  if (action.aiWarning) lines.push(`AI note: ${action.aiWarning}`);
  if (action.reason) lines.push(`Reason: ${action.reason}`);
  if (action.durationMs) lines.push(`Duration: ${Math.round(action.durationMs / 60000)} minute(s)`);
  if (action.seconds != null) lines.push(`Slowmode: ${action.seconds} second(s)`);
  if (action.count != null) lines.push(`Count: ${action.count}`);
  if (action.nickname) lines.push(`Nickname: ${action.nickname}`);
  if (action.roleName) lines.push(`Role: @${action.roleName}`);
  if (action.color != null) lines.push(`Color: ${formatRoleColor(action.color)}`);
  if (action.messageId) lines.push(`Message ID: ${action.messageId}`);
  if (action.threadName) lines.push(`Thread: ${action.threadName}`);
  if (action.channelName && action.tool !== "delete_channel") lines.push(`Channel: ${action.channelName}`);
  if (action.messageText) lines.push(`Message: ${action.messageText}`);
  if (action.query) lines.push(`Query: ${action.query}`);
  if (action.pollQuestion) lines.push(`Poll: ${action.pollQuestion}`);
  if (action.pollOptions?.length) lines.push(`Options: ${action.pollOptions.join(" | ")}`);

  return lines.join("\n");
}

async function promptForConfirmation(message, action, options = {}) {
  const startedAt = Date.now();
  const actionId = `${Date.now()}_${message.id}`;
  const createdAt = Date.now();
  const pending = {
    ...action,
    id: actionId,
    guildId: message.guildId,
    requestedBy: message.author.id,
    requestChannelId: message.channelId,
    createdAt,
    expiresAt: createdAt + getPendingActionTtlMs(),
  };

  const payload = {
    content: limitDiscordContent(options.content ?? describeAction(pending)),
    embeds: options.useEmbed ? [makeActionEmbed(pending)] : [],
    components: makeConfirmationRows(actionId),
    allowedMentions: { repliedUser: false },
  };

  const prompt = options.messageToEdit
    ? await options.messageToEdit.edit(payload)
    : await message.reply(payload);

  pending.promptId = prompt.id;
  pendingActions.set(actionId, pending);
  pendingByChannel.set(message.channelId, actionId);
  schedulePendingExpiry(pending);
  savePendingActions();
  logInfo("moderation.prompt-created", {
    actionId,
    tool: action.tool,
    risk: action.risk,
    guildId: message.guildId,
    requestChannelId: message.channelId,
    targetChannelId: action.channelId,
    requestedBy: message.author.id,
    promptId: prompt.id,
    ms: elapsedMs(startedAt),
  });
}

async function executeAction(client, action, approver) {
  const startedAt = Date.now();
  logInfo("moderation.execute.start", {
    actionId: action.id,
    tool: action.tool,
    guildId: action.guildId,
    channelId: action.channelId,
    approverId: approver.id,
  });
  const guild = await cachedGuild(action.guildId);
  const botMember = await cachedBotMember(guild);
  const needed = TOOL_REQUIREMENTS[action.tool];

  if (needed && !hasPermission(botMember, needed)) {
    const result = `I cannot run \`${action.tool}\` because Duck is missing required Discord permission(s): ${describePermissionRequirement(needed)}.`;
    logWarn("moderation.execute.missing-bot-permission", { actionId: action.id, tool: action.tool, needed });
    return result;
  }

  if (action.tool === "ban_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.ban({ reason: `Duck approved by ${approver.user.tag}: ${action.reason}` });
    const result = `I have banned ${summarizeMemberName(member)}.`;
    logInfo("moderation.execute.done", { actionId: action.id, tool: action.tool, ms: elapsedMs(startedAt) });
    return result;
  }

  if (action.tool === "kick_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const displayName = member.displayName;
    const username = member.user.username;
    await member.kick(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have kicked ${displayName}, ${username}.`;
  }

  if (action.tool === "softban_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const displayName = member.displayName;
    const username = member.user.username;
    await guild.members.ban(member.id, {
      deleteMessageSeconds: action.deleteMessageSeconds ?? 7 * 24 * 60 * 60,
      reason: `Duck softban approved by ${approver.user.tag}: ${action.reason}`,
    });
    await guild.members.unban(member.id, `Duck softban unban approved by ${approver.user.tag}`);
    return `I have softbanned ${displayName}, ${username}.`;
  }

  if (action.tool === "timeout_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.timeout(action.durationMs, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have timed out ${summarizeMemberName(member)}.`;
  }

  if (action.tool === "untimeout_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.timeout(null, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have removed timeout from ${summarizeMemberName(member)}.`;
  }

  if (action.tool === "warn_member") {
    const member = await cachedMember(guild, action.targetId);
    const warning = `You were warned in ${guild.name}: ${action.reason}`;
    await member.send(warning).catch(() => null);
    const totalWarnings = addMemberWarning(guild.id, member.id, {
      id: `${Date.now()}_${action.id}`,
      createdAt: new Date().toISOString(),
      moderatorId: approver.id,
      moderatorTag: approver.user.tag,
      reason: action.reason || "No reason provided.",
    });
    return `I have warned ${member.displayName}, ${member.user.username}. They now have ${totalWarnings} stored warning${totalWarnings === 1 ? "" : "s"}.`;
  }

  if (action.tool === "view_warnings") {
    const member = await cachedMember(guild, action.targetId);
    return formatWarningsForMember(member, getMemberWarnings(guild.id, member.id));
  }

  if (action.tool === "clear_warnings") {
    const member = await cachedMember(guild, action.targetId);
    const existingWarnings = getMemberWarnings(guild.id, member.id);
    const count = action.count === "all" ? existingWarnings.length : Math.max(1, Math.min(Number(action.count) || 0, 999));
    if (!existingWarnings.length) return `${member.displayName}, ${member.user.username} has no stored warnings to clear.`;
    if (!count) return "Tell me how many warnings to clear, or say `all warnings`.";

    const { removedCount, remainingCount } = clearMemberWarnings(guild.id, member.id, count);
    return `I have cleared ${removedCount} warning${removedCount === 1 ? "" : "s"} for ${member.displayName}, ${member.user.username}. ${remainingCount} warning${remainingCount === 1 ? "" : "s"} remain.`;
  }

  if (action.tool === "set_nickname") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.setNickname(action.nickname, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have set ${member.user.username}'s nickname to "${action.nickname}".`;
  }

  if (action.tool === "add_role" || action.tool === "remove_role") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const role = await cachedRole(guild, action.roleId);
    if (!role || role.managed || role.id === guild.id) return "I cannot use that role.";

    if (!canManageRole(botMember, role)) {
      return `I cannot manage @${role.name} because it is at or above Duck's highest role.`;
    }

    if (action.tool === "add_role") {
      await member.roles.add(role, `Duck approved by ${approver.user.tag}: ${action.reason}`);
      return `I have added @${role.name} to ${member.displayName}, ${member.user.username}.`;
    }

    await member.roles.remove(role, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have removed @${role.name} from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "disconnect_member") {
    const member = await cachedMember(guild, action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.voice.disconnect(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have disconnected ${member.displayName}, ${member.user.username} from voice.`;
  }

  if (action.tool === "move_member") {
    const member = await cachedMember(guild, action.targetId);
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return "I can only move members to a voice channel.";
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.voice.setChannel(channel, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have moved ${member.displayName}, ${member.user.username} to ${channel.name}.`;
  }

  if (action.tool === "voice_mute_member" || action.tool === "voice_unmute_member") {
    const member = await cachedMember(guild, action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const mute = action.tool === "voice_mute_member";
    await member.voice.setMute(mute, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return mute
      ? `I have voice muted ${member.displayName}, ${member.user.username}.`
      : `I have removed voice mute from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "deafen_member" || action.tool === "undeafen_member") {
    const member = await cachedMember(guild, action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const deaf = action.tool === "deafen_member";
    await member.voice.setDeaf(deaf, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return deaf
      ? `I have deafened ${member.displayName}, ${member.user.username}.`
      : `I have removed deafen from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "delete_channel") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel) return `I could not find the channel "${action.channelName}".`;
    if (action.channelName && channel.name !== action.channelName) {
      return `I did not delete anything because the target channel changed from "${action.channelName}" to "${channel.name}".`;
    }
    await channel.delete(`Duck approved by ${approver.user.tag}`);
    resourceFetchCache.delete(`channel:${guild.id}:${action.channelId}`);
    invalidateChannelMessageCache(action.channelId, guild.id);
    return `I have deleted the channel "${action.channelName}".`;
  }

  if (action.tool === "purge_messages") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased() || !("messages" in channel) || !("bulkDelete" in channel)) {
      return "I can only delete messages in a text channel.";
    }

    const fetched = await channel.messages.fetch({ limit: Math.min(100, action.count + 10) });
    const matches = fetched
      .filter((item) => item.id !== action.promptId)
      .first(action.count);

    if (!matches.length) {
      return "I did not find any recent messages I can safely delete.";
    }

    const deleted = await channel.bulkDelete(matches, true);
    removeCachedMessages(deleted);
    return `I have deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"}.`;
  }

  if (action.tool === "grep_messages") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("messages" in channel)) {
      return "I can only search messages in a text channel.";
    }

    const permissions = channel.permissionsFor(botMember);
    if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      return "Duck cannot read message history in that channel.";
    }

    const query = String(action.query || "").trim();
    if (!query) return "Tell me which keyword or phrase to search for.";
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const resultLimit = Math.max(1, Math.min(Number(action.count) || 10, 20));
    const fetched = await getRecentChannelMessages(channel, 100);
    const matches = fetched
      .filter((item) => {
        const content = item.cleanContent.replace(/\s+/g, " ").toLowerCase();
        return query.includes(" ")
          ? content.includes(query.toLowerCase())
          : terms.every((term) => content.includes(term));
      })
      .slice(0, resultLimit);

    if (!matches.length) {
      return `No recent matches for "${query}" in ${channel}.`;
    }

    const lines = matches.map((item, index) => {
      const content = item.cleanContent
        .replace(/\s+/g, " ")
        .replace(/@/g, "@\\u200b")
        .slice(0, 180);
      return `${index + 1}. ${item.author.tag} at <t:${Math.floor(item.createdTimestamp / 1000)}:R>: ${content || "[no text]"} (${item.url})`;
    });

    return [
      `Found ${matches.length} recent match${matches.length === 1 ? "" : "es"} for "${query}" in ${channel}:`,
      ...lines,
    ].join("\n");
  }

  if (action.tool === "delete_user_messages") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased() || !("messages" in channel) || !("bulkDelete" in channel)) {
      return "I can only delete user messages in a text channel.";
    }

    const fetched = await channel.messages.fetch({ limit: 100 });
    const matches = fetched
      .filter((item) => item.author.id === action.targetId)
      .first(action.count);
    if (!matches.length) {
      return "I did not find any recent messages from that member that I can safely delete.";
    }
    const deleted = await channel.bulkDelete(matches, true);
    removeCachedMessages(deleted);
    return `I have deleted ${deleted.size} recent message${deleted.size === 1 ? "" : "s"} from that member.`;
  }

  if (action.tool === "set_slowmode") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("setRateLimitPerUser" in channel)) {
      return "I can only set slowmode in a text channel.";
    }

    await channel.setRateLimitPerUser(action.seconds, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have set slowmode in ${channel} to ${action.seconds} second${action.seconds === 1 ? "" : "s"}.`;
  }

  if (action.tool === "lock_channel" || action.tool === "unlock_channel") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("permissionOverwrites" in channel)) {
      return "I can only update permissions in a guild text channel.";
    }

    const denySend = action.tool === "lock_channel";
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: denySend ? false : null,
      SendMessagesInThreads: denySend ? false : null,
      CreatePublicThreads: denySend ? false : null,
      CreatePrivateThreads: denySend ? false : null,
    }, {
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });

    return denySend ? `I have locked ${channel}.` : `I have unlocked ${channel}.`;
  }

  if (action.tool === "create_text_channel") {
    const channel = await guild.channels.create({
      name: action.channelName,
      type: ChannelType.GuildText,
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });
    return `I have created ${channel}.`;
  }

  if (action.tool === "create_voice_channel") {
    const channel = await guild.channels.create({
      name: action.channelName,
      type: ChannelType.GuildVoice,
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });
    return `I have created voice channel ${channel.name}.`;
  }

  if (action.tool === "rename_channel") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("setName" in channel)) return "I can only rename a guild channel.";
    const oldName = channel.name;
    await channel.setName(action.newName, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    resourceFetchCache.delete(`channel:${guild.id}:${action.channelId}`);
    return `I have renamed ${oldName} to ${action.newName}.`;
  }

  if (action.tool === "set_channel_topic") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("setTopic" in channel)) return "I can only set topics in a text channel.";
    await channel.setTopic(action.topic, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have updated the topic in ${channel}.`;
  }

  if (action.tool === "speak") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("send" in channel)) return "I can only speak in a text channel.";

    const permissions = channel.permissionsFor(botMember);
    if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
      return "Duck cannot send messages in that channel.";
    }

    await channel.send({
      content: limitDiscordContent(action.messageText, 1900),
      allowedMentions: { parse: [] },
    });
    return `I sent the message in ${channel}.`;
  }

  if (action.tool === "pin_message" || action.tool === "unpin_message") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("messages" in channel)) return "I can only pin or unpin messages in a text channel.";

    const targetMessage = await channel.messages.fetch(action.messageId).catch(() => null);
    if (!targetMessage) return "I could not find that message.";

    if (action.tool === "pin_message") {
      await targetMessage.pin(`Duck approved by ${approver.user.tag}: ${action.reason}`);
      return `I have pinned that message in ${channel}.`;
    }

    await targetMessage.unpin(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have unpinned that message in ${channel}.`;
  }

  if (action.tool === "create_thread") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("threads" in channel)) {
      return "I can only create public threads in a text channel that supports threads.";
    }

    const thread = await channel.threads.create({
      name: action.threadName,
      autoArchiveDuration: 1440,
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });
    resourceFetchCache.delete(`channel:${guild.id}:${action.channelId}`);
    return `I have created thread ${thread}.`;
  }

  if (action.tool === "set_role_color") {
    const role = await cachedRole(guild, action.roleId);
    if (!canManageRole(botMember, role)) return "I cannot recolor that role because it is managed, missing, or at/above Duck's highest role.";

    await role.setColor(action.color, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    resourceFetchCache.delete(`role:${guild.id}:${action.roleId}`);
    return `I have set @${role.name}'s color to ${formatRoleColor(action.color)}.`;
  }

  if (action.tool === "create_poll") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("send" in channel)) return "I can only create polls in a text channel.";

    const permissions = channel.permissionsFor(botMember);
    if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
      return "Duck cannot send messages in that channel.";
    }
    if (!permissions.has(PermissionsBitField.Flags.AddReactions)) {
      return "Duck needs Add Reactions permission to create a reaction poll.";
    }

    const optionLines = action.pollOptions.map((option, index) => {
      const emoji = String.fromCodePoint(0x1f1e6 + index);
      return `${emoji} ${option}`;
    });
    const pollMessage = await channel.send({
      content: limitDiscordContent([
        `Poll: ${action.pollQuestion}`,
        ...optionLines,
      ].join("\n"), 1900),
      allowedMentions: { parse: [] },
    });

    for (let index = 0; index < action.pollOptions.length; index += 1) {
      await pollMessage.react(String.fromCodePoint(0x1f1e6 + index)).catch((err) => {
        logWarn("poll.react-failed", { actionId: action.id, messageId: pollMessage.id, index, error: err?.message || String(err) });
      });
    }
    rememberMessage(pollMessage);
    return `I have created the poll in ${channel}.`;
  }

  if (action.tool === "create_role") {
    const role = await guild.roles.create({
      name: action.roleName,
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });
    return `I have created @${role.name}.`;
  }

  if (action.tool === "delete_role") {
    const role = await cachedRole(guild, action.roleId);
    if (!canManageRole(botMember, role)) return "I cannot delete that role because it is managed, missing, or at/above Duck's highest role.";
    const roleName = role.name;
    await role.delete(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    resourceFetchCache.delete(`role:${guild.id}:${action.roleId}`);
    return `I have deleted @${roleName}.`;
  }

  return "I do not know how to run that tool.";
}

async function resolveApprover(interactionOrMessage) {
  if (interactionOrMessage.member?.permissions) {
    return interactionOrMessage.member;
  }

  if (!interactionOrMessage.guild || !interactionOrMessage.author) return null;
  return cachedMember(interactionOrMessage.guild, interactionOrMessage.author.id);
}

async function approveAction(source, actionId, client) {
  const action = pendingActions.get(actionId);
  if (!action) {
    logWarn("moderation.approve.missing-action", { actionId });
    if ("reply" in source) {
      await source.reply({ content: "That Duck confirmation expired or was already handled.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  const approver = await resolveApprover(source);
  if (!approver || !canApprove(action, approver)) {
    const content = "I need confirmation from a person that has Administrator.";
    logWarn("moderation.approve.denied", {
      actionId,
      tool: action.tool,
      approverId: approver?.id,
    });

    if ("reply" in source && source.isButton?.()) {
      await source.reply({ content, ephemeral: true });
    } else {
      await source.reply(content).catch(() => {});
    }
    return;
  }

  pendingActions.delete(actionId);
  if (pendingExpiryTimers.has(actionId)) {
    clearTimeout(pendingExpiryTimers.get(actionId));
    pendingExpiryTimers.delete(actionId);
  }
  const requestChannelId = getActionRequestChannelId(action);
  if (pendingByChannel.get(requestChannelId) === actionId) {
    pendingByChannel.delete(requestChannelId);
  }
  savePendingActions();
  logInfo("moderation.approve.accepted", {
    actionId,
    tool: action.tool,
    approverId: approver.id,
  });

  const executeStartedAt = Date.now();
  let result;
  try {
    result = await executeAction(client, action, approver);
  } catch (err) {
    logError("moderation.execute.failed", err, {
      actionId,
      tool: action.tool,
      approverId: approver.id,
      ms: elapsedMs(executeStartedAt),
    });
    result = `Duck hit an error while running \`${action.tool}\`: ${err?.message || String(err)}`;
  }
  logInfo("moderation.execute.result", {
    actionId,
    tool: action.tool,
    approverId: approver.id,
    ms: elapsedMs(executeStartedAt),
    result: result.slice(0, 300),
  });

  await sendApprovalResult(source, result, action);
}

async function sendApprovalResult(source, result, action) {
  const chunks = splitDiscordLines(String(result ?? "").split(/\r?\n/));
  if ("update" in source && source.isButton?.()) {
    try {
      await source.update({ content: chunks[0], embeds: [], components: [] });
      for (const chunk of chunks.slice(1)) {
        if ("followUp" in source) {
          await source.followUp({ content: chunk, ephemeral: true }).catch(() => {});
        }
      }
      return;
    } catch (err) {
      logWarn("moderation.result-update-failed", {
        actionId: action.id,
        tool: action.tool,
        error: err?.message || String(err),
      });
    }
  }

  if ("reply" in source) {
    await source.reply(chunks[0]).catch(async () => {
      if ("followUp" in source) {
        await source.followUp({ content: chunks[0], ephemeral: true }).catch(() => {});
      }
    });
    for (const chunk of chunks.slice(1)) {
      if ("followUp" in source) {
        await source.followUp({ content: chunk, ephemeral: true }).catch(() => {});
      } else {
        await source.reply(chunk).catch(() => {});
      }
    }
  }
}

async function cancelAction(interaction, actionId) {
  const action = pendingActions.get(actionId);
  if (!action) {
    logWarn("moderation.cancel.missing-action", { actionId });
    await interaction.reply({ content: "That Duck confirmation expired or was already handled.", ephemeral: true });
    return;
  }

  const member = await resolveApprover(interaction);
  if (!member || (member.id !== action.requestedBy && !canApprove(action, member))) {
    logWarn("moderation.cancel.denied", {
      actionId,
      tool: action.tool,
      memberId: member?.id,
      requestedBy: action.requestedBy,
    });
    await interaction.reply({ content: "Only the requester or an authorized moderator can cancel this.", ephemeral: true });
    return;
  }

  pendingActions.delete(actionId);
  if (pendingExpiryTimers.has(actionId)) {
    clearTimeout(pendingExpiryTimers.get(actionId));
    pendingExpiryTimers.delete(actionId);
  }
  const requestChannelId = getActionRequestChannelId(action);
  if (pendingByChannel.get(requestChannelId) === actionId) {
    pendingByChannel.delete(requestChannelId);
  }
  savePendingActions();
  logInfo("moderation.cancelled", { actionId, tool: action.tool, memberId: member.id });

  await interaction.update({ content: "Cancelled. I did not run the moderation tool.", components: [] });
}

function makeDuckHelp(content = "") {
  const normalized = normalizeText(content);

  if (/^(hey|hi|hello|yo|sup)\b/.test(normalized)) {
    return [
      "Hey. I am here.",
      "Give me a moderation request like `duck warn @user spam` or `duck timeout @user 10m flooding`.",
      "I only prepare actions. An Administrator must confirm before I do anything.",
    ].join("\n");
  }

  if (/\b(joking|jk|nevermind|never mind|cancel|ignore|nah)\b/.test(normalized)) {
    return "Got it. I will not do anything unless there is a planned action and an Administrator confirms it.";
  }

  return [
    "I heard you, but I do not see a clear moderation action yet.",
    makeUtilityHelp(),
    "Examples: `duck warn @user spam`, `duck timeout @user 10m flooding`, `duck purge 25`, `duck lock #general`.",
    "I only prepare actions. An Administrator must confirm before I do anything.",
  ].join("\n");
}

function isNegativeConfirmation(text) {
  const normalized = normalizeText(text);
  return /^(i\s+)?(do\s+not|don't|dont)\s+confirm\b/.test(normalized)
    || /\b(cancel|nevermind|never mind|abort|stop|nah|nope)\b/.test(normalized);
}

async function cancelLatestActionFromMessage(message) {
  const actionId = pendingByChannel.get(message.channelId);
  if (!actionId) return false;

  const action = pendingActions.get(actionId);
  if (!action) {
    pendingByChannel.delete(message.channelId);
    savePendingActions();
    return false;
  }

  const member = await resolveApprover(message);
  if (!member || (member.id !== action.requestedBy && !canApprove(action, member))) {
    await message.reply("Only the requester or an Administrator can cancel that pending action.").catch(() => {});
    return true;
  }

  pendingActions.delete(actionId);
  if (pendingExpiryTimers.has(actionId)) {
    clearTimeout(pendingExpiryTimers.get(actionId));
    pendingExpiryTimers.delete(actionId);
  }
  const requestChannelId = getActionRequestChannelId(action);
  if (pendingByChannel.get(requestChannelId) === actionId) {
    pendingByChannel.delete(requestChannelId);
  }
  savePendingActions();

  await message.reply("Cancelled. I did not run the moderation tool.").catch(() => {});
  return true;
}

function wantsRecentHistory(message, text) {
  const normalized = normalizeText(text);
  const hasHistoryIntent = /\b(recent|last|pull up|show|summarize|summary|recap|catch me up)\b/.test(normalized);
  const hasHistoryObject = /\b(message|messages|chat|history|logs?|channel)\b/.test(normalized);
  const hasChannelTarget = Boolean(findHistoryChannelTarget(message, text));
  return (
    hasHistoryIntent && (hasHistoryObject || hasChannelTarget)
  ) || /\b(what'?s going on|what is going on|what happened)\b/.test(normalized);
}

async function makeRecentHistoryResponse(message) {
  const targetChannel = findHistoryChannelTarget(message, message.content) ?? message.channel;
  const botMember = await cachedBotMember(message.guild);

  if (!targetChannel.isTextBased?.() || !("messages" in targetChannel)) {
    return "I can only summarize message history from text channels.";
  }

  if (!canIncludeChannelMessages(message, targetChannel, botMember)) {
    if (channelIsPrivate(targetChannel) && !message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
      return `#${targetChannel.name} is private. I can only read private channel history when the requester has Administrator.`;
    }
    return `I cannot read message history in #${targetChannel.name}. Make sure Duck can view the channel and read message history.`;
  }

  const fetched = await getRecentChannelMessages(targetChannel, 25);
  const items = fetched
    .filter((item) => item.id !== message.id && item.content?.trim())
    .slice(0, 10)
    .map((item) => ({
      authorTag: item.author.tag,
      content: item.cleanContent.replace(/\s+/g, " ").slice(0, 180),
    }));

  if (!items.length) {
    return `I can read #${targetChannel.name}, but I do not see recent text messages to summarize yet.`;
  }

  const lines = items.map((item) => {
    const content = item.content.length > 140 ? `${item.content.slice(0, 137)}...` : item.content;
    return `- ${item.authorTag}: ${content}`;
  });

  return [
    `Recent activity in #${targetChannel.name}:`,
    ...lines,
  ].join("\n");
}

function discordTimestamp(date) {
  if (!date) return "unknown";
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}

function formatBoolean(value) {
  return value ? "yes" : "no";
}

function findUtilityMemberTarget(message, text, fallbackToRequester = true) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;

  const named = findMemberByTextReference(message, text);
  if (named) return named;

  return fallbackToRequester ? message.member : null;
}

function channelTypeName(type) {
  const names = {
    [ChannelType.GuildText]: "text",
    [ChannelType.GuildVoice]: "voice",
    [ChannelType.GuildCategory]: "category",
    [ChannelType.GuildAnnouncement]: "announcement",
    [ChannelType.AnnouncementThread]: "announcement thread",
    [ChannelType.PublicThread]: "public thread",
    [ChannelType.PrivateThread]: "private thread",
    [ChannelType.GuildStageVoice]: "stage voice",
    [ChannelType.GuildForum]: "forum",
    [ChannelType.GuildMedia]: "media",
  };
  return names[type] || `type ${type}`;
}

function formatMemberInfo(member) {
  const warnings = getMemberWarnings(member.guild.id, member.id);
  const roles = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => `@${role.name}`);
  const roleText = roles.length ? roles.slice(0, 15).join(", ") : "none";
  const extraRoles = roles.length > 15 ? ` (+${roles.length - 15} more)` : "";

  return [
    `User info for ${member.displayName}, ${member.user.username}`,
    `ID: ${member.id}`,
    `Mention: <@${member.id}>`,
    `Bot: ${formatBoolean(member.user.bot)}`,
    `Account created: ${discordTimestamp(member.user.createdAt)}`,
    `Joined server: ${discordTimestamp(member.joinedAt)}`,
    `Highest role: ${member.roles.highest?.id === member.guild.id ? "none" : `@${member.roles.highest.name}`}`,
    `Roles (${roles.length}): ${roleText}${extraRoles}`,
    `Stored warnings: ${warnings.length}`,
    `Avatar: ${member.user.displayAvatarURL({ size: 1024 })}`,
  ].join("\n");
}

function formatServerInfo(guild) {
  const textChannels = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildText).size;
  const voiceChannels = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildVoice).size;
  const categories = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildCategory).size;

  return [
    `Server info for ${guild.name}`,
    `ID: ${guild.id}`,
    `Owner ID: ${guild.ownerId}`,
    `Created: ${discordTimestamp(guild.createdAt)}`,
    `Members: ${guild.memberCount}`,
    `Channels: ${guild.channels.cache.size} total (${textChannels} text, ${voiceChannels} voice, ${categories} categories)`,
    `Roles: ${guild.roles.cache.filter((role) => role.id !== guild.id).size}`,
    `Boost tier: ${guild.premiumTier ?? 0}`,
    `Boosts: ${guild.premiumSubscriptionCount ?? 0}`,
    `Icon: ${guild.iconURL({ size: 1024 }) || "none"}`,
  ].join("\n");
}

function formatChannelInfo(channel) {
  const overwrites = "permissionOverwrites" in channel ? channel.permissionOverwrites.cache.size : 0;
  const topic = "topic" in channel && channel.topic ? channel.topic : null;
  const slowmode = "rateLimitPerUser" in channel ? channel.rateLimitPerUser : null;

  const lines = [
    `Channel info for ${channel.name ? `#${channel.name}` : channel.id}`,
    `ID: ${channel.id}`,
    `Type: ${channelTypeName(channel.type)}`,
    `Created: ${discordTimestamp(channel.createdAt)}`,
    `Category: ${channel.parent?.name ?? "none"}`,
    `Position: ${channel.rawPosition ?? "unknown"}`,
    `Permission overwrites: ${overwrites}`,
  ];

  if (slowmode != null) lines.push(`Slowmode: ${slowmode} second${slowmode === 1 ? "" : "s"}`);
  if (topic) lines.push(`Topic: ${topic.slice(0, 500)}`);

  return lines.join("\n");
}

function formatRoleInfo(role) {
  const memberCount = role.guild.members.cache.filter((member) => member.roles.cache.has(role.id)).size;
  const permissions = role.permissions.toArray();
  const permissionText = permissions.length ? permissions.slice(0, 20).join(", ") : "none";
  const extraPermissions = permissions.length > 20 ? ` (+${permissions.length - 20} more)` : "";

  return [
    `Role info for @${role.name}`,
    `ID: ${role.id}`,
    `Mention: <@&${role.id}>`,
    `Created: ${discordTimestamp(role.createdAt)}`,
    `Members: ${memberCount}`,
    `Position: ${role.position}`,
    `Color: ${role.hexColor}`,
    `Hoisted: ${formatBoolean(role.hoist)}`,
    `Mentionable: ${formatBoolean(role.mentionable)}`,
    `Managed: ${formatBoolean(role.managed)}`,
    `Permissions: ${permissionText}${extraPermissions}`,
  ].join("\n");
}

function loadQuotes() {
  const quotes = loadJsonFile(quotesPath, DEFAULT_QUOTES);
  return Array.isArray(quotes) ? quotes.filter((quote) => typeof quote === "string" && quote.trim()) : [...DEFAULT_QUOTES];
}

function saveQuotes(quotes) {
  saveJsonFile(quotesPath, quotes);
}

function parseReminderDuration(text) {
  const match = String(text || "").trim().match(/^(\d{1,4})(s|m|h|d)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const seconds = unit === "s" ? amount
    : unit === "m" ? amount * 60
      : unit === "h" ? amount * 60 * 60
        : amount * 24 * 60 * 60;
  if (seconds < 1 || seconds > 7 * 24 * 60 * 60) return null;
  return seconds;
}

function formatRulesText() {
  return [
    "Server Rules",
    "1. Be civil. Treat everyone with respect and keep the chat friendly.",
    "2. No scams, spam, or malicious links.",
    "3. No politics in general chat.",
    "4. No hate content or extremist content.",
    "5. No unnecessary drama or harassment.",
    "6. Ask before inviting people if that is expected in this server.",
  ].join("\n");
}

function formatShipResult(memberA, memberB) {
  const pairKey = [memberA.id, memberB.id].sort().join("-");
  const pct = Number.parseInt(createHash("sha256").update(pairKey).digest("hex").slice(0, 8), 16) % 101;
  const filled = "#".repeat(Math.floor(pct / 10));
  const empty = "-".repeat(10 - Math.floor(pct / 10));
  const verdict = pct >= 90 ? "soulmates"
    : pct >= 70 ? "pretty solid"
      : pct >= 40 ? "could go either way"
        : pct >= 15 ? "rough start"
          : "please don't";
  return [
    "Ship Calculator",
    `${memberA.displayName} x ${memberB.displayName}`,
    `[${filled}${empty}] ${pct}%`,
    verdict,
  ].join("\n");
}

function parseSpinOptions(text) {
  return text
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function makeUtilityHelp() {
  return [
    "Utility commands:",
    ...UTILITY_COMMANDS.map((item) => `- ${item}`),
  ].join("\n");
}

async function makeUtilityResponse(message, text) {
  const normalized = normalizeText(text);

  if (/^(help|commands|tools|what can you do)\b/.test(normalized)) {
    return [
      makeUtilityHelp(),
      "",
      "Moderation examples:",
      "- `duck warn @user spam`",
      "- `duck timeout @user 10m flooding`",
      "- `duck purge 25`",
      "- `duck lock #general`",
    ].join("\n");
  }

  if (/^(ping|latency)\b/.test(normalized)) {
    return `Pong. Discord gateway ping: ${Math.round(client.ws.ping)}ms.`;
  }

  if (/^(rules|sendrules)\b/.test(normalized)) {
    return formatRulesText();
  }

  if (/^quote\b/.test(normalized)) {
    const rest = text.replace(/^quote\b/i, "").trim();
    const quotes = loadQuotes();

    if (/^add\b/i.test(rest)) {
      const quoteText = rest.replace(/^add\b/i, "").trim();
      if (!quoteText) return "Usage: `duck quote add <text>`";
      quotes.push(limitDiscordContent(quoteText, 500));
      saveQuotes(quotes);
      return `Quote #${quotes.length} saved.`;
    }

    if (/^list\b/i.test(rest)) {
      if (!quotes.length) return "No quotes saved yet.";
      return quotes.slice(0, 20).map((quote, index) => `${index + 1}. ${quote}`).join("\n");
    }

    if (!quotes.length) return "No quotes saved yet. Add one with `duck quote add <text>`.";
    return quotes[Math.floor(Math.random() * quotes.length)];
  }

  if (/^ship\b/.test(normalized)) {
    const members = [...message.mentions.members.values()].filter((member) => !member.user.bot);
    const memberA = members[0] ?? findMemberByTextReference(message, text.replace(/^ship\b/i, "")) ?? message.member;
    const memberB = members[1] ?? (members[0] ? message.member : null);
    if (!memberA || !memberB) return "Usage: `duck ship @user [@user]`";
    return formatShipResult(memberA, memberB);
  }

  if (/^curse\b/.test(normalized)) {
    const target = findUtilityMemberTarget(message, text.replace(/^curse\b/i, ""), true);
    const blessing = Math.random() < 0.5;
    const textPool = blessing ? BLESSINGS : CURSES;
    const result = textPool[Math.floor(Math.random() * textPool.length)];
    return `${blessing ? "Blessing granted" : "Curse cast"} on ${target.displayName}: ${result}`;
  }

  if (/^spinwheel\b/.test(normalized)) {
    const options = parseSpinOptions(text.replace(/^spinwheel\b/i, "").trim());
    if (options.length < 2) return "Give me at least 2 comma-separated options, like `duck spinwheel pizza, tacos, sushi`.";
    return `Landed on: ${options[Math.floor(Math.random() * options.length)]}`;
  }

  if (/^remind\b/.test(normalized)) {
    const match = text.match(/^remind\s+(\S+)\s+([\s\S]+)/i);
    if (!match) return "Usage: `duck remind 10m check the logs`";
    const seconds = parseReminderDuration(match[1]);
    const reminderText = match[2].trim();
    if (!seconds || !reminderText) return "Pick a reminder time from 1 second to 7 days. Use `s`, `m`, `h`, or `d`.";
    setTimeout(() => {
      message.channel.send({
        content: `<@${message.author.id}> Reminder: ${limitDiscordContent(reminderText, 1700)}`,
        allowedMentions: { users: [message.author.id] },
      }).catch((err) => logWarn("reminder.send-failed", { messageId: message.id, error: err?.message || String(err) }));
    }, seconds * 1000);
    return `Reminder set for ${match[1]}.`;
  }

  if (/^(botinfo|bot info|about duck|version)\b/.test(normalized)) {
    return [
      `Duck bot info`,
      `Version: ${packageInfo.version}`,
      `Commit: ${buildInfo.commit}`,
      `Commit name: ${buildInfo.commitName}`,
      `Branch: ${buildInfo.branch}`,
      `Node: ${process.version}`,
      `AI provider: ${process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "none")}`,
    ].join("\n");
  }

  if (/\b(serverinfo|server info|guildinfo|guild info)\b/.test(normalized)) {
    return formatServerInfo(message.guild);
  }

  if (/\b(userinfo|user info|whois|who is)\b/.test(normalized)) {
    const member = findUtilityMemberTarget(message, text, true);
    return formatMemberInfo(member);
  }

  if (/\b(avatar|pfp|profile picture)\b/.test(normalized)) {
    const member = findUtilityMemberTarget(message, text, true);
    return `${member.displayName}, ${member.user.username}'s avatar:\n${member.user.displayAvatarURL({ size: 1024 })}`;
  }

  if (/\b(channelinfo|channel info)\b/.test(normalized)) {
    const targetText = text.replace(/\b(channelinfo|channel info|channel)\b/gi, " ").trim();
    const channel = message.mentions.channels.first()
      ?? findChannelByToolTarget(message, targetText)
      ?? findChannelByNameOrMention(message, targetText)
      ?? message.channel;
    return formatChannelInfo(channel);
  }

  if (/\b(roleinfo|role info)\b/.test(normalized)) {
    const targetText = text.replace(/\b(roleinfo|role info|role)\b/gi, " ").trim();
    const role = message.mentions.roles.first()
      ?? findRoleByToolTarget(message, targetText)
      ?? findRoleByNameOrMention(message, targetText);
    if (!role) return "Mention a role or use its exact name so I can show role info.";
    return formatRoleInfo(role);
  }

  if (/^(warning|warnings|warns)\b|\b(view|show|list)\b.*\b(warning|warnings|warns)\b/.test(normalized)) {
    if (!hasPermission(message.member, PermissionsBitField.Flags.ModerateMembers)) {
      return "You need Moderate Members permission to view stored warnings.";
    }
    const member = findUtilityMemberTarget(message, text, true);
    return formatWarningsForMember(member, getMemberWarnings(message.guild.id, member.id));
  }

  return null;
}

async function sendMessageChunks(message, content) {
  const chunks = splitDiscordLines(String(content ?? "").split(/\r?\n/));
  const first = await message.reply({ content: chunks[0], allowedMentions: { repliedUser: false } });
  for (const chunk of chunks.slice(1)) {
    await message.channel.send({ content: chunk, allowedMentions: { repliedUser: false } }).catch(() => {});
  }
  return first;
}

function makeMessageWithContent(message, content) {
  const planningMessage = Object.create(message);
  Object.defineProperty(planningMessage, "content", {
    value: content,
    configurable: true,
  });
  return planningMessage;
}

async function isReplyToDuck(message, client) {
  if (!message.reference?.messageId) return false;
  if (message.mentions.repliedUser?.id === client.user.id) return true;

  try {
    const referenced = await message.channel.messages.fetch(message.reference.messageId);
    return referenced.author.id === client.user.id;
  } catch {
    return false;
  }
}

async function getDuckInvocation(message, client) {
  const botMention = new RegExp(`<@!?${client.user.id}>`, "g");
  const mentionedDuck = botMention.test(message.content);
  const saysDuck = /\bduck\b/i.test(message.content);
  const repliedToDuck = await isReplyToDuck(message, client);
  const invoked = mentionedDuck || saysDuck || repliedToDuck;

  if (!invoked) {
    return { invoked: false, content: message.content };
  }

  const content = message.content
    .replace(botMention, " ")
    .replace(/\bduck\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { invoked: true, content };
}

function startKeepAliveServer() {
  if (!getEnvBoolean("DUCK_KEEP_ALIVE", false) || keepAliveServer) return;

  const port = Math.max(1, Math.min(Number(process.env.PORT) || Number(process.env.DUCK_KEEP_ALIVE_PORT) || 8080, 65535));
  keepAliveServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Duck is alive.");
  });
  keepAliveServer.on("error", (err) => {
    logWarn("keep-alive.failed", { port, error: err?.message || String(err) });
    keepAliveServer = null;
  });
  keepAliveServer.listen(port, "0.0.0.0", () => {
    logInfo("keep-alive.listening", { port });
  });
}

async function sendLogMessage(guild, title, fields = {}) {
  const channelId = getEntryChannelConfig(guild.id).logChannelId;
  if (!channelId) return;
  const channel = await cachedChannel(guild, channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !("send" in channel)) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x3b82f6)
    .setTimestamp(new Date());
  for (const [name, value] of Object.entries(fields)) {
    embed.addFields({ name, value: String(value).slice(0, 1024), inline: false });
  }
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    logWarn("log-channel.send-failed", { guildId: guild.id, channelId, error: err?.message || String(err) });
  });
}

async function handleMemberJoin(member) {
  const welcomeChannelId = getEnvId("DUCK_WELCOME_CHANNEL_ID");
  const entryConfig = getEntryChannelConfig(member.guild.id);
  const entryCategoryId = entryConfig.categoryId;
  const rulesUrl = entryConfig.rulesUrl || "";
  const announcementsUrl = entryConfig.announcementsUrl || "";

  if (welcomeChannelId) {
    const welcomeChannel = await cachedChannel(member.guild, welcomeChannelId).catch(() => null);
    if (welcomeChannel?.isTextBased?.() && "send" in welcomeChannel) {
      await welcomeChannel.send({
        content: `Welcome <@${member.id}> to ${member.guild.name}.`,
        allowedMentions: { users: [member.id] },
      }).catch((err) => logWarn("welcome.send-failed", { guildId: member.guild.id, memberId: member.id, error: err?.message || String(err) }));
    }
  }

  if (entryCategoryId && entryConfig.enabled) {
    const botMember = await cachedBotMember(member.guild);
    if (!hasPermission(botMember, PermissionsBitField.Flags.ManageChannels)) {
      logWarn("entry-channel.missing-permission", { guildId: member.guild.id, memberId: member.id });
    } else {
      const owner = await cachedMember(member.guild, member.guild.ownerId).catch(() => null);
      const permissionOverwrites = [
        { id: member.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ];
      if (owner) {
        permissionOverwrites.push({
          id: owner.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
        });
      }

      const channel = await member.guild.channels.create({
        name: `entry-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 90),
        type: ChannelType.GuildText,
        parent: entryCategoryId,
        permissionOverwrites,
        reason: "Duck member entry room",
      }).catch((err) => {
        logWarn("entry-channel.create-failed", { guildId: member.guild.id, memberId: member.id, error: err?.message || String(err) });
        return null;
      });

      if (channel) {
        const links = [rulesUrl && `<${rulesUrl}>`, announcementsUrl && `<${announcementsUrl}>`].filter(Boolean).join(" and ");
        await channel.send({
          content: [
            `Hey <@${member.id}>. Glad you made it to the server.`,
            links ? `Take a look at ${links} while you wait.` : "Your account will be reviewed shortly.",
          ].join("\n\n"),
          allowedMentions: { users: [member.id] },
        }).catch(() => {});
        await sendLogMessage(member.guild, "New Person Arrived", {
          User: `${member.user.tag} (${member.id})`,
          "Private Channel": `<#${channel.id}>`,
        });
      }
    }
  }
}

async function handleMemberRemove(member) {
  const welcomeChannelId = getEnvId("DUCK_WELCOME_CHANNEL_ID");
  if (welcomeChannelId) {
    const channel = await cachedChannel(member.guild, welcomeChannelId).catch(() => null);
    if (channel?.isTextBased?.() && "send" in channel) {
      await channel.send({
        content: `${member.user.username} has left the server.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }

  await sendLogMessage(member.guild, "Member Left", {
    User: `${member.user.tag} (${member.id})`,
  });
}

async function cleanupOldInvites() {
  const lifetimeDays = Math.max(1, Number(process.env.DUCK_INVITE_LIFETIME_DAYS) || 3);
  const cutoff = Date.now() - lifetimeDays * 24 * 60 * 60 * 1000;
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      for (const invite of invites.values()) {
        if (invite.createdTimestamp && invite.createdTimestamp <= cutoff) {
          await invite.delete(`Duck automated ${lifetimeDays}-day invite cleanup`);
          logInfo("invite.deleted-old", { guildId: guild.id, code: invite.code, lifetimeDays });
        }
      }
    } catch (err) {
      logWarn("invite.cleanup-failed", { guildId: guild.id, error: err?.message || String(err) });
    }
  }
}

function startInviteCleanupLoop() {
  if (!getEnvBoolean("DUCK_INVITE_CLEANUP", false) || inviteCleanupTimer) return;
  inviteCleanupTimer = setInterval(() => {
    cleanupOldInvites().catch((err) => logWarn("invite.cleanup-loop-failed", { error: err?.message || String(err) }));
  }, 60 * 60 * 1000);
  cleanupOldInvites().catch((err) => logWarn("invite.cleanup-start-failed", { error: err?.message || String(err) }));
}

async function registerCommands(client) {
  const startedAt = Date.now();
  const setupCommand = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Choose the channel where Duck listens for AI moderation requests.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel Duck should listen in.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    );

  const toolsCommand = new SlashCommandBuilder()
    .setName("duck-tools")
    .setDescription("Show Duck's moderation tools.");

  const entrySetupCommand = new SlashCommandBuilder()
    .setName("entry-setup")
    .setDescription("Configure Duck's private new-user entry channels.")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Whether Duck should create private entry channels for new members.")
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("category")
        .setDescription("Category where private entry channels should be created.")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("rules-url")
        .setDescription("Rules channel URL to show in entry channels.")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("announcements-url")
        .setDescription("Announcements channel URL to show in entry channels.")
        .setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName("log-channel")
        .setDescription("Staff log channel for entry/leave logs.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    );

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [setupCommand.toJSON(), toolsCommand.toJSON(), entrySetupCommand.toJSON()],
  });
  logInfo("discord.commands-registered", { appId: client.user.id, ms: elapsedMs(startedAt) });
}

requireConfig();
loadPendingActions();
startKeepAliveServer();
startCacheMaintenance();
process.once("beforeExit", flushJsonWrites);
process.once("SIGINT", () => flushRuntimeStateAndExit("SIGINT"));
process.once("SIGTERM", () => flushRuntimeStateAndExit("SIGTERM"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  logInfo("discord.ready", {
    user: client.user.tag,
    userId: client.user.id,
    guilds: client.guilds.cache.size,
    version: packageInfo.version,
    commit: buildInfo.commit,
    commitName: buildInfo.commitName,
  });
  client.user.setPresence({
    activities: [
      {
        name: "for duck / @Duck",
        type: ActivityType.Watching,
      },
    ],
    status: "online",
  });

  logInfo("pending-actions.ready", { count: pendingActions.size });
  startInviteCleanupLoop();
  try {
    await registerCommands(client);
  } catch (err) {
    logError("discord.commands-register-failed", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: "Only an Administrator can set up Duck.", ephemeral: true });
          return;
        }

        const channel = interaction.options.getChannel("channel", true);
        updateGuildSettings(interaction.guildId, { modChannelId: channel.id });
        logInfo("settings.mod-channel-updated", {
          guildId: interaction.guildId,
          channelId: channel.id,
          userId: interaction.user.id,
        });
        await interaction.reply(`Duck will now listen in ${channel}.`);
        return;
      }

      if (interaction.commandName === "duck-tools") {
        const lines = [
          "Moderation tools:",
          ...TOOL_DEFINITIONS.map((tool) => `- \`${tool.name}\` (${tool.risk}): ${tool.description}`),
          "",
          ...makeUtilityHelp().split("\n"),
        ];
        const chunks = splitDiscordLines(lines);
        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp({ content: chunk, ephemeral: true });
        }
        return;
      }

      if (interaction.commandName === "entry-setup") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: "Only an Administrator can configure entry channels.", ephemeral: true });
          return;
        }

        const enabled = interaction.options.getBoolean("enabled", true);
        const category = interaction.options.getChannel("category", false);
        const logChannel = interaction.options.getChannel("log-channel", false);
        const rulesUrl = interaction.options.getString("rules-url", false);
        const announcementsUrl = interaction.options.getString("announcements-url", false);
        const current = getEntryChannelConfig(interaction.guildId);
        const nextCategoryId = category?.id ?? current.categoryId;

        if (enabled && !nextCategoryId) {
          await interaction.reply({
            content: "Pick a category when enabling entry channels. Example: `/entry-setup enabled:true category:<category>`",
            ephemeral: true,
          });
          return;
        }

        const updated = updateEntryChannelConfig(interaction.guildId, {
          enabled,
          categoryId: nextCategoryId ?? null,
          logChannelId: logChannel?.id ?? current.logChannelId ?? null,
          rulesUrl: rulesUrl ?? current.rulesUrl ?? "",
          announcementsUrl: announcementsUrl ?? current.announcementsUrl ?? "",
        });

        logInfo("settings.entry-channels-updated", {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          enabled: updated.enabled,
          categoryId: updated.categoryId,
          logChannelId: updated.logChannelId,
          hasRulesUrl: Boolean(updated.rulesUrl),
          hasAnnouncementsUrl: Boolean(updated.announcementsUrl),
        });

        await interaction.reply({
          content: [
            `Entry channels are now ${updated.enabled ? "enabled" : "disabled"}.`,
            `Category: ${updated.categoryId ? `<#${updated.categoryId}>` : "not set"}`,
            `Log channel: ${updated.logChannelId ? `<#${updated.logChannelId}>` : "not set"}`,
            `Rules URL: ${updated.rulesUrl || "not set"}`,
            `Announcements URL: ${updated.announcementsUrl || "not set"}`,
          ].join("\n"),
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [kind, actionId] = interaction.customId.split(":");
      if (kind === "duck_confirm") {
        await approveAction(interaction, actionId, client);
      } else if (kind === "duck_cancel") {
        await cancelAction(interaction, actionId);
      }
    }
  } catch (err) {
    console.error("Interaction failed:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Duck hit an error while handling that.", ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (err) {
    logError("member-join.failed", err, { guildId: member.guild.id, memberId: member.id });
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await handleMemberRemove(member);
  } catch (err) {
    logError("member-remove.failed", err, { guildId: member.guild.id, memberId: member.id });
  }
});

client.on(Events.MessageDelete, (message) => {
  removeCachedMessage(message);
});

client.on(Events.MessageBulkDelete, (messages) => {
  removeCachedMessages(messages);
});

client.on(Events.MessageCreate, async (message) => {
  const messageStartedAt = Date.now();
  try {
    rememberMessage(message);
    if (!message.guild || message.author.bot) return;

    const guildSettings = getGuildSettings(message.guildId);
    const configuredChannelId = guildSettings.modChannelId;
    const invocation = await getDuckInvocation(message, client);
    const legacyCommandContent = getLegacyCommandContent(message.content);
    const inConfiguredChannel = configuredChannelId && message.channelId === configuredChannelId;
    logDebug("message.received", {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      inConfiguredChannel: Boolean(inConfiguredChannel),
      invoked: invocation.invoked,
      legacyCommand: Boolean(legacyCommandContent),
      contentLength: message.content.length,
    });

    if (legacyCommandContent) {
      const legacyMessage = makeMessageWithContent(message, legacyCommandContent);
      const utilityResponse = await makeUtilityResponse(legacyMessage, legacyCommandContent);
      if (utilityResponse) {
        await sendMessageChunks(message, utilityResponse);
        logInfo("message.legacy-utility-response", {
          messageId: message.id,
          ms: elapsedMs(messageStartedAt),
        });
        return;
      }
    }

    const isConfirmText = normalizeText(message.content) === "i confirm";
    if (isConfirmText) {
      const actionId = pendingByChannel.get(message.channelId);
      if (actionId) {
        await approveAction(message, actionId, client);
        return;
      }
    }

    if (isNegativeConfirmation(message.content) && await cancelLatestActionFromMessage(message)) {
      return;
    }

    if (!inConfiguredChannel && !invocation.invoked) return;

    if (invocation.invoked && !invocation.content) {
      await message.reply({ content: makeDuckHelp(invocation.content), allowedMentions: { repliedUser: false } });
      return;
    }

    const planningMessage = invocation.invoked
      ? makeMessageWithContent(message, invocation.content)
      : message;
    const wantsToolPlan = isLikelyModerationRequest(planningMessage.content);

    const utilityResponse = await makeUtilityResponse(planningMessage, planningMessage.content);
    if (utilityResponse) {
      await sendMessageChunks(message, utilityResponse);
      logInfo("message.utility-response", {
        messageId: message.id,
        ms: elapsedMs(messageStartedAt),
      });
      return;
    }

    const queueMessage = hasConfiguredAi()
      ? await message.reply({ content: getQueueMessage(), allowedMentions: { repliedUser: false } }).catch(() => null)
      : null;
    if (queueMessage) {
      logDebug("message.queue-posted", {
        messageId: message.id,
        queueMessageId: queueMessage.id,
        ms: elapsedMs(messageStartedAt),
      });
    }

    if (wantsRecentHistory(planningMessage, planningMessage.content)) {
      const content = await makeRecentHistoryResponse(message);
      logInfo("message.history-response", {
        messageId: message.id,
        queueMessageId: queueMessage?.id,
        ms: elapsedMs(messageStartedAt),
      });
      if (queueMessage) {
        await queueMessage.edit({ content }).catch(() => {});
      } else {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      }
      return;
    }

    let plan = null;
    let toolResponseContent = null;
    let chatError = null;
    if (wantsToolPlan) {
      if (hasConfiguredAi()) {
        const chatResult = await generateChatResponse(planningMessage);
        chatError = chatResult.error;
        if (chatResult.content) {
          const parsedToolCall = parseInlineToolCall(planningMessage, chatResult.content);
          toolResponseContent = parsedToolCall.content;
          plan = parsedToolCall.plan;
          logDebug("message.inline-tool-parsed", {
            messageId: message.id,
            hasPlan: Boolean(plan),
            tool: plan?.tool,
            planError: plan?.error,
            hasResponseContent: Boolean(toolResponseContent),
            ms: elapsedMs(messageStartedAt),
          });
        }
      }

      if (!plan) {
        const shouldSkipPlannerFallback = isLikelySpeakRequest(planningMessage.content)
          && Boolean(toolResponseContent)
          && !hasExplicitSpeakMessage(planningMessage.content);
        if (!shouldSkipPlannerFallback) {
          plan = await planModerationRequest(planningMessage);
          if (!toolResponseContent && chatError) {
            toolResponseContent = chatError;
          }
        }
      }
      logDebug("message.plan-finished", {
        messageId: message.id,
        hasPlan: Boolean(plan),
        tool: plan?.tool,
        planError: plan?.error,
        ms: elapsedMs(messageStartedAt),
      });
    } else {
      logDebug("message.chat-first", {
        messageId: message.id,
        reason: "not-likely-moderation-request",
        ms: elapsedMs(messageStartedAt),
      });
    }

    if (!plan) {
      const chatResult = toolResponseContent
        ? { content: toolResponseContent, error: chatError }
        : hasConfiguredAi()
          ? await generateChatResponse(planningMessage)
          : { content: null, error: "AI is not configured, so I cannot answer as a chatbot right now." };
      const content = chatResult.content
        ?? chatResult.error
        ?? (invocation.invoked ? makeDuckHelp(invocation.content) : null);
      logInfo("message.chat-finished", {
        messageId: message.id,
        hasChatResponse: Boolean(chatResult.content),
        chatError: chatResult.error,
        hasContent: Boolean(content),
        queueMessageId: queueMessage?.id,
        ms: elapsedMs(messageStartedAt),
      });

      if (content && queueMessage) {
        const parsedToolCall = parseInlineToolCall(planningMessage, content);
        if (parsedToolCall.plan && !parsedToolCall.plan.error) {
          const needed = TOOL_REQUIREMENTS[parsedToolCall.plan.tool];
          if (!needed || hasPermission(message.member, needed)) {
            await promptForConfirmation(message, parsedToolCall.plan, {
              messageToEdit: queueMessage,
              content: parsedToolCall.content || "Prepared a moderation plan. Waiting for Administrator confirmation.",
              useEmbed: true,
            });
            logInfo("message.inline-moderation-planned", {
              messageId: message.id,
              tool: parsedToolCall.plan.tool,
              queueMessageId: queueMessage.id,
              ms: elapsedMs(messageStartedAt),
            });
            return;
          }
        }
        await queueMessage.edit({ content: parsedToolCall.content || content, allowedMentions: { repliedUser: false } }).catch(() => {});
      } else if (content) {
        const parsedToolCall = parseInlineToolCall(planningMessage, content);
        await message.reply({ content: parsedToolCall.content || content, allowedMentions: { repliedUser: false } });
      } else if (queueMessage) {
        await queueMessage.edit({ content: "I tried to answer, but AI returned no content and I do not have a local fallback for that." }).catch(() => {});
      }
      return;
    }

    if (plan.error) {
      logWarn("message.plan-error", {
        messageId: message.id,
        error: plan.error,
        queueMessageId: queueMessage?.id,
        ms: elapsedMs(messageStartedAt),
      });
      if (queueMessage) {
        await queueMessage.edit({ content: plan.error }).catch(() => {});
      } else {
        await message.reply(plan.error);
      }
      return;
    }

    const needed = TOOL_REQUIREMENTS[plan.tool];
    if (needed && !hasPermission(message.member, needed)) {
      const content = `You need the Discord permission for \`${plan.tool}\` before I can prepare that action. Required: ${describePermissionRequirement(needed)}.`;
      logWarn("message.requester-missing-permission", {
        messageId: message.id,
        tool: plan.tool,
        requesterId: message.author.id,
        needed,
      });
      if (queueMessage) {
        await queueMessage.edit({ content }).catch(() => {});
      } else {
        await message.reply(content);
      }
      return;
    }

    const confirmationContent = toolResponseContent || "Prepared a moderation plan. Waiting for Administrator confirmation.";
    if (queueMessage) {
      await promptForConfirmation(message, plan, {
        messageToEdit: queueMessage,
        content: confirmationContent,
        useEmbed: true,
      });
    } else {
      await promptForConfirmation(message, plan, {
        content: confirmationContent,
        useEmbed: true,
      });
    }
    logInfo("message.moderation-planned", {
      messageId: message.id,
      tool: plan.tool,
      queueMessageId: queueMessage?.id,
      ms: elapsedMs(messageStartedAt),
    });
  } catch (err) {
    logError("message.handler-failed", err, {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      ms: elapsedMs(messageStartedAt),
    });
    await message.reply("Duck hit an error while planning that moderation action.").catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
