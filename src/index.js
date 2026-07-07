import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const pendingActions = new Map();
const pendingByChannel = new Map();
const pendingExpiryTimers = new Map();
const serverContextCache = new Map();
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
    description: "Delete a server channel. Administrator confirmation required.",
  },
  {
    name: "purge_messages",
    risk: "medium",
    description: "Bulk delete recent messages in the current channel.",
  },
  {
    name: "warn_member",
    risk: "medium",
    description: "Warn a mentioned server member with a direct message when possible.",
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

const TOOL_REQUIREMENTS = {
  ban_member: PermissionsBitField.Flags.BanMembers,
  kick_member: PermissionsBitField.Flags.KickMembers,
  timeout_member: PermissionsBitField.Flags.ModerateMembers,
  delete_channel: PermissionsBitField.Flags.ManageChannels,
  purge_messages: PermissionsBitField.Flags.ManageMessages,
  warn_member: PermissionsBitField.Flags.ModerateMembers,
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
  try {
    if (!fs.existsSync(settingsPath)) return { guilds: {} };
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return { guilds: {} };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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

function getQueueMessage() {
  return process.env.DUCK_QUEUE_MESSAGE || "Duck is thinking...";
}

function savePendingActions() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pendingActionsPath, JSON.stringify([...pendingActions.values()], null, 2));
  logDebug("pending-actions.saved", { count: pendingActions.size });
}

function schedulePendingExpiry(action) {
  if (pendingExpiryTimers.has(action.id)) {
    clearTimeout(pendingExpiryTimers.get(action.id));
  }

  const expiresAt = action.expiresAt ?? action.createdAt + getPendingActionTtlMs();
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    logInfo("pending-action.expired", { actionId: action.id, tool: action.tool, channelId: action.channelId });
    pendingActions.delete(action.id);
    pendingExpiryTimers.delete(action.id);
    if (pendingByChannel.get(action.channelId) === action.id) {
      pendingByChannel.delete(action.channelId);
    }
    savePendingActions();
  }, delay);

  pendingExpiryTimers.set(action.id, timer);
}

