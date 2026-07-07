import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
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
    name: "create_text_channel",
    risk: "high",
    description: "Create a text channel.",
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
  create_text_channel: PermissionsBitField.Flags.ManageChannels,
};

const RISK_COPY = {
  medium: "This action needs Administrator confirmation before I do anything.",
  high: "This moderation action needs Administrator confirmation before I do anything.",
  critical: "I'm sorry, I need approval from a person that has Administrator.",
};

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

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
    }
  }
}

function loadJsonConfig() {
  const configPath = path.join(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const [key, value] of Object.entries(config)) {
      if (process.env[key] == null && typeof value === "string") {
        process.env[key] = value;
      }
    }
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

function getQueueMessage() {
  return process.env.DUCK_QUEUE_MESSAGE || "Duck is thinking...";
}

function savePendingActions() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pendingActionsPath, JSON.stringify([...pendingActions.values()], null, 2));
}

function schedulePendingExpiry(action) {
  if (pendingExpiryTimers.has(action.id)) {
    clearTimeout(pendingExpiryTimers.get(action.id));
  }

  const expiresAt = action.expiresAt ?? action.createdAt + getPendingActionTtlMs();
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
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

    for (const action of saved) {
      if (!action?.id || !action.channelId || !action.guildId) continue;

      const expiresAt = action.expiresAt ?? action.createdAt + ttl;
      if (expiresAt <= now) continue;

      const hydrated = { ...action, expiresAt };
      pendingActions.set(hydrated.id, hydrated);
      schedulePendingExpiry(hydrated);
    }

    rebuildPendingByChannel();
    savePendingActions();
  } catch (err) {
    console.error("Could not restore pending Duck confirmations:", err);
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
  return reason.replace(/\s+/g, " ").trim() || "No reason provided.";
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
  const maxChannels = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_CHANNELS) || 5, 20));
  const perChannel = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL) || 8, 25));
  const maxTotal = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MAX_MESSAGES) || 40, 150));
  const seen = new Set();
  const candidates = [
    message.channel,
    ...message.guild.channels.cache
      .filter((channel) => channel.id !== message.channelId && channel.isTextBased?.() && "messages" in channel)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];
  const recentMessages = [];

  for (const channel of candidates) {
    if (seen.has(channel.id) || seen.size >= maxChannels || recentMessages.length >= maxTotal) continue;
    seen.add(channel.id);
    if (!channel.isTextBased?.() || !("messages" in channel)) continue;

    try {
      const fetched = await channel.messages.fetch({ limit: perChannel });
      for (const item of fetched.values()) {
        if (recentMessages.length >= maxTotal) break;
        recentMessages.push({
          id: item.id,
          channelId: channel.id,
          channelName: channel.name,
          authorId: item.author.id,
          authorTag: item.author.tag,
          createdAt: item.createdAt.toISOString(),
          content: item.cleanContent.replace(/\s+/g, " ").slice(0, 220),
          attachmentCount: item.attachments.size,
        });
      }
    } catch {
      // Ignore channels Duck cannot read.
    }
  }

  return recentMessages;
}

async function collectServerContext(message) {
  const cacheTtl = getServerContextCacheTtlMs();
  const cacheKey = `${message.guildId}:${message.channelId}`;
  const cached = serverContextCache.get(cacheKey);
  if (cacheTtl > 0 && cached && cached.expiresAt > Date.now()) {
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
    .slice(0, 100);
  const channels = message.guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(summarizeChannelForContext)
    .slice(0, 100);
  const roles = message.guild.roles.cache
    .filter((role) => role.id !== message.guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
    }))
    .slice(0, 80);

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
    recentMessages: await collectRecentMessages(message),
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
  const base = {
    tool: tool.name,
    risk: tool.risk,
    reason: typeof plan.reason === "string" && plan.reason.trim() ? plan.reason.trim() : "No reason provided.",
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
      const role = message.guild.roles.cache.get(String(plan.roleId));
      if (!role || role.id === message.guild.id || role.managed) {
        return { error: "Tell me which editable role to use by mentioning it or quoting its name." };
      }
      result.roleId = role.id;
      result.roleName = role.name;
      result.summary = `${tool.name === "add_role" ? "add" : "remove"} @${role.name} ${tool.name === "add_role" ? "to" : "from"} ${member.displayName}, ${member.username}`;
    }

    if (tool.name === "move_member") {
      const channel = message.guild.channels.cache.get(String(plan.channelId));
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return { error: "Tell me which voice channel to move them to." };
      }
      result.channelId = channel.id;
      result.channelName = channel.name;
      result.summary = `move ${member.displayName}, ${member.username} to ${channel.name}`;
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
    const allowed = message.guild.channels.cache.get(targetChannelId);
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

  if (tool.name === "create_text_channel") {
    const channelName = typeof plan.channelName === "string" ? extractNewChannelName(plan.channelName) : extractNewChannelName(message.content);
    if (!channelName) return { error: "Tell me the channel name in quotes." };
    return {
      ...base,
      channelName,
      summary: `create #${channelName}`,
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
        "Schema: {\"tool\":\"none|ban_member|kick_member|timeout_member|delete_channel|purge_messages|warn_member|untimeout_member|set_slowmode|lock_channel|unlock_channel|softban_member|delete_user_messages|set_nickname|add_role|remove_role|disconnect_member|move_member|create_text_channel\",\"targetId\":\"member id when needed\",\"targetName\":\"member name only if id is unavailable\",\"channelId\":\"channel id when needed\",\"roleId\":\"role id when needed\",\"channelName\":\"new channel name when needed\",\"nickname\":\"new nickname when needed\",\"count\":number,\"durationMs\":number,\"deleteMessageSeconds\":number,\"seconds\":number,\"reason\":\"short reason\"}.",
        "Tool calling tutorial: identify the user's moderation intent, choose exactly one tool, fill only the fields that tool needs, and use IDs from serverContext instead of names whenever targeting existing objects. If a user typed @name but no ID is obvious, put that exact name in targetName.",
        "Use ban_member for permanent bans, softban_member for ban-and-unban cleanup, kick_member for removing without banning, timeout_member for temporary mutes, untimeout_member to clear a timeout, warn_member for a warning DM, purge_messages for channel-wide recent deletion, delete_user_messages for one mentioned user's recent messages, set_slowmode for channel rate limits, lock_channel and unlock_channel for @everyone send permissions, set_nickname for nickname changes, add_role and remove_role for role edits, disconnect_member and move_member for voice moderation, create_text_channel for new text channels, and delete_channel only when the user explicitly asks to delete a channel.",
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
                "create_text_channel",
              ],
            },
            targetId: { type: "string" },
            targetName: { type: "string" },
            channelId: { type: "string" },
            roleId: { type: "string" },
            channelName: { type: "string" },
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

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const plannerMessages = await makePlannerMessages(message);

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
    console.error(`${providerName} planner request failed:`, err);
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    const canRetryWithoutFormat = responseFormatKind !== "none"
      && response.status === 400
      && /response_?format|json_object|json_schema/i.test(errorText);

    if (canRetryWithoutFormat) {
      console.warn(`${providerName} rejected structured response format; retrying without response_format.`);
      try {
        response = await requestPlanner("none");
      } catch (err) {
        console.error(`${providerName} planner retry failed:`, err);
        return null;
      }
    }

    if (!response.ok) {
      console.error(`${providerName} planner failed: ${response.status} ${await response.text()}`);
      return null;
    }
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return validateAiPlan(message, JSON.parse(cleanJsonResponse(content)));
  } catch (err) {
    console.error(`${providerName} planner returned invalid JSON:`, err);
    return null;
  }
}