function rebuildPendingByChannel() {
  pendingByChannel.clear();
  const actions = [...pendingActions.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const action of actions) {
    pendingByChannel.set(action.channelId, action.id);
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
      if (!action?.id || !action.channelId || !action.guildId) continue;

      const expiresAt = action.expiresAt ?? action.createdAt + ttl;
      if (expiresAt <= now) {
        skipped += 1;
        continue;
      }

      const hydrated = { ...action, expiresAt };
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
    contextChannels: process.env.AI_CONTEXT_CHANNELS || "20",
    contextMessagesPerChannel: process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL || "10",
    contextMaxMessages: process.env.AI_CONTEXT_MAX_MESSAGES || "120",
    contextCacheTtlMs: getServerContextCacheTtlMs(),
    contextMemberLimit: getAiContextMemberLimit(),
    contextChannelLimit: getAiContextChannelLimit(),
    contextRoleLimit: getAiContextRoleLimit(),
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

function extractQuotedName(text) {
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1].trim();
  return null;
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
  return /\b(ban|banish|soft\s*ban|kick|timeout|mute|untimeout|unmute|warn|warning|slowmode|lock|lockdown|unlock|purge|delete|remove|nickname|nick|rename|topic|role|disconnect|voice kick|voice mute|voice unmute|server mute|server unmute|deafen|undeafen|move|create|make|new)\b/.test(normalized)
    && /\b(member|user|person|him|her|them|message|messages|channel|role|topic|slowmode|timeout|mute|unmute|deafen|undeafen|ban|kick|warn|nickname|nick|voice|purge|delete|lock|unlock|create|make)\b|<@!?(\d+)>|<#(\d+)>|<@&(\d+)>/.test(normalized);
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
    const channel = findChannelByNameOrMention(message, text);
    if (!channel) return { error: "I could not find that channel." };
    return {
      tool: "delete_channel",
      risk: "critical",
      channelId: channel.id,
      channelName: channel.name,
      summary: `delete the channel "${channel.name}"`,
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

async function collectRecentMessages(message) {
  const startedAt = Date.now();
  const maxChannels = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_CHANNELS) || 20, 100));
  const perChannel = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL) || 10, 50));
  const maxTotal = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MAX_MESSAGES) || 120, 500));
  const seen = new Set();
  const candidates = [
    message.channel,
    ...message.guild.channels.cache
      .filter((channel) => channel.id !== message.channelId && channel.isTextBased?.() && "messages" in channel)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];
  const recentMessages = [];
  const channelMessages = [];
  const errors = [];

  for (const channel of candidates) {
    if (seen.has(channel.id) || seen.size >= maxChannels || recentMessages.length >= maxTotal) continue;
    seen.add(channel.id);
    if (!channel.isTextBased?.() || !("messages" in channel)) continue;

    try {
      const fetched = await channel.messages.fetch({ limit: perChannel });
      const messagesForChannel = [];
      for (const item of fetched.values()) {
        if (recentMessages.length >= maxTotal) break;
        const summary = {
          id: item.id,
          channelId: channel.id,
          channelName: channel.name,
          authorId: item.author.id,
          authorTag: item.author.tag,
          createdAt: item.createdAt.toISOString(),
          content: item.cleanContent.replace(/\s+/g, " ").slice(0, 220),
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
        readable: false,
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
    ms: elapsedMs(startedAt),
  });

  return { recentMessages, channelMessages };
}

async function collectServerContext(message) {
  const startedAt = Date.now();
  const cacheTtl = getServerContextCacheTtlMs();
  const cacheKey = `${message.guildId}:${message.channelId}`;
  const cached = serverContextCache.get(cacheKey);
  if (cacheTtl > 0 && cached && cached.expiresAt > Date.now()) {
    logDebug("context.cache-hit", {
      cacheKey,
      ttlRemainingMs: cached.expiresAt - Date.now(),
      ms: elapsedMs(startedAt),
    });
    return {
      ...cached.context,
      currentMessage: {
        id: message.id,
        authorId: message.author.id,
        authorTag: message.author.tag,
        content: message.cleanContent.replace(/\s+/g, " ").slice(0, 500),
        createdAt: message.createdAt.toISOString(),
      },
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
  const context = {
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
    currentMessage: {
      id: message.id,
      authorId: message.author.id,
      authorTag: message.author.tag,
      content: message.cleanContent.replace(/\s+/g, " ").slice(0, 500),
      createdAt: message.createdAt.toISOString(),
    },
  };

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
    ms: elapsedMs(startedAt),
  });

  return context;
}

function resolveMemberForPlan(message, plan, allowedMembers) {
  const targetId = String(plan.targetId ?? "");
  const allowed = allowedMembers.find((candidate) => candidate.id === targetId);
  if (allowed) return allowed;

  const cached = targetId ? message.guild.members.cache.get(targetId) : null;
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
    const allowedMembers = context.members ?? context.mentionedMembers ?? [];
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

  if (["set_slowmode", "lock_channel", "unlock_channel", "delete_channel"].includes(tool.name)) {
    const targetChannelId = String(plan.channelId || message.channelId);
    const allowed = message.guild.channels.cache.get(targetChannelId) ?? findChannelByToolTarget(message, plan.channelName || "");
    if (!allowed) return { error: "Mention the channel so I can target the right one." };
    if (tool.name === "delete_channel" && !plan.channelId && !plan.channelName) {
      return { error: "Mention the channel or use its exact name so I can safely target the right channel." };
    }

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

async function makePlannerMessages(message) {
  const context = await collectServerContext(message);
  const tools = TOOL_DEFINITIONS.map((tool) => `${tool.name} (${tool.risk})`).join(", ");
  return [
    {
      role: "system",
      content: [
        "You are Duck's moderation intent planner.",
        "Return only JSON. Do not explain.",
        `Available tools: ${tools}.`,
        "Schema: {\"tool\":\"none|ban_member|kick_member|timeout_member|delete_channel|purge_messages|warn_member|untimeout_member|set_slowmode|lock_channel|unlock_channel|softban_member|delete_user_messages|set_nickname|add_role|remove_role|disconnect_member|move_member|voice_mute_member|voice_unmute_member|deafen_member|undeafen_member|create_text_channel|create_voice_channel|rename_channel|set_channel_topic|create_role|delete_role\",\"targetId\":\"member id when needed\",\"targetName\":\"member name only if id is unavailable\",\"channelId\":\"channel id when needed\",\"roleId\":\"role id when needed\",\"roleName\":\"role name when needed\",\"targetRoleName\":\"role name for add/remove role\",\"channelName\":\"new or target channel name when needed\",\"newName\":\"new channel name when renaming\",\"topic\":\"new channel topic\",\"nickname\":\"new nickname when needed\",\"count\":number,\"durationMs\":number,\"deleteMessageSeconds\":number,\"seconds\":number,\"reason\":\"short reason\"}.",
        "Tool calling tutorial: identify the user's moderation intent, choose exactly one tool, fill only the fields that tool needs, and use IDs from serverContext instead of names whenever targeting existing objects. If a user typed @name but no ID is obvious, put that exact name in targetName.",
        "Use ban_member for permanent bans, softban_member for ban-and-unban cleanup, kick_member for removing without banning, timeout_member for temporary mutes, untimeout_member to clear a timeout, warn_member for a warning DM, purge_messages for channel-wide recent deletion, delete_user_messages for one mentioned user's recent messages, set_slowmode for channel rate limits, lock_channel and unlock_channel for @everyone send permissions, set_nickname for nickname changes, add_role and remove_role for role edits, disconnect_member, move_member, voice_mute_member, voice_unmute_member, deafen_member, and undeafen_member for voice moderation, create_text_channel/create_voice_channel for new channels, rename_channel and set_channel_topic for channel edits, create_role/delete_role for role management, and delete_channel only when the user explicitly asks to delete a channel.",
        "Use serverContext.channelMessages for per-channel recent message context. It groups messages by channel so you can understand what happened in each readable channel.",
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
                "warn_member",
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
                "create_role",
                "delete_role",
              ],
            },
            targetId: { type: "string" },
            targetName: { type: "string" },
            channelId: { type: "string" },
            roleId: { type: "string" },
            roleName: { type: "string" },
            targetRoleName: { type: "string" },
            channelName: { type: "string" },
            newName: { type: "string" },
            topic: { type: "string" },
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
  const plannerMessages = await makePlannerMessages(message);
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
    const plan = validateAiPlan(message, parsed);
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
  const plannerMessages = await makePlannerMessages(message);
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
    const plan = validateAiPlan(message, parsed);
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
        "Use serverContext.channelMessages to answer questions about recent messages in specific channels. It groups readable recent messages by channel.",
        "Use the wider server context to answer questions about members, channels, roles, and what has been happening across the server when you can.",
        "Keep replies short, casual, and useful. Do not dump tool instructions unless asked.",
        "You have tools for moderation actions, but you cannot execute moderation directly from chat.",
        "When the user asks for moderation, include exactly one hidden tool marker at the end of your reply using {{tool::target::reason}}.",
        "Use tools ban, softban, kick, timeout, warn, untimeout, purge, delete_user_messages, slowmode, lock, unlock, nickname, add_role, remove_role, disconnect, move, create_channel, create_voice_channel, rename_channel, set_topic, create_role, delete_role, or delete_channel.",
        "Voice tools are also available: voice_mute, voice_unmute, deafen, and undeafen.",
        "Example: I can prepare that warning for approval. {{warn::Ryzen 9 9950X3D2::testing purposes}}",
        "For two-target tools, put both targets in the target slot separated by |. Examples: {{add_role::Ryzen 9 9950X3D2|Member::testing}}, {{move::Ryzen 9 9950X3D2|General Voice::testing}}, {{rename_channel::general|new-general::cleanup}}.",
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
    messageId: message.id,
    channelId: message.channelId,
  });

  const requestChat = () => fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...config.extraHeaders,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.4,
      max_tokens: 220,
      messages,
    }),
  });

  let response;
  try {
    response = await requestChat();
  } catch (err) {
    logError("ai.chat.request-failed", err, {
      providerName: config.providerName,
      model: config.model,
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

  let body = await response.json();
  let choiceMessage = body.choices?.[0]?.message;
  let content = extractAiTextContent(choiceMessage);

  if (!(typeof content === "string" && content.trim()) && typeof choiceMessage?.reasoning === "string" && choiceMessage.reasoning.trim()) {
    logWarn("ai.chat.reasoning-without-content", {
      providerName: config.providerName,
      model: config.model,
      finishReason: body.choices?.[0]?.finish_reason,
      ms: elapsedMs(startedAt),
    });

    messages.push({
      role: "user",
      content: "Return a short visible final answer in message.content. Do not put the answer only in reasoning.",
    });

    try {
      response = await requestChat();
    } catch (err) {
      logError("ai.chat.retry-request-failed", err, {
        providerName: config.providerName,
        model: config.model,
        ms: elapsedMs(startedAt),
      });
    }

    if (response?.ok) {
      body = await response.json();
      choiceMessage = body.choices?.[0]?.message;
      content = extractAiTextContent(choiceMessage);
    }
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
    return "I got the request, but OpenRouter returned internal reasoning without a visible answer. Try once more, or ask me directly for the action you want.";
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
  untimeout: "untimeout_member",
  unmute: "untimeout_member",
  untimeout_member: "untimeout_member",
  purge: "purge_messages",
  purge_messages: "purge_messages",
  delete_messages: "purge_messages",
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

  if (["set_slowmode", "lock_channel", "unlock_channel", "delete_channel", "rename_channel", "set_channel_topic"].includes(tool)) {
    const channel = findChannelByToolTarget(message, primaryTarget);
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
  if (tool === "timeout_member") rawPlan.durationMs = parseDurationMs(`${message.content} ${reason}`);
  if (tool === "set_slowmode") rawPlan.seconds = parseSlowmodeSeconds(`${target} ${reason} ${message.content}`);
  if (tool === "set_nickname") rawPlan.nickname = reason;
  if (tool === "create_text_channel") rawPlan.channelName = target;
  if (tool === "create_voice_channel") rawPlan.channelName = target;
  if (tool === "rename_channel") rawPlan.newName = targetParts[1] ?? reason;
  if (tool === "set_channel_topic") rawPlan.topic = reason;
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
  return member.permissions.has(permission) || member.permissions.has(PermissionsBitField.Flags.Administrator);
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
  if (action.tool === "warn_member") return "Warn";
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
  if (action.newName) details.push(`New name: ${action.newName}`);
  if (action.topic) details.push(`Topic: ${action.topic}`);
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
  if (action.channelName && action.tool !== "delete_channel") lines.push(`Channel: ${action.channelName}`);

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
    channelId: message.channelId,
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
    channelId: message.channelId,
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
  const guild = await client.guilds.fetch(action.guildId);
  const botMember = await guild.members.fetchMe();
  const needed = TOOL_REQUIREMENTS[action.tool];

  if (needed && !hasPermission(botMember, needed)) {
    const result = `I cannot run \`${action.tool}\` because Duck is missing the required Discord permission.`;
    logWarn("moderation.execute.missing-bot-permission", { actionId: action.id, tool: action.tool, needed });
    return result;
  }

  if (action.tool === "ban_member") {
    const member = await guild.members.fetch(action.targetId);
    await member.ban({ reason: `Duck approved by ${approver.user.tag}: ${action.reason}` });
    const result = `I have banned ${member.displayName}, ${member.user.username}.`;
    logInfo("moderation.execute.done", { actionId: action.id, tool: action.tool, ms: elapsedMs(startedAt) });
    return result;
  }

  if (action.tool === "kick_member") {
    const member = await guild.members.fetch(action.targetId);
    const displayName = member.displayName;
    const username = member.user.username;
    await member.kick(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have kicked ${displayName}, ${username}.`;
  }

  if (action.tool === "softban_member") {
    const member = await guild.members.fetch(action.targetId);
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
    const member = await guild.members.fetch(action.targetId);
    await member.timeout(action.durationMs, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have timed out ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "untimeout_member") {
    const member = await guild.members.fetch(action.targetId);
    await member.timeout(null, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have removed timeout from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "warn_member") {
    const member = await guild.members.fetch(action.targetId);
    const warning = `You were warned in ${guild.name}: ${action.reason}`;
    await member.send(warning).catch(() => null);
    return `I have warned ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "set_nickname") {
    const member = await guild.members.fetch(action.targetId);
    await member.setNickname(action.nickname, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have set ${member.user.username}'s nickname to "${action.nickname}".`;
  }

  if (action.tool === "add_role" || action.tool === "remove_role") {
    const member = await guild.members.fetch(action.targetId);
    const role = await guild.roles.fetch(action.roleId);
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
    const member = await guild.members.fetch(action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    await member.voice.disconnect(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have disconnected ${member.displayName}, ${member.user.username} from voice.`;
  }

  if (action.tool === "move_member") {
    const member = await guild.members.fetch(action.targetId);
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return "I can only move members to a voice channel.";
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    await member.voice.setChannel(channel, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have moved ${member.displayName}, ${member.user.username} to ${channel.name}.`;
  }

  if (action.tool === "voice_mute_member" || action.tool === "voice_unmute_member") {
    const member = await guild.members.fetch(action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const mute = action.tool === "voice_mute_member";
    await member.voice.setMute(mute, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return mute
      ? `I have voice muted ${member.displayName}, ${member.user.username}.`
      : `I have removed voice mute from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "deafen_member" || action.tool === "undeafen_member") {
    const member = await guild.members.fetch(action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const deaf = action.tool === "deafen_member";
    await member.voice.setDeaf(deaf, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return deaf
      ? `I have deafened ${member.displayName}, ${member.user.username}.`
      : `I have removed deafen from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "delete_channel") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel) return `I could not find the channel "${action.channelName}".`;
    await channel.delete(`Duck approved by ${approver.user.tag}`);
    return `I have deleted the channel "${action.channelName}".`;
  }

  if (action.tool === "purge_messages") {
    const channel = await guild.channels.fetch(action.channelId);
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
    return `I have deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"}.`;
  }

  if (action.tool === "delete_user_messages") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel?.isTextBased() || !("messages" in channel) || !("bulkDelete" in channel)) {
      return "I can only delete user messages in a text channel.";
    }

    const fetched = await channel.messages.fetch({ limit: 100 });
    const matches = fetched
      .filter((item) => item.author.id === action.targetId)
      .first(action.count);
    const deleted = await channel.bulkDelete(matches, true);
    return `I have deleted ${deleted.size} recent message${deleted.size === 1 ? "" : "s"} from that member.`;
  }

  if (action.tool === "set_slowmode") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !("setRateLimitPerUser" in channel)) {
      return "I can only set slowmode in a text channel.";
    }

    await channel.setRateLimitPerUser(action.seconds, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have set slowmode in ${channel} to ${action.seconds} second${action.seconds === 1 ? "" : "s"}.`;
  }

  if (action.tool === "lock_channel" || action.tool === "unlock_channel") {
    const channel = await guild.channels.fetch(action.channelId);
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
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !("setName" in channel)) return "I can only rename a guild channel.";
    const oldName = channel.name;
    await channel.setName(action.newName, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have renamed ${oldName} to ${action.newName}.`;
  }

  if (action.tool === "set_channel_topic") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !("setTopic" in channel)) return "I can only set topics in a text channel.";
    await channel.setTopic(action.topic, `Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have updated the topic in ${channel}.`;
  }

  if (action.tool === "create_role") {
    const role = await guild.roles.create({
      name: action.roleName,
      reason: `Duck approved by ${approver.user.tag}: ${action.reason}`,
    });
    return `I have created @${role.name}.`;
  }

  if (action.tool === "delete_role") {
    const role = await guild.roles.fetch(action.roleId);
    if (!canManageRole(botMember, role)) return "I cannot delete that role because it is managed, missing, or at/above Duck's highest role.";
    const roleName = role.name;
    await role.delete(`Duck approved by ${approver.user.tag}: ${action.reason}`);
    return `I have deleted @${roleName}.`;
  }

  return "I do not know how to run that tool.";
}

async function resolveApprover(interactionOrMessage) {
  if (interactionOrMessage.member?.permissions) {
    return interactionOrMessage.member;
  }

  if (!interactionOrMessage.guild || !interactionOrMessage.author) return null;
  return interactionOrMessage.guild.members.fetch(interactionOrMessage.author.id);
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
  if (pendingByChannel.get(action.channelId) === actionId) {
    pendingByChannel.delete(action.channelId);
  }
  savePendingActions();
  logInfo("moderation.approve.accepted", {
    actionId,
    tool: action.tool,
    approverId: approver.id,
  });

  const executeStartedAt = Date.now();
  const result = await executeAction(client, action, approver);
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
  const safeResult = limitDiscordContent(result);
  if ("update" in source && source.isButton?.()) {
    try {
      await source.update({ content: safeResult, embeds: [], components: [] });
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
    await source.reply(safeResult).catch(async () => {
      if ("followUp" in source) {
        await source.followUp({ content: safeResult, ephemeral: true }).catch(() => {});
      }
    });
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
  if (pendingByChannel.get(action.channelId) === actionId) {
    pendingByChannel.delete(action.channelId);
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
  if (pendingByChannel.get(action.channelId) === actionId) {
    pendingByChannel.delete(action.channelId);
  }
  savePendingActions();

  await message.reply("Cancelled. I did not run the moderation tool.").catch(() => {});
  return true;
}

function wantsRecentHistory(text) {
  const normalized = normalizeText(text);
  return /\b(recent|last|pull up|show|summarize|summary)\b/.test(normalized)
    && /\b(message|messages|chat|history|logs?)\b/.test(normalized);
}

async function makeRecentHistoryResponse(message) {
  const { recentMessages } = await collectRecentMessages(message);
  const items = recentMessages
    .filter((item) => item.channelId === message.channelId && item.id !== message.id && item.content)
    .slice(0, 8);

  if (!items.length) {
    return "I do not have readable recent message history for this channel yet.";
  }

  const lines = items.map((item) => {
    const content = item.content.length > 140 ? `${item.content.slice(0, 137)}...` : item.content;
    return `- ${item.authorTag}: ${content}`;
  });

  return [`Recent messages in #${message.channel.name}:`, ...lines].join("\n");
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

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [setupCommand.toJSON(), toolsCommand.toJSON()],
  });
  logInfo("discord.commands-registered", { appId: client.user.id, ms: elapsedMs(startedAt) });
}

requireConfig();
loadPendingActions();

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
        const lines = TOOL_DEFINITIONS
          .map((tool) => `- \`${tool.name}\` (${tool.risk}): ${tool.description}`);
        const chunks = splitDiscordLines(lines);
        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp({ content: chunk, ephemeral: true });
        }
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

client.on(Events.MessageCreate, async (message) => {
  const messageStartedAt = Date.now();
  try {
    if (!message.guild || message.author.bot) return;

    const guildSettings = getGuildSettings(message.guildId);
    const configuredChannelId = guildSettings.modChannelId;
    const invocation = await getDuckInvocation(message, client);
    const inConfiguredChannel = configuredChannelId && message.channelId === configuredChannelId;
    logDebug("message.received", {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      inConfiguredChannel: Boolean(inConfiguredChannel),
      invoked: invocation.invoked,
      contentLength: message.content.length,
    });

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

    if (wantsRecentHistory(planningMessage.content)) {
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
        plan = await planModerationRequest(planningMessage);
        if (!toolResponseContent && chatError) {
          toolResponseContent = chatError;
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
      const chatResult = hasConfiguredAi()
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
              content: parsedToolCall.content,
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
      const content = `You need the Discord permission for \`${plan.tool}\` before I can prepare that action.`;
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