async function planWithOllama(message) {
  const model = process.env.OLLAMA_MODEL || process.env.AI_MODEL || "llama3.1:8b";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  let response;
  const plannerMessages = await makePlannerMessages(message);

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
    console.error("Ollama planner request failed:", err);
    return null;
  }

  if (!response.ok) {
    console.error(`Ollama planner failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const body = await response.json();
  const content = body.message?.content;
  if (!content) return null;

  try {
    return validateAiPlan(message, JSON.parse(cleanJsonResponse(content)));
  } catch (err) {
    console.error("Ollama planner returned invalid JSON:", err);
    return null;
  }
}

async function planWithConfiguredAi(message) {
  const provider = (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "")).toLowerCase();

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
        "You are Duck, a concise Discord moderation assistant.",
        "Respond naturally to the current message using the server context and recent chat.",
        "Keep replies short, casual, and useful. Do not dump tool instructions unless asked.",
        "You cannot execute moderation directly. If a user asks for moderation, tell them you can prepare it and an Administrator must confirm.",
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

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = await makeChatMessages(message);

  let response;
  try {
    response = await fetch(url, {
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
  } catch (err) {
    console.error(`${config.providerName} chat request failed:`, err);
    return null;
  }

  if (!response.ok) {
    console.error(`${config.providerName} chat failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim().slice(0, 1800) : null;
}

async function chatWithOllama(message) {
  const model = process.env.OLLAMA_MODEL || process.env.AI_MODEL || "llama3.1:8b";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const messages = await makeChatMessages(message);

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
    console.error("Ollama chat request failed:", err);
    return null;
  }

  if (!response.ok) {
    console.error(`Ollama chat failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const body = await response.json();
  const content = body.message?.content;
  return typeof content === "string" && content.trim() ? content.trim().slice(0, 1800) : null;
}

async function generateChatResponse(message) {
  const provider = getConfiguredAiProvider();
  if (provider === "ollama") {
    return chatWithOllama(message);
  }

  const config = getOpenAiCompatibleConfig();
  if (config) {
    return chatWithOpenAiCompatible(message, config);
  }

  return null;
}

async function planModerationRequest(message) {
  const aiPlan = await planWithConfiguredAi(message);
  if (aiPlan) return aiPlan;
  return planLocalModerationTool(message);
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
  if (action.tool === "create_text_channel") return "Create Text Channel";
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

function describeAction(action) {
  const lines = [
    RISK_COPY[action.risk],
    `Planned tool: \`${action.tool}\``,
    `Action: **${commandLabel(action)}**`,
    `Target: ${action.summary}`,
  ];

  if (action.reason) lines.push(`Reason: ${action.reason}`);
  if (action.durationMs) lines.push(`Duration: ${Math.round(action.durationMs / 60000)} minute(s)`);
  if (action.seconds != null) lines.push(`Slowmode: ${action.seconds} second(s)`);
  if (action.count != null) lines.push(`Count: ${action.count}`);
  if (action.nickname) lines.push(`Nickname: ${action.nickname}`);
  if (action.roleName) lines.push(`Role: @${action.roleName}`);
  if (action.channelName && action.tool !== "delete_channel") lines.push(`Channel: ${action.channelName}`);

  return lines.join("\n");
}

async function promptForConfirmation(message, action) {
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

  const prompt = await message.reply({
    content: describeAction(pending),
    components: makeConfirmationRows(actionId),
    allowedMentions: { repliedUser: false },
  });

  pending.promptId = prompt.id;
  pendingActions.set(actionId, pending);
  pendingByChannel.set(message.channelId, actionId);
  schedulePendingExpiry(pending);
  savePendingActions();
}

async function executeAction(client, action, approver) {
  const guild = await client.guilds.fetch(action.guildId);
  const botMember = await guild.members.fetchMe();
  const needed = TOOL_REQUIREMENTS[action.tool];

  if (needed && !hasPermission(botMember, needed)) {
    return `I cannot run \`${action.tool}\` because Duck is missing the required Discord permission.`;
  }

  if (action.tool === "ban_member") {
    const member = await guild.members.fetch(action.targetId);
    await member.ban({ reason: `Duck approved by ${approver.user.tag}: ${action.reason}` });
    return `I have banned ${member.displayName}, ${member.user.username}.`;
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

    const botMemberTop = botMember.roles.highest;
    if (role.position >= botMemberTop.position) {
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

  if (action.tool === "delete_channel") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel) return `I could not find the channel "${action.channelName}".`;
    await channel.delete(`Duck approved by ${approver.user.tag}`);
    return `I have deleted the channel "${action.channelName}".`;
  }

  if (action.tool === "purge_messages") {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel?.isTextBased() || !("bulkDelete" in channel)) {
      return "I can only delete messages in a text channel.";
    }

    const deleted = await channel.bulkDelete(action.count, true);
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
    if ("reply" in source) {
      await source.reply({ content: "That Duck confirmation expired or was already handled.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  const approver = await resolveApprover(source);
  if (!approver || !canApprove(action, approver)) {
    const content = "I need confirmation from a person that has Administrator.";

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

  const result = await executeAction(client, action, approver);

  if ("update" in source && source.isButton?.()) {
    await source.update({ content: result, components: [] });
  } else {
    await source.reply(result).catch(() => {});
  }
}

async function cancelAction(interaction, actionId) {
  const action = pendingActions.get(actionId);
  if (!action) {
    await interaction.reply({ content: "That Duck confirmation expired or was already handled.", ephemeral: true });
    return;
  }

  const member = await resolveApprover(interaction);
  if (!member || (member.id !== action.requestedBy && !canApprove(action, member))) {
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
  const recent = await collectRecentMessages(message);
  const items = recent
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
  console.log(`Duck is online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [
      {
        name: "for duck / @Duck",
        type: ActivityType.Watching,
      },
    ],
    status: "online",
  });

  console.log(`Restored ${pendingActions.size} pending Duck confirmation${pendingActions.size === 1 ? "" : "s"}.`);
  try {
    await registerCommands(client);
    console.log("Duck slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
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
        await interaction.reply(`Duck will now listen in ${channel}.`);
        return;
      }

      if (interaction.commandName === "duck-tools") {
        const tools = TOOL_DEFINITIONS
          .map((tool) => `- \`${tool.name}\` (${tool.risk}): ${tool.description}`)
          .join("\n");
        await interaction.reply({ content: tools, ephemeral: true });
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
  try {
    if (!message.guild || message.author.bot) return;

    const guildSettings = getGuildSettings(message.guildId);
    const configuredChannelId = guildSettings.modChannelId;
    const invocation = await getDuckInvocation(message, client);
    const inConfiguredChannel = configuredChannelId && message.channelId === configuredChannelId;

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

    const queueMessage = hasConfiguredAi()
      ? await message.reply({ content: getQueueMessage(), allowedMentions: { repliedUser: false } }).catch(() => null)
      : null;

    if (wantsRecentHistory(planningMessage.content)) {
      const content = await makeRecentHistoryResponse(message);
      if (queueMessage) {
        await queueMessage.edit({ content }).catch(() => {});
      } else {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      }
      return;
    }

    const plan = await planModerationRequest(planningMessage);
    if (!plan) {
      const chatResponse = hasConfiguredAi()
        ? await generateChatResponse(planningMessage)
        : null;
      const content = chatResponse ?? (invocation.invoked ? makeDuckHelp(invocation.content) : null);

      if (content && queueMessage) {
        await queueMessage.edit({ content, allowedMentions: { repliedUser: false } }).catch(() => {});
      } else if (content) {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      } else if (queueMessage) {
        await queueMessage.edit({ content: "I heard you, but I do not have a useful response for that yet." }).catch(() => {});
      }
      return;
    }

    if (plan.error) {
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
      if (queueMessage) {
        await queueMessage.edit({ content }).catch(() => {});
      } else {
        await message.reply(content);
      }
      return;
    }

    if (queueMessage) {
      await queueMessage.edit({ content: "Prepared a moderation plan. Waiting for Administrator confirmation." }).catch(() => {});
    }
    await promptForConfirmation(message, plan);
  } catch (err) {
    console.error("Message handler failed:", err);
    await message.reply("Duck hit an error while planning that moderation action.").catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
