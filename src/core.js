import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder } from "discord.js";
import { AudioPlayerStatus, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { client } from "./client.js";
import { isDebugEnabled, shouldLogAiBodies, logInfo, logDebug, logWarn, logError, elapsedMs, limitDiscordContent, splitDiscordLines, AiServiceError, makeAiUserError } from "./logging.js";
import { pendingActions, pendingByChannel, pendingExpiryTimers, serverContextCache, messageHistoryCache, resourceFetchCache, pendingJsonWrites, voiceSessions, voiceQuarantineExpiryTimers, voiceQuarantineMoves, commandCooldowns } from "./state.js";
import { quotesPath, TOOL_DEFINITIONS, UTILITY_COMMANDS, DEFAULT_QUOTES, CURSES, BLESSINGS, EIGHT_BALL_ANSWERS, TOOL_REQUIREMENTS, DUCK_COLORS, COMMAND_PRESENTATION, RISK_COPY, CAPABILITY_MODES } from "./constants.js";
import { packageInfo, buildInfo, loadJsonFile, saveJsonFile, flushJsonWrites, getMemberWarnings, addMemberWarning, clearMemberWarnings, getPendingActionTtlMs, getServerContextCacheTtlMs, getAiContextMemberLimit, getAiContextChannelLimit, getAiContextRoleLimit, getAiContextMessageChannelLimit, getAiContextMaxChars, getAiContextMessageChars, getAiContextFocusedMessages, getAiContextBackgroundMessages, getAiContextFetchConcurrency, getAiContextAttachmentLimit, isAiVisionEnabled, getAiVisionMaxImages, getAiVisionBatchSize, getAiVisionMaxAttachmentBytes, getAiVisionDetail, getMessageCacheTtlMs, getMessageCacheLimit, getCacheRefreshMs, getCacheRefreshChannelLimit, getCacheRefreshConcurrency, getEnvBoolean, supportsCurrentVoiceRuntime, getEnvId, getLegacyCommandContent, getEntryChannelConfig, getAiChatMaxTokens, getAiChatMaxAttempts, shouldExcludeReasoning, savePendingActions, getActionRequestChannelId, schedulePendingExpiry, getGuildSettings, getGuildCapabilityMode, getCapabilityModeLabel, updateGuildSettings } from "./config.js";

let cacheMaintenanceTimer = null;
let cacheRefreshTimer = null;
let cacheRefreshRunning = false;
let keepAliveServer = null;
let inviteCleanupTimer = null;
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

function extractExactUserId(text) {
  return String(text || "").match(/(?:^|\s)(\d{17,20})(?=\s|$)/)?.[1] ?? null;
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
    voice_quarantine_member: ["voice", "vc", "quarantine", "jail", "trap"],
    release_voice_quarantine: ["voice", "vc", "release", "unjail", "unquarantine"],
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
  const mentionedId = String(text || "").match(/<#(\d+)>/)?.[1];
  const mentioned = (mentionedId ? message.guild.channels.cache.get(mentionedId) : null)
    ?? message.mentions.channels.first();
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
  const mentionedId = String(text || "").match(/<@&(\d+)>/)?.[1];
  const mentioned = (mentionedId ? message.guild.roles.cache.get(mentionedId) : null)
    ?? message.mentions.roles.first();
  if (mentioned) return mentioned;

  const quotedName = extractQuotedName(text);
  const cleaned = quotedName ?? text.replace(/<@!?\d+>/g, "").replace(/\b(add|give|grant|remove|take|role|from|to)\b/gi, "").trim();
  const wanted = cleaned.replace(/^@/, "").toLowerCase();
  if (!wanted) return null;

  return message.guild.roles.cache.find((role) => role.name.toLowerCase() === wanted);
}

function findVoiceChannelByNameOrMention(message, text) {
  const mentionedId = String(text || "").match(/<#(\d+)>/)?.[1];
  const mentionedById = mentionedId ? message.guild.channels.cache.get(mentionedId) : null;
  const mentioned = (mentionedById?.type === ChannelType.GuildVoice ? mentionedById : null)
    ?? message.mentions.channels.find((channel) => channel.type === ChannelType.GuildVoice);
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

function getVoiceQuarantine(guildId, memberId) {
  const quarantines = getGuildSettings(guildId).voiceQuarantines;
  if (!quarantines || typeof quarantines !== "object") return null;
  return quarantines[memberId] ?? null;
}

function clearVoiceQuarantine(guildId, memberId) {
  const settings = getGuildSettings(guildId);
  const quarantines = settings.voiceQuarantines && typeof settings.voiceQuarantines === "object"
    ? { ...settings.voiceQuarantines }
    : {};
  const existed = Boolean(quarantines[memberId]);
  delete quarantines[memberId];
  updateGuildSettings(guildId, { voiceQuarantines: quarantines });

  const timerKey = `${guildId}:${memberId}`;
  const timer = voiceQuarantineExpiryTimers.get(timerKey);
  if (timer) clearTimeout(timer);
  voiceQuarantineExpiryTimers.delete(timerKey);
  return existed;
}

function scheduleVoiceQuarantineExpiry(guildId, memberId, expiresAt) {
  const timerKey = `${guildId}:${memberId}`;
  const existing = voiceQuarantineExpiryTimers.get(timerKey);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, Math.min(expiresAt - Date.now(), 24 * 60 * 60 * 1000));
  const timer = setTimeout(() => {
    voiceQuarantineExpiryTimers.delete(timerKey);
    const current = getVoiceQuarantine(guildId, memberId);
    const currentExpiresAt = Number(current?.expiresAt);
    if (current && (!Number.isFinite(currentExpiresAt) || currentExpiresAt <= Date.now())) {
      clearVoiceQuarantine(guildId, memberId);
      logInfo("voice-quarantine.expired", { guildId, memberId });
    } else if (current) {
      scheduleVoiceQuarantineExpiry(guildId, memberId, currentExpiresAt);
    }
  }, delay);
  timer.unref?.();
  voiceQuarantineExpiryTimers.set(timerKey, timer);
}

function restoreVoiceQuarantineTimers() {
  for (const guild of client.guilds.cache.values()) {
    const quarantines = getGuildSettings(guild.id).voiceQuarantines;
    if (!quarantines || typeof quarantines !== "object") continue;
    for (const [memberId, quarantine] of Object.entries(quarantines)) {
      const expiresAt = Number(quarantine?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        clearVoiceQuarantine(guild.id, memberId);
      } else {
        scheduleVoiceQuarantineExpiry(guild.id, memberId, expiresAt);
      }
    }
  }
}

async function handleVoiceQuarantineState(oldState, newState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user?.bot) return;

  const quarantine = getVoiceQuarantine(newState.guild.id, member.id);
  if (!quarantine) return;
  const expiresAt = Number(quarantine.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearVoiceQuarantine(newState.guild.id, member.id);
    return;
  }

  // Discord cannot move a disconnected user. Move them back when they join another VC.
  if (!newState.channelId || newState.channelId === quarantine.channelId) return;

  const moveKey = `${newState.guild.id}:${member.id}`;
  if (voiceQuarantineMoves.has(moveKey)) return;
  voiceQuarantineMoves.add(moveKey);
  try {
    const target = newState.guild.channels.cache.get(quarantine.channelId)
      ?? await newState.guild.channels.fetch(quarantine.channelId).catch(() => null);
    if (!target || target.type !== ChannelType.GuildVoice) {
      clearVoiceQuarantine(newState.guild.id, member.id);
      logWarn("voice-quarantine.target-missing", { guildId: newState.guild.id, memberId: member.id, channelId: quarantine.channelId });
      return;
    }

    const botMember = await cachedBotMember(newState.guild);
    const targetPermissions = target.permissionsFor(botMember);
    const requiredPermissions = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.MoveMembers,
    ];
    if (!member.manageable || !targetPermissions?.has(requiredPermissions)) {
      logWarn("voice-quarantine.move-blocked", { guildId: newState.guild.id, memberId: member.id, channelId: target.id });
      return;
    }

    await member.voice.setChannel(target, `Duck voice quarantine active until ${new Date(quarantine.expiresAt).toISOString()}`);
    logInfo("voice-quarantine.enforced", { guildId: newState.guild.id, memberId: member.id, channelId: target.id });
  } catch (err) {
    logError("voice-quarantine.enforce-failed", err, { guildId: newState.guild.id, memberId: member.id });
  } finally {
    voiceQuarantineMoves.delete(moveKey);
  }
}

function requesterActionBlockReason(message, action) {
  const requester = message.member;
  if (!requester || requester.permissions.has(PermissionsBitField.Flags.Administrator)) return null;
  if (action.roleId) {
    const role = message.guild.roles.cache.get(action.roleId);
    if (role && role.position >= requester.roles.highest.position) {
      return `You cannot manage @${role.name} because it is at or above your highest role.`;
    }
  }
  if (action.targetId && !["unban_user", "delete_user_messages", "view_warnings"].includes(action.tool)) {
    const member = message.guild.members.cache.get(action.targetId);
    if (member?.id === message.guild.ownerId || (member && member.roles.highest.position >= requester.roles.highest.position)) {
      return `You cannot target ${summarizeMemberName(member)} because they are at or above your highest role.`;
    }
  }
  return null;
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

  if (["add_role", "remove_role", "disconnect_member", "move_member", "voice_quarantine_member", "release_voice_quarantine", "voice_mute_member", "voice_unmute_member", "deafen_member", "undeafen_member"].includes(action.tool)) {
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
  return /\b(ban|unban|banish|soft\s*ban|kick|timeout|mute|untimeout|unmute|warn|warning|warnings|warns|slowmode|lock|lockdown|unlock|purge|delete|remove|clear|view|show|list|grep|search|find|nickname|nick|rename|topic|role|color|colour|disconnect|voice kick|voice mute|voice unmute|server mute|server unmute|deafen|undeafen|move|quarantine|jail|trap|release|unjail|unquarantine|create|make|new|say|speak|send|post|announce|pin|unpin|thread|poll|vote)\b/.test(normalized)
    && /\b(member|user|person|him|her|them|message|messages|channel|role|color|colour|topic|slowmode|timeout|mute|unmute|deafen|undeafen|ban|kick|warn|warning|warnings|warns|nickname|nick|voice|vc|quarantine|jail|trap|release|purge|delete|remove|clear|view|show|list|grep|search|find|lock|unlock|create|make|say|speak|send|post|announce|pin|unpin|thread|poll|vote)\b|<@!?(\d+)>|<#(\d+)>|<@&(\d+)>/.test(normalized);
}

function planModerationToolFromText(message, rawText) {
  const text = rawText.trim();
  const normalized = normalizeText(text);
  const member = findMentionedMemberForPlan(message, text);

  if (/^unban\b/.test(normalized)) {
    const targetId = extractExactUserId(text);
    if (!targetId) return { error: "Give me the exact Discord user ID to unban." };
    return {
      tool: "unban_user",
      risk: "high",
      targetId,
      reason: text.replace(/^unban\s+\d{17,20}\s*/i, "").trim() || "No reason provided.",
      summary: `unban user ID ${targetId}`,
    };
  }

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

  if (/\b(?:voice|vc)\s+(?:release|unjail|unquarantine)\b|\b(?:release|unjail|unquarantine)\b.*\b(?:voice|vc|quarantine|jail)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to release from voice quarantine by mentioning them." };
    return {
      tool: "release_voice_quarantine",
      risk: "high",
      targetId: member.id,
      reason: extractReason(text, ["voice", "vc", "release", "unjail", "unquarantine", "quarantine", "jail"]),
      summary: `release ${member.displayName}, ${member.user.username} from voice quarantine`,
    };
  }

  if (/\b(?:voice|vc)\s+(?:quarantine|jail|trap)\b|\b(?:quarantine|jail|trap)\b.*\b(?:voice|vc)\b/.test(normalized)) {
    if (!member) return { error: "Tell me who to voice quarantine by mentioning them." };
    const channelId = getGuildSettings(message.guildId).voiceQuarantineChannelId;
    const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return { error: "An Administrator must configure a voice quarantine channel with `/setup quarantine-channel:<voice channel>` first." };
    }
    const durationMs = Math.max(60_000, Math.min(parseDurationMs(text), 24 * 60 * 60 * 1000));
    return {
      tool: "voice_quarantine_member",
      risk: "high",
      targetId: member.id,
      channelId: channel.id,
      channelName: channel.name,
      durationMs,
      reason: extractReason(text, ["voice", "vc", "quarantine", "jail", "trap"]),
      summary: `voice quarantine ${member.displayName}, ${member.user.username} in ${channel.name}`,
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
      risk: "low",
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
      risk: "low",
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

  const purgeMatch = normalized.match(/\b(purge|delete|clear)\s+(\d{1,3})(\s+messages?)?/);
  if (purgeMatch) {
    const count = Math.max(1, Math.min(Number(purgeMatch[2]), 100));
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

function isImageLikeAttachment(attachment) {
  const contentType = String(attachment.contentType || "").toLowerCase();
  const name = String(attachment.name || "").toLowerCase();
  return contentType.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function summarizeAttachment(attachment) {
  const imageLike = isImageLikeAttachment(attachment);
  const size = attachment.size ?? null;
  return {
    id: attachment.id,
    name: attachment.name || null,
    contentType: attachment.contentType || null,
    size,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    url: attachment.url,
    proxyURL: attachment.proxyURL || null,
    imageLike,
    visionEligible: imageLike && (!size || size <= getAiVisionMaxAttachmentBytes()),
  };
}

function summarizeAttachments(attachments) {
  return [...(attachments?.values?.() ?? [])]
    .slice(0, getAiContextAttachmentLimit())
    .map(summarizeAttachment);
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
    content: item.cleanContent.replace(/\s+/g, " ").slice(0, getAiContextMessageChars()),
    attachmentCount: item.attachments.size,
    attachments: summarizeAttachments(item.attachments),
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
    const referenced = channel.messages.cache.get(reference.messageId)
      ?? await channel.messages.fetch(reference.messageId);
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
  const touchedAt = options.preserveTouchedAt ? cached?.touchedAt ?? now : now;
  messageHistoryCache.set(key, {
    channelId: channel.id,
    guildId: channel.guildId,
    fetchedAt: cached?.fetchedAt ?? 0,
    touchedAt,
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
      touchedAt,
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
      fetcher,
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
        fetcher,
      });
      return value;
    })
    .catch((err) => {
      resourceFetchCache.delete(key);
      throw err;
    });
  resourceFetchCache.set(key, { promise, touchedAt: now, expiresAt: now + getResourceCacheTtlMs(), fetcher });
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

async function runBoundedTasks(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  }));
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
  const messageMaxAge = Math.max(getMessageCacheTtlMs() * 3, getCacheRefreshMs() * 2, 60_000);
  const resourceMaxAge = Math.max(getResourceCacheTtlMs() * 3, getCacheRefreshMs() * 2, 60_000);

  for (const [key, entry] of messageHistoryCache.entries()) {
    if (now - Math.max(entry.touchedAt || 0, entry.fetchedAt || 0) > messageMaxAge) {
      messageHistoryCache.delete(key);
      removedMessages += 1;
    }
  }
  removedMessages += pruneMapToLimit(messageHistoryCache, Math.max(10, Number(process.env.DUCK_MESSAGE_CACHE_MAX_CHANNELS) || 50));

  for (const [key, entry] of resourceFetchCache.entries()) {
    if (!entry.promise && now - (entry.touchedAt || 0) > resourceMaxAge) {
      resourceFetchCache.delete(key);
      removedResources += 1;
    }
  }
  removedResources += pruneMapToLimit(resourceFetchCache, Math.max(25, Number(process.env.DUCK_RESOURCE_CACHE_MAX_ITEMS) || 200));

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

async function refreshRuntimeCaches() {
  const startedAt = Date.now();
  const now = Date.now();
  const activeWindow = Math.max(getCacheRefreshMs() * 2, getMessageCacheTtlMs() * 3, 60_000);
  const messageLimit = getCacheRefreshChannelLimit();
  const refreshConcurrency = getCacheRefreshConcurrency();
  let refreshedMessages = 0;
  let failedMessages = 0;
  let refreshedResources = 0;
  let failedResources = 0;

  const messageEntries = [...messageHistoryCache.entries()]
    .filter(([, entry]) => !entry.fetchPromise && now - (entry.touchedAt || entry.fetchedAt || 0) <= activeWindow)
    .sort((a, b) => (b[1].touchedAt ?? b[1].fetchedAt ?? 0) - (a[1].touchedAt ?? a[1].fetchedAt ?? 0))
    .slice(0, messageLimit);

  await runBoundedTasks(messageEntries, refreshConcurrency, async ([key, entry]) => {
    const guild = client.guilds.cache.get(entry.guildId);
    const channel = guild?.channels.cache.get(entry.channelId);
    if (!channel?.isTextBased?.() || !("messages" in channel)) {
      messageHistoryCache.delete(key);
      return;
    }

    try {
      await getRecentChannelMessages(channel, Math.min(getMessageCacheLimit(), 100), { forceFetch: true, preserveTouchedAt: true });
      refreshedMessages += 1;
    } catch (err) {
      failedMessages += 1;
      logDebug("cache.refresh-message-failed", {
        guildId: entry.guildId,
        channelId: entry.channelId,
        error: err?.message || String(err),
      });
    }
  });

  const resourceEntries = [...resourceFetchCache.entries()]
    .filter(([, entry]) => entry.value && !entry.promise && typeof entry.fetcher === "function" && now - (entry.touchedAt || 0) <= activeWindow)
    .sort((a, b) => (b[1].touchedAt ?? 0) - (a[1].touchedAt ?? 0))
    .slice(0, Math.max(1, Math.min(Number(process.env.DUCK_RESOURCE_CACHE_REFRESH_MAX_ITEMS) || 25, 500)));

  await runBoundedTasks(resourceEntries, refreshConcurrency, async ([key, entry]) => {
    try {
      const value = await entry.fetcher();
      resourceFetchCache.set(key, {
        value,
        expiresAt: Date.now() + getResourceCacheTtlMs(),
        touchedAt: entry.touchedAt,
        refreshedAt: Date.now(),
        fetcher: entry.fetcher,
      });
      refreshedResources += 1;
    } catch (err) {
      failedResources += 1;
      resourceFetchCache.delete(key);
      logDebug("cache.refresh-resource-failed", {
        key,
        error: err?.message || String(err),
      });
    }
  });

  logDebug("cache.refresh", {
    messageChannels: messageHistoryCache.size,
    resources: resourceFetchCache.size,
    refreshedMessages,
    failedMessages,
    refreshedResources,
    failedResources,
    ms: elapsedMs(startedAt),
  });
}

function startCacheMaintenance() {
  if (cacheMaintenanceTimer) return;
  cacheMaintenanceTimer = setInterval(pruneRuntimeCaches, getCacheSweepMs());
  cacheMaintenanceTimer.unref();
  if (!cacheRefreshTimer) {
    cacheRefreshTimer = setInterval(() => {
      if (cacheRefreshRunning) {
        logDebug("cache.refresh-skipped", { reason: "previous refresh is still running" });
        return;
      }

      cacheRefreshRunning = true;
      refreshRuntimeCaches()
        .catch((err) => logWarn("cache.refresh-failed", { error: err?.message || String(err) }))
        .finally(() => {
          cacheRefreshRunning = false;
        });
    }, getCacheRefreshMs());
    cacheRefreshTimer.unref();
  }
}

function flushRuntimeStateAndExit(signal) {
  try {
    for (const guildId of voiceSessions.keys()) destroyVoiceSession(guildId);
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

function getExplicitContextChannelIds(message) {
  const channels = [
    findHistoryChannelTarget(message, message.content),
    message.reference?.channelId ? message.guild.channels.cache.get(message.reference.channelId) : null,
    ...message.mentions.channels.filter((channel) => channel.isTextBased?.() && "messages" in channel).values(),
  ];

  return new Set(channels.filter(Boolean).map((channel) => channel.id));
}

async function collectRecentMessages(message) {
  const startedAt = Date.now();
  const maxChannels = getAiContextMessageChannelLimit();
  const perChannel = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MESSAGES_PER_CHANNEL) || 10, 50));
  const maxTotal = Math.max(1, Math.min(Number(process.env.AI_CONTEXT_MAX_MESSAGES) || 500, 500));
  const maxMessageChars = getAiContextMessageChars();
  const concurrency = getAiContextFetchConcurrency();
  const seen = new Set();
  const botMember = await cachedBotMember(message.guild);
  const priorityChannels = getContextPriorityChannels(message);
  const explicitChannelIds = getExplicitContextChannelIds(message);
  const focusedLimit = getAiContextFocusedMessages();
  const backgroundLimit = Math.min(perChannel, getAiContextBackgroundMessages());
  const currentChannelLimit = explicitChannelIds.size
    ? Math.max(perChannel, Math.ceil(focusedLimit / 2))
    : focusedLimit;
  const candidates = [
    ...priorityChannels,
    ...message.guild.channels.cache
      .filter((channel) => !priorityChannels.some((priority) => priority.id === channel.id) && channel.isTextBased?.() && "messages" in channel)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];
  const recentMessages = [];
  const channelMessages = [];
  const channelResults = [];
  const errors = [];
  const skippedPrivate = [];
  const skippedUnreadable = [];
  let nextCandidateIndex = 0;
  let estimatedMessages = 0;

  function nextChannelCandidate() {
    if (estimatedMessages >= maxTotal || seen.size >= maxChannels) return null;

    while (nextCandidateIndex < candidates.length) {
      const index = nextCandidateIndex;
      const channel = candidates[nextCandidateIndex];
      nextCandidateIndex += 1;
      if (!channel || seen.has(channel.id) || !channel.isTextBased?.() || !("messages" in channel)) continue;
      seen.add(channel.id);
      return { channel, index };
    }

    return null;
  }

  function getChannelMessageLimit(channel) {
    if (explicitChannelIds.has(channel.id)) return focusedLimit;
    if (channel.id === message.channelId) return currentChannelLimit;
    return backgroundLimit;
  }

  async function readChannelMessages(channel, index) {
    const isPrivate = channelIsPrivate(channel);
    if (!canIncludeChannelMessages(message, channel, botMember)) {
      if (isPrivate) skippedPrivate.push(channel.id);
      else skippedUnreadable.push(channel.id);
      channelResults.push({
        index,
        group: {
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          parentName: channel.parent?.name ?? null,
          private: isPrivate,
          readable: false,
          skippedReason: isPrivate ? "private_channel_requires_requester_admin" : "bot_missing_view_or_history_permission",
          messages: [],
        },
        messages: [],
      });
      return;
    }

    try {
      const requestedMessages = getChannelMessageLimit(channel);
      const fetched = await getRecentChannelMessages(channel, requestedMessages);
      const messagesForChannel = fetched.map((item) => ({
        id: item.id,
        channelId: channel.id,
        channelName: channel.name,
        authorId: item.author.id,
        authorTag: item.author.tag,
        createdAt: item.createdAt.toISOString(),
        content: item.cleanContent.replace(/\s+/g, " ").slice(0, maxMessageChars),
        attachmentCount: item.attachments.size,
        attachments: summarizeAttachments(item.attachments),
      }));

      estimatedMessages += messagesForChannel.length;
      channelResults.push({
        index,
        group: {
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          parentName: channel.parent?.name ?? null,
          private: isPrivate,
          readable: true,
          requestedMessages,
          messages: messagesForChannel.map((summary) => ({
            id: summary.id,
            authorId: summary.authorId,
            authorTag: summary.authorTag,
            createdAt: summary.createdAt,
            content: summary.content,
            attachmentCount: summary.attachmentCount,
            attachments: summary.attachments,
          })),
        },
        messages: messagesForChannel,
      });
    } catch {
      errors.push(channel.id);
      channelResults.push({
        index,
        group: {
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          parentName: channel.parent?.name ?? null,
          private: isPrivate,
          readable: false,
          skippedReason: "message_fetch_failed",
          messages: [],
        },
        messages: [],
      });
    }
  }

  async function worker() {
    while (true) {
      const candidate = nextChannelCandidate();
      if (!candidate) return;
      await readChannelMessages(candidate.channel, candidate.index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  let remainingMessages = maxTotal;
  for (const result of channelResults.sort((a, b) => a.index - b.index)) {
    if (remainingMessages <= 0 && result.group.readable) break;

    const messages = result.messages.slice(0, Math.max(0, remainingMessages));
    for (const summary of messages) {
      recentMessages.push(summary);
    }

    if (result.group.readable) {
      remainingMessages -= messages.length;
      channelMessages.push({
        ...result.group,
        messages: result.group.messages.slice(0, messages.length),
      });
    } else {
      channelMessages.push(result.group);
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
    focusedChannels: [...explicitChannelIds],
    focusedMessageLimit: focusedLimit,
    currentChannelMessageLimit: currentChannelLimit,
    backgroundMessageLimit: backgroundLimit,
    concurrency,
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
    attachments: summarizeAttachments(message.attachments),
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

  const [messageContext, currentMessage] = await Promise.all([
    collectRecentMessages(message),
    buildCurrentMessageContext(message),
  ]);
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
    currentMessage,
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

function makeValidatedBulkPlan(message, actions, reason = null) {
  if (!Array.isArray(actions) || actions.length < 2) {
    return { error: "A bulk request needs at least 2 valid actions." };
  }
  if (actions.length > 10) {
    return { error: "Bulk supports at most 10 actions at once." };
  }

  for (const [index, action] of actions.entries()) {
    if (!action || action.error) {
      return { error: `Action ${index + 1} is invalid: ${action?.error || "unsupported action"}` };
    }
    if (action.tool === "bulk_actions") {
      return { error: "Nested bulk actions are not allowed." };
    }
    if (["view_warnings", "grep_messages"].includes(action.tool)) {
      return { error: `Action ${index + 1} uses read-only tool \`${action.tool}\`; run that lookup separately.` };
    }

    const needed = TOOL_REQUIREMENTS[action.tool];
    if (needed && !hasPermission(message.member, needed)) {
      return { error: `You cannot add action ${index + 1} (\`${action.tool}\`) to this batch. Required: ${describePermissionRequirement(needed)}.` };
    }
    const hierarchyError = requesterActionBlockReason(message, action);
    if (hierarchyError) return { error: `Action ${index + 1} is blocked: ${hierarchyError}` };
  }

  return {
    tool: "bulk_actions",
    risk: "critical",
    actions,
    reason: reason || `Bulk request containing ${actions.length} validated actions.`,
    summary: actions.map((action, index) => `${index + 1}. ${action.summary}`).join("\n"),
  };
}

function validateAiPlan(message, plan, serverContext = null) {
  if (!plan || typeof plan !== "object") return null;
  if (Array.isArray(plan)) plan = { tool: "bulk_actions", actions: plan };
  if (plan.tool === "none") return null;

  if (plan.tool === "bulk_actions" || Array.isArray(plan.actions)) {
    if (!Array.isArray(plan.actions)) return { error: "The AI returned a bulk plan without an actions list." };
    const actions = [];
    for (const [index, childPlan] of plan.actions.entries()) {
      if (childPlan?.tool === "bulk_actions" || Array.isArray(childPlan?.actions)) {
        return { error: `Action ${index + 1} cannot contain another bulk action.` };
      }
      const action = validateAiPlan(message, childPlan, serverContext);
      if (!action || action.error) {
        return { error: `Could not validate action ${index + 1}: ${action?.error || "unsupported action"}` };
      }
      actions.push(action);
    }
    return makeValidatedBulkPlan(message, actions, typeof plan.reason === "string" ? plan.reason.trim() : null);
  }

  const tool = TOOL_DEFINITIONS.find((definition) => definition.name === plan.tool);
  if (!tool) return null;

  const context = serverContext ?? getMentionContext(message);
  const inferredReason = inferReasonFromRequest(message, tool.name);
  const base = {
    tool: tool.name,
    risk: tool.risk,
    reason: typeof plan.reason === "string" && plan.reason.trim() ? plan.reason.trim() : inferredReason ?? "No reason provided.",
  };

  if (tool.name === "unban_user") {
    const targetId = String(plan.targetId || extractExactUserId(message.content) || "").trim();
    if (!/^\d{17,20}$/.test(targetId)) {
      return { error: "Give me the exact Discord user ID to unban." };
    }
    return {
      ...base,
      targetId,
      summary: `unban user ID ${targetId}`,
    };
  }

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
    "voice_quarantine_member",
    "release_voice_quarantine",
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

    if (tool.name === "voice_quarantine_member") {
      const configuredChannelId = getGuildSettings(message.guildId).voiceQuarantineChannelId;
      const channel = configuredChannelId ? message.guild.channels.cache.get(configuredChannelId) : null;
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return { error: "An Administrator must configure a voice quarantine channel with `/setup quarantine-channel:<voice channel>` first." };
      }
      result.channelId = channel.id;
      result.channelName = channel.name;
      result.durationMs = Math.max(60_000, Math.min(Number(plan.durationMs) || parseDurationMs(message.content), 24 * 60 * 60 * 1000));
      result.summary = `voice quarantine ${member.displayName}, ${member.username} in ${channel.name}`;
    }

    if (tool.name === "release_voice_quarantine") {
      result.summary = `release ${member.displayName}, ${member.username} from voice quarantine`;
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

function collectVisionAttachmentsFromContext(context) {
  if (!isAiVisionEnabled()) return [];

  const candidates = [];
  const pushAttachment = (attachment, source) => {
    if (!attachment?.visionEligible || !attachment.url) return;
    candidates.push({ ...attachment, source });
  };

  for (const attachment of context.currentMessage?.attachments ?? []) {
    pushAttachment(attachment, "current_message");
  }

  for (const attachment of context.currentMessage?.replyTo?.attachments ?? []) {
    pushAttachment(attachment, "reply_message");
  }

  return candidates.slice(0, getAiVisionMaxImages());
}

function makeUserMessagesWithVision(payload, context, includeVision = false) {
  const text = JSON.stringify(payload);
  const messages = [{ role: "user", content: text }];
  if (!includeVision) return messages;

  const attachments = collectVisionAttachmentsFromContext(context);
  const batchSize = getAiVisionBatchSize();
  for (let index = 0; index < attachments.length; index += batchSize) {
    const batch = attachments.slice(index, index + batchSize);
    const batchNumber = Math.floor(index / batchSize) + 1;
    const batchCount = Math.ceil(attachments.length / batchSize);
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `OpenRouter vision attachment batch ${batchNumber}/${batchCount}. Inspect these images/GIFs for the current request without downloading or storing them.`,
        },
        ...batch.map((attachment) => ({
          type: "image_url",
          image_url: {
            url: attachment.url,
            detail: getAiVisionDetail(),
          },
        })),
      ],
    });
  }

  return messages;
}

function isOpenRouterProvider(providerName) {
  return String(providerName || "").toLowerCase() === "openrouter";
}

async function makePlannerMessages(message, providedContext = null, options = {}) {
  const context = providedContext ?? await collectServerContext(message);
  const tools = TOOL_DEFINITIONS.map((tool) => `${tool.name} (${tool.risk})`).join(", ");
  const payload = {
    request: message.content,
    currentChannelId: message.channelId,
    serverContext: context,
  };
  return [
    {
      role: "system",
      content: [
        "You are Duck's moderation intent planner.",
        "Return only JSON. Do not explain.",
        `Available tools: ${tools}.`,
        "Schema: return one normal tool plan, or {\"tool\":\"bulk_actions\",\"actions\":[toolPlan, toolPlan],\"reason\":\"short batch reason\"} for 2-10 explicitly requested actions. Each toolPlan uses the normal fields: targetId, targetName, channelId, messageId, roleId, roleName, targetRoleName, channelName, newName, threadName, topic, messageText, query, pollQuestion, pollOptions, color, nickname, count, durationMs, deleteMessageSeconds, seconds, and reason.",
        "Tool calling tutorial: identify every explicitly requested action. Return one tool for one action, or bulk_actions with 2-10 child plans when the user asks for multiple actions. Fill only the fields each tool needs, and use IDs from serverContext instead of names whenever targeting existing objects. If a user typed @name but no ID is obvious, put that exact name in targetName.",
        "Use ban_member for permanent bans, softban_member for ban-and-unban cleanup, kick_member for removing without banning, timeout_member for temporary mutes, untimeout_member to clear a timeout, warn_member to store and DM a warning, view_warnings to list stored warnings for one member, clear_warnings to clear a requested warning count for one member, purge_messages for channel-wide recent deletion, grep_messages to search recent messages for a keyword or phrase, delete_user_messages for one mentioned user's recent messages, set_slowmode for channel rate limits, lock_channel and unlock_channel for @everyone send permissions, set_nickname for nickname changes, add_role and remove_role for role edits, disconnect_member, move_member, voice_quarantine_member, release_voice_quarantine, voice_mute_member, voice_unmute_member, deafen_member, and undeafen_member for voice moderation, create_text_channel/create_voice_channel for new channels, rename_channel and set_channel_topic for channel edits, speak to send an approved message as Duck in the current or mentioned text channel, pin_message/unpin_message only for a replied-to message or explicit message link/ID, create_thread for a new public thread, set_role_color for role color changes, create_poll for reaction polls with 2-10 options, create_role/delete_role for role management, and delete_channel only when the user explicitly asks to delete a channel.",
        "voice_quarantine_member and release_voice_quarantine are Administrator-only. Voice quarantine uses the server's configured quarantine channel and accepts durationMs from 1 minute to 24 hours.",
        "Only use speak when the user explicitly gives the exact message Duck should send. If the user asks Duck to make, draft, write, or prepare an announcement, return {\"tool\":\"none\"} and let chat draft it first.",
        "Use serverContext.channelMessages for per-channel recent message context. It groups messages by channel so you can understand what happened in each readable channel.",
        "Use serverContext.currentMessage.replyTo when the user is replying to another message. It contains the referenced message text, channel, author, timestamp, and authorMember when available.",
        "If image or GIF attachments are supplied with the current or replied-to message, use them only to understand the current request and still return JSON only.",
        "Only choose member IDs, channel IDs, and role IDs from the supplied context.",
        "Member-targeting tools require a real Discord mention or an exact visible member name from the user's request.",
        "Never invent IDs, never target an unmentioned member, never nest bulk_actions, and return {\"tool\":\"none\"} when the request is vague, non-actionable, or only asks a question.",
        "Every returned tool or bulk is only a plan. Duck will validate every child and show one Administrator-only confirmation prompt before ordered execution.",
        "If the request is not an actionable tool request, return {\"tool\":\"none\"}.",
      ].join(" "),
    },
    ...makeUserMessagesWithVision(payload, context, options.includeVision),
  ];
}

function makePlannerResponseFormat(kind) {
  if (kind === "json_schema") {
    const actionProperties = {
      tool: {
        type: "string",
        enum: TOOL_DEFINITIONS.map((tool) => tool.name),
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
    };

    return {
      type: "json_schema",
      json_schema: {
        name: "duck_moderation_plan",
        schema: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: ["none", "bulk_actions", ...TOOL_DEFINITIONS.map((tool) => tool.name)],
            },
            ...Object.fromEntries(Object.entries(actionProperties).filter(([name]) => name !== "tool")),
            actions: {
              type: "array",
              minItems: 2,
              maxItems: 10,
              items: {
                type: "object",
                properties: actionProperties,
                required: ["tool"],
                additionalProperties: false,
              },
            },
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
  const includeVision = isOpenRouterProvider(providerName);
  const plannerMessages = await makePlannerMessages(message, serverContext, { includeVision });
  const visionImages = includeVision ? collectVisionAttachmentsFromContext(serverContext).length : 0;
  logDebug("ai.planner.request", {
    providerName,
    model,
    responseFormatKind,
    visionImages,
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

async function makeChatMessages(message, options = {}) {
  const context = options.providedContext ?? await collectServerContext(message);
  const payload = {
    request: message.content,
    currentChannelId: message.channelId,
    serverContext: context,
  };
  return [
    {
      role: "system",
      content: [
        "You are Duck, a concise Discord AI chatbot with moderation tools.",
        "Respond naturally to the current message using the server context and recent chat.",
        "When OpenRouter vision batches include current or replied-to image/GIF attachments, inspect them directly. If animated GIF frame understanding is limited, say that briefly.",
        "If the current message is a reply, use serverContext.currentMessage.replyTo as direct reply context before broader channel history.",
        "Use serverContext.channelMessages to answer questions about recent messages in specific channels. It groups readable recent messages by channel.",
        "Use the wider server context to answer questions about members, channels, roles, and what has been happening across the server when you can.",
        "Duck also supports utility commands for userinfo, serverinfo, channelinfo, roleinfo, warnings, quotes, ship, curse, spinwheel, reminders, rules, and ping.",
        "Keep replies short, casual, and useful. Do not dump tool instructions unless asked.",
        "You have tools for moderation actions, but you cannot execute moderation directly from chat.",
        "When the user asks for one action, include one hidden tool marker at the end of your reply using {{tool::target::reason}}. For 2-10 explicit actions, include one marker per action in requested order; Duck combines them behind one approval.",
        "Use tools ban, softban, kick, timeout, warn, view_warnings, clear_warnings, untimeout, purge, grep_messages, delete_user_messages, slowmode, lock, unlock, nickname, add_role, remove_role, disconnect, move, create_channel, create_voice_channel, rename_channel, set_topic, speak, pin_message, unpin_message, create_thread, set_role_color, create_poll, create_role, delete_role, or delete_channel.",
        "Voice tools are also available: voice_mute, voice_unmute, voice_quarantine, voice_release, deafen, and undeafen.",
        "Example: I can prepare that warning for approval. {{warn::Ryzen 9 9950X3D2::testing purposes}}",
        "For two-target tools, put both targets in the target slot separated by |. Examples: {{add_role::Ryzen 9 9950X3D2|Member::testing}}, {{move::Ryzen 9 9950X3D2|General Voice::testing}}, {{rename_channel::general|new-general::cleanup}}, {{speak::general|hello everyone::approved speak request}}, {{grep_messages::general|keyword::search request}}, {{create_thread::general|bug reports::organize reports}}, {{set_role_color::Member|#3B82F6::visual update}}, {{create_poll::general|Best snack?|chips|cookies::poll request}}.",
        "Only use speak when the user gives the exact message Duck should send. If the user asks you to draft, write, make, or prepare an announcement, draft the text and ask for confirmation without a marker.",
        "The target must be a visible member/channel/role name or ID from context. The reason must preserve the user's stated reason.",
        "Never say an action is done. Duck will hide all markers, validate every action, and show one Administrator confirmation embed.",
        "If a user asks for moderation but the target or reason is missing, ask a short follow-up and do not include a marker.",
        "Be honest when you are missing context, permissions, or tool access.",
        "Do not claim an action was done unless Duck has already confirmed execution.",
      ].join(" "),
    },
    ...makeUserMessagesWithVision(payload, context, options.includeVision),
  ];
}

async function chatWithOpenAiCompatible(message, config) {
  if (!config?.apiKey || !config?.model) return null;

  const startedAt = Date.now();
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const context = await collectServerContext(message);
  const includeVision = isOpenRouterProvider(config.providerName);
  const messages = await makeChatMessages(message, { includeVision, providedContext: context });
  const visionImages = includeVision ? collectVisionAttachmentsFromContext(context).length : 0;
  logDebug("ai.chat.request", {
    providerName: config.providerName,
    model: config.model,
    maxTokens: getAiChatMaxTokens(),
    maxAttempts: getAiChatMaxAttempts(),
    excludeReasoning: shouldExcludeReasoning(config),
    visionImages,
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
  unban: "unban_user",
  unban_user: "unban_user",
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
  voice_quarantine: "voice_quarantine_member",
  voice_jail: "voice_quarantine_member",
  voice_quarantine_member: "voice_quarantine_member",
  voice_release: "release_voice_quarantine",
  release_voice_quarantine: "release_voice_quarantine",
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

  const markerPattern = /\{\{\s*([a-zA-Z0-9_ -]+)\s*::\s*([\s\S]*?)\s*::\s*([\s\S]*?)\s*\}\}/g;
  const markers = [...content.matchAll(markerPattern)];
  const marker = markers[0];
  const cleanContent = content
    .replace(markerPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!marker) return { content: cleanContent || content, plan: null };
  if (markers.length > 10) {
    return { content: cleanContent, plan: { error: "Bulk supports at most 10 actions at once." } };
  }
  if (markers.length > 1) {
    const actions = markers.map((item) => parseInlineToolCall(message, item[0]).plan);
    return {
      content: cleanContent || `Prepared ${actions.length} actions for Administrator approval.`,
      plan: makeValidatedBulkPlan(message, actions, `AI batch containing ${actions.length} requested actions.`),
    };
  }

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
  if (tool === "voice_quarantine_member") rawPlan.durationMs = parseDurationMs(`${message.content} ${reason}`);
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
  if (action.tool === "unban_user") return "Unban";
  if (action.tool === "bulk_actions") return "Bulk Actions";
  if (action.tool === "announce") return "Announcement";
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
  if (action.tool === "voice_quarantine_member") return "Voice Quarantine";
  if (action.tool === "release_voice_quarantine") return "Release Voice Quarantine";
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
        .setLabel("Approve Action")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`duck_cancel:${actionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function makeAgentModeConfirmationRows(requesterId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`duck_capability_agent:${requesterId}`)
        .setLabel("Enable Agent Mode")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`duck_capability_cancel:${requesterId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function handleCapabilityCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: "Only an Administrator can change Duck's capability mode.", ephemeral: true });
    return;
  }

  const mode = interaction.options.getString("mode", true);
  if (!Object.values(CAPABILITY_MODES).includes(mode)) {
    await interaction.reply({ content: "That capability mode is not valid.", ephemeral: true });
    return;
  }

  if (mode === CAPABILITY_MODES.agent) {
    await interaction.reply({
      content: [
        "**Enable Agent mode?**",
        "Duck will immediately execute every validated action, including high-risk and critical server changes, without another approval prompt.",
        "Requester permissions, role hierarchy, exact-target checks, and Duck's Discord permissions still apply.",
      ].join("\n"),
      components: makeAgentModeConfirmationRows(interaction.user.id),
      ephemeral: true,
    });
    return;
  }

  updateGuildSettings(interaction.guildId, { capabilityMode: mode });
  logInfo("settings.capability-mode-updated", {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    mode,
  });
  await interaction.reply({
    content: `Duck capability mode is now **${getCapabilityModeLabel(mode)}**.`,
    ephemeral: true,
  });
}

async function handleCapabilityButton(interaction, kind, requesterId) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: "Only an Administrator can change Duck's capability mode.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== requesterId) {
    await interaction.reply({ content: "Only the Administrator who opened this prompt can finish this change.", ephemeral: true });
    return;
  }

  if (kind === "duck_capability_cancel") {
    await interaction.update({ content: "Capability mode change cancelled.", components: [] });
    return;
  }

  updateGuildSettings(interaction.guildId, { capabilityMode: CAPABILITY_MODES.agent });
  logWarn("settings.agent-mode-enabled", {
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });
  await interaction.update({
    content: "Duck capability mode is now **Agent mode**. Validated actions will execute immediately without approval prompts.",
    components: [],
  });
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
  const riskLabel = String(action.risk || "medium").toUpperCase();
  const embed = new EmbedBuilder()
    .setTitle(`Approval Required: ${commandLabel(action)}`)
    .setDescription(RISK_COPY[action.risk])
    .setColor(action.risk === "critical" ? DUCK_COLORS.danger : action.risk === "high" ? 0xf47b20 : action.risk === "low" ? DUCK_COLORS.success : DUCK_COLORS.warning)
    .addFields(
      { name: "Action", value: `**${commandLabel(action)}**`, inline: true },
      { name: "Risk", value: `**${riskLabel}**`, inline: true },
      { name: "Requested By", value: action.requestedBy ? `<@${action.requestedBy}>` : "Unknown", inline: true },
      { name: "Tool", value: `\`${action.tool}\``, inline: true },
      { name: "Target", value: action.summary?.slice(0, 1024) || "Unknown", inline: false },
      { name: "Reason", value: (action.reason || "No reason provided.").slice(0, 1024), inline: false },
    )
    .setTimestamp(action.createdAt || Date.now())
    .setFooter({ text: "Administrator approval required | Nothing runs before approval." });

  if (client.user) {
    embed.setAuthor({ name: "Duck Safety Gate", iconURL: client.user.displayAvatarURL({ size: 64 }) });
  }

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
  if (action.embedAnnouncement != null) details.push(`Format: ${action.embedAnnouncement ? "embed" : "plain text"}`);
  if (action.mentionRoleId) details.push(`Mention: <@&${action.mentionRoleId}>`);
  if (action.query) details.push(`Query: ${action.query}`);
  if (action.pollQuestion) details.push(`Poll: ${action.pollQuestion}`);
  if (action.pollOptions?.length) details.push(`Options: ${action.pollOptions.join(" | ")}`);
  if (action.actions?.length) details.push(...action.actions.map((item, index) => `${index + 1}. ${item.summary}`));
  if (action.channelName && action.tool !== "delete_channel") details.push(`Channel: ${action.channelName}`);
  if (action.aiWarning) details.push(`AI note: ${action.aiWarning}`);
  if (action.expiresAt) details.push(`Expires: <t:${Math.floor(action.expiresAt / 1000)}:R>`);
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
  if (action.embedAnnouncement != null) lines.push(`Format: ${action.embedAnnouncement ? "embed" : "plain text"}`);
  if (action.mentionRoleId) lines.push(`Mention: <@&${action.mentionRoleId}>`);
  if (action.query) lines.push(`Query: ${action.query}`);
  if (action.pollQuestion) lines.push(`Poll: ${action.pollQuestion}`);
  if (action.pollOptions?.length) lines.push(`Options: ${action.pollOptions.join(" | ")}`);

  return lines.join("\n");
}

function makeActionAuditReason(action, approver, detail = action.reason) {
  const actor = approver?.user?.tag || approver?.id || "unknown requester";
  const prefix = action.approvalMode === CAPABILITY_MODES.agent
    ? `Duck Agent mode request by ${actor}`
    : action.approvalMode === CAPABILITY_MODES.approve
      ? `Duck auto-approved low-risk request by ${actor}`
      : `Duck approved by ${actor}`;
  return `${prefix}: ${detail || "No reason provided."}`.slice(0, 512);
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

  if (action.tool === "bulk_actions") {
    const results = [];
    for (const [index, childAction] of action.actions.entries()) {
      try {
        const result = await executeAction(client, {
          ...childAction,
          id: `${action.id}:${index + 1}`,
          guildId: action.guildId,
          requestChannelId: action.requestChannelId,
          promptId: action.promptId,
          approvalMode: action.approvalMode,
        }, approver);
        results.push(`${index + 1}. ${result}`);
      } catch (err) {
        logError("moderation.bulk-action-failed", err, {
          actionId: action.id,
          childTool: childAction.tool,
          index,
        });
        results.push(`${index + 1}. \`${childAction.tool}\` failed: ${err?.message || String(err)}`);
      }
    }
    return limitDiscordContent([`Bulk run complete (${results.length} action${results.length === 1 ? "" : "s"}):`, ...results].join("\n"));
  }

  if (action.tool === "ban_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.ban({ reason: makeActionAuditReason(action, approver) });
    const result = `I have banned ${summarizeMemberName(member)}.`;
    logInfo("moderation.execute.done", { actionId: action.id, tool: action.tool, ms: elapsedMs(startedAt) });
    return result;
  }

  if (action.tool === "unban_user") {
    const bannedUser = await guild.bans.fetch(action.targetId).catch(() => null);
    if (!bannedUser) return `User ID ${action.targetId} is not currently banned.`;
    await guild.members.unban(action.targetId, makeActionAuditReason(action, approver));
    return `I have unbanned ${bannedUser.user.tag} (${action.targetId}).`;
  }

  if (action.tool === "kick_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const displayName = member.displayName;
    const username = member.user.username;
    await member.kick(makeActionAuditReason(action, approver));
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
      reason: makeActionAuditReason(action, approver, `Softban: ${action.reason}`),
    });
    await guild.members.unban(member.id, makeActionAuditReason(action, approver, "Softban automatic unban"));
    return `I have softbanned ${displayName}, ${username}.`;
  }

  if (action.tool === "timeout_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.timeout(action.durationMs, makeActionAuditReason(action, approver));
    return `I have timed out ${summarizeMemberName(member)}.`;
  }

  if (action.tool === "untimeout_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.timeout(null, makeActionAuditReason(action, approver));
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
    await member.setNickname(action.nickname, makeActionAuditReason(action, approver));
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
      await member.roles.add(role, makeActionAuditReason(action, approver));
      return `I have added @${role.name} to ${member.displayName}, ${member.user.username}.`;
    }

    await member.roles.remove(role, makeActionAuditReason(action, approver));
    return `I have removed @${role.name} from ${member.displayName}, ${member.user.username}.`;
  }

  if (action.tool === "disconnect_member") {
    const member = await cachedMember(guild, action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.voice.disconnect(makeActionAuditReason(action, approver));
    return `I have disconnected ${member.displayName}, ${member.user.username} from voice.`;
  }

  if (action.tool === "move_member") {
    const member = await cachedMember(guild, action.targetId);
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return "I can only move members to a voice channel.";
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    await member.voice.setChannel(channel, makeActionAuditReason(action, approver));
    return `I have moved ${member.displayName}, ${member.user.username} to ${channel.name}.`;
  }

  if (action.tool === "voice_quarantine_member") {
    const member = await cachedMember(guild, action.targetId);
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;

    const configuredChannelId = getGuildSettings(guild.id).voiceQuarantineChannelId;
    if (!configuredChannelId || configuredChannelId !== action.channelId) {
      return "I did not quarantine anyone because the configured voice quarantine channel changed. Prepare the action again.";
    }
    const channel = await cachedChannel(guild, configuredChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return "The configured voice quarantine channel no longer exists.";
    }

    const durationMs = Math.max(60_000, Math.min(Number(action.durationMs) || 10 * 60 * 1000, 24 * 60 * 60 * 1000));
    const expiresAt = Date.now() + durationMs;
    const settings = getGuildSettings(guild.id);
    const quarantines = settings.voiceQuarantines && typeof settings.voiceQuarantines === "object"
      ? { ...settings.voiceQuarantines }
      : {};
    quarantines[member.id] = {
      channelId: channel.id,
      createdAt: Date.now(),
      expiresAt,
      moderatorId: approver.id,
      reason: action.reason || "No reason provided.",
    };
    updateGuildSettings(guild.id, { voiceQuarantines: quarantines });
    scheduleVoiceQuarantineExpiry(guild.id, member.id, expiresAt);

    if (member.voice.channelId && member.voice.channelId !== channel.id) {
      await member.voice.setChannel(channel, makeActionAuditReason(action, approver));
    }
    return `I have voice quarantined ${summarizeMemberName(member)} in ${channel.name} for ${Math.round(durationMs / 60000)} minute(s). They can disconnect, but will be moved back if they join another voice channel before it expires.`;
  }

  if (action.tool === "release_voice_quarantine") {
    const member = await cachedMember(guild, action.targetId);
    const released = clearVoiceQuarantine(guild.id, member.id);
    return released
      ? `I have released ${summarizeMemberName(member)} from voice quarantine.`
      : `${summarizeMemberName(member)} is not voice quarantined.`;
  }

  if (action.tool === "voice_mute_member" || action.tool === "voice_unmute_member") {
    const member = await cachedMember(guild, action.targetId);
    if (!member.voice.channel) return `${member.displayName}, ${member.user.username} is not in voice.`;
    const blockReason = memberActionBlockReason(action, botMember, member);
    if (blockReason) return blockReason;
    const mute = action.tool === "voice_mute_member";
    await member.voice.setMute(mute, makeActionAuditReason(action, approver));
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
    await member.voice.setDeaf(deaf, makeActionAuditReason(action, approver));
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
    await channel.delete(makeActionAuditReason(action, approver));
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

    await channel.setRateLimitPerUser(action.seconds, makeActionAuditReason(action, approver));
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
      reason: makeActionAuditReason(action, approver),
    });

    return denySend ? `I have locked ${channel}.` : `I have unlocked ${channel}.`;
  }

  if (action.tool === "create_text_channel") {
    const channel = await guild.channels.create({
      name: action.channelName,
      type: ChannelType.GuildText,
      reason: makeActionAuditReason(action, approver),
    });
    return `I have created ${channel}.`;
  }

  if (action.tool === "create_voice_channel") {
    const channel = await guild.channels.create({
      name: action.channelName,
      type: ChannelType.GuildVoice,
      reason: makeActionAuditReason(action, approver),
    });
    return `I have created voice channel ${channel.name}.`;
  }

  if (action.tool === "rename_channel") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("setName" in channel)) return "I can only rename a guild channel.";
    const oldName = channel.name;
    await channel.setName(action.newName, makeActionAuditReason(action, approver));
    resourceFetchCache.delete(`channel:${guild.id}:${action.channelId}`);
    return `I have renamed ${oldName} to ${action.newName}.`;
  }

  if (action.tool === "set_channel_topic") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel || !("setTopic" in channel)) return "I can only set topics in a text channel.";
    await channel.setTopic(action.topic, makeActionAuditReason(action, approver));
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

  if (action.tool === "announce") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("send" in channel)) return "I can only announce in a text channel.";
    const role = action.mentionRoleId ? await cachedRole(guild, action.mentionRoleId) : null;
    if (action.mentionRoleId && (!role || role.id === guild.id)) return "I could not resolve that announcement role.";
    const mention = role ? `<@&${role.id}>` : "";
    const payload = action.embedAnnouncement
      ? {
          content: mention || undefined,
          embeds: [new EmbedBuilder()
            .setTitle("Announcement")
            .setDescription(limitDiscordContent(action.messageText, 4000))
            .setColor(0x3b82f6)
            .setTimestamp()],
        }
      : { content: limitDiscordContent([mention, action.messageText].filter(Boolean).join("\n"), 1900) };
    payload.allowedMentions = role ? { roles: [role.id], parse: [] } : { parse: [] };
    await channel.send(payload);
    return `I sent the announcement in ${channel}.`;
  }

  if (action.tool === "pin_message" || action.tool === "unpin_message") {
    const channel = await cachedChannel(guild, action.channelId);
    if (!channel?.isTextBased?.() || !("messages" in channel)) return "I can only pin or unpin messages in a text channel.";

    const targetMessage = await channel.messages.fetch(action.messageId).catch(() => null);
    if (!targetMessage) return "I could not find that message.";

    if (action.tool === "pin_message") {
      await targetMessage.pin(makeActionAuditReason(action, approver));
      return `I have pinned that message in ${channel}.`;
    }

    await targetMessage.unpin(makeActionAuditReason(action, approver));
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
      reason: makeActionAuditReason(action, approver),
    });
    resourceFetchCache.delete(`channel:${guild.id}:${action.channelId}`);
    return `I have created thread ${thread}.`;
  }

  if (action.tool === "set_role_color") {
    const role = await cachedRole(guild, action.roleId);
    if (!canManageRole(botMember, role)) return "I cannot recolor that role because it is managed, missing, or at/above Duck's highest role.";

    await role.setColor(action.color, makeActionAuditReason(action, approver));
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
      reason: makeActionAuditReason(action, approver),
    });
    return `I have created @${role.name}.`;
  }

  if (action.tool === "delete_role") {
    const role = await cachedRole(guild, action.roleId);
    if (!canManageRole(botMember, role)) return "I cannot delete that role because it is managed, missing, or at/above Duck's highest role.";
    const roleName = role.name;
    await role.delete(makeActionAuditReason(action, approver));
    resourceFetchCache.delete(`role:${guild.id}:${action.roleId}`);
    return `I have deleted @${roleName}.`;
  }

  return "I do not know how to run that tool.";
}

function shouldAutoExecuteAction(guildId, action) {
  const mode = getGuildCapabilityMode(guildId);
  if (mode === CAPABILITY_MODES.agent) return { autoExecute: true, mode };
  if (mode === CAPABILITY_MODES.approve) {
    const actions = action.tool === "bulk_actions" ? action.actions ?? [] : [action];
    return {
      autoExecute: actions.length > 0 && actions.every((item) => item.risk === "low"),
      mode,
    };
  }
  return { autoExecute: false, mode: CAPABILITY_MODES.ask };
}

async function dispatchPlannedAction(message, action, options = {}) {
  const policy = shouldAutoExecuteAction(message.guildId, action);
  if (!policy.autoExecute) {
    await promptForConfirmation(message, action, options);
    return { autoExecuted: false, mode: policy.mode };
  }

  const approver = await resolveApprover(message);
  const executionAction = {
    ...action,
    id: `duck_auto:${Date.now()}:${message.id}`,
    guildId: message.guildId,
    requestedBy: message.author.id,
    requestChannelId: message.channelId,
    approvalMode: policy.mode,
  };
  const startedAt = Date.now();
  let result;
  try {
    result = await executeAction(client, executionAction, approver);
  } catch (err) {
    logError("capability.auto-execute-failed", err, {
      guildId: message.guildId,
      requesterId: message.author.id,
      tool: action.tool,
      mode: policy.mode,
    });
    result = `Duck hit an error while automatically running \`${action.tool}\`: ${err?.message || String(err)}`;
  }

  logInfo("capability.auto-executed", {
    guildId: message.guildId,
    requesterId: message.author.id,
    tool: action.tool,
    mode: policy.mode,
    ms: elapsedMs(startedAt),
  });

  const payload = makeDuckChatPayload(message, result, {
    title: policy.mode === CAPABILITY_MODES.agent ? "Agent Mode Result" : "Low-Risk Action Result",
    color: /^Duck hit an error/.test(result) ? DUCK_COLORS.danger : DUCK_COLORS.success,
    footer: `${getCapabilityModeLabel(policy.mode)} | Requested by ${message.author.username}`,
  });
  if (options.messageToEdit) await options.messageToEdit.edit(payload);
  else await message.reply(payload);
  return { autoExecuted: true, mode: policy.mode, result };
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
  const chunks = splitDiscordLines(String(result ?? "").split(/\r?\n/), 3900);
  const needsAttention = /\b(cannot|could not|did not|error|failed|missing|not currently|do not know)\b/i.test(String(result));
  const embeds = chunks.map((chunk, index) => new EmbedBuilder()
    .setTitle(needsAttention ? "Action Needs Attention" : "Action Completed")
    .setDescription(chunk)
    .setColor(needsAttention ? DUCK_COLORS.danger : DUCK_COLORS.success)
    .addFields(
      { name: "Action", value: commandLabel(action), inline: true },
      { name: "Tool", value: `\`${action.tool}\``, inline: true },
      { name: "Requested By", value: action.requestedBy ? `<@${action.requestedBy}>` : "Unknown", inline: true },
    )
    .setFooter({ text: chunks.length > 1 ? `Duck moderation result | Page ${index + 1}/${chunks.length}` : "Duck moderation result" })
    .setTimestamp());
  if ("update" in source && source.isButton?.()) {
    try {
      await source.update({ content: null, embeds: [embeds[0]], components: [] });
      for (const embed of embeds.slice(1)) {
        if ("followUp" in source) {
          await source.followUp({ embeds: [embed], ephemeral: true }).catch(() => {});
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
    await source.reply({ embeds: [embeds[0]], allowedMentions: { parse: [] } }).catch(async () => {
      if ("followUp" in source) {
        await source.followUp({ embeds: [embeds[0]], ephemeral: true }).catch(() => {});
      }
    });
    for (const embed of embeds.slice(1)) {
      if ("followUp" in source) {
        await source.followUp({ embeds: [embed], ephemeral: true }).catch(() => {});
      } else {
        await source.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
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

  await interaction.update({
    content: null,
    embeds: [new EmbedBuilder()
      .setTitle("Action Cancelled")
      .setDescription("Nothing was changed. The pending action has been removed.")
      .setColor(DUCK_COLORS.neutral)
      .addFields({ name: "Action", value: commandLabel(action), inline: true })
      .setTimestamp()],
    components: [],
  });
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
    await sendMessageChunks(message, "Only the requester or an Administrator can cancel that pending action.", {
      title: "Cancellation Denied",
      color: DUCK_COLORS.danger,
    }).catch(() => {});
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

  await sendMessageChunks(message, "Nothing was changed. The pending action has been removed.", {
    title: "Action Cancelled",
    color: DUCK_COLORS.neutral,
  }).catch(() => {});
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
    "**Moderation**",
    "`/ban` `/unban` `/kick` `/timeout` `/warn` `/warnings`",
    "`/clear` `/clearwarnings` `/addrole` `/removerole` `/tool`",
    "",
    "**Server Administration**",
    "`/announce` `/sendrules` `/bulk` `/prefix` `/capibility` `/setup` `/entry-setup` `/synccommands`",
    "`/setup quarantine-channel:<voice channel>` updates the voice quarantine destination.",
    "",
    "**Information & Utilities**",
    "`/userinfo` `/avatar` `/serverinfo` `/channelinfo` `/roleinfo`",
    "`/quote` `/ship` `/curse` `/spinwheel` `/remind` `/ping` `/test`",
    "",
    "**Voice Reader**",
    "`/join` reads messages from the joined voice channel's built-in text chat. `/leave` disconnects.",
    "",
    "**Prefix Commands**",
    "Every command also supports `!` and `!!`. Example: `!warn @user spam`.",
    "Bulk example: `!bulk warn @user spam; timeout @user 10m continued spam`.",
    "",
    `**Available extras (${UTILITY_COMMANDS.length})**`,
    ...UTILITY_COMMANDS.map((item) => `- ${item}`),
  ].join("\n");
}

function makeDiagnosticResponse(message) {
  const botMember = message.guild.members.me;
  const channelPermissions = botMember ? message.channel.permissionsFor(botMember) : null;
  const checks = [
    ["Gateway", client.isReady(), `${Math.round(client.ws.ping)}ms`],
    ["AI", hasConfiguredAi(), getConfiguredAiProvider() || "not configured"],
    ["Current channel", Boolean(channelPermissions?.has(PermissionsBitField.Flags.ViewChannel) && channelPermissions.has(PermissionsBitField.Flags.SendMessages)), "view + send"],
    ["Message history", Boolean(channelPermissions?.has(PermissionsBitField.Flags.ReadMessageHistory)), "read history"],
    ["Moderation channel", Boolean(getGuildSettings(message.guildId).modChannelId), getGuildSettings(message.guildId).modChannelId ? "configured" : "not configured"],
    ["Capability mode", true, getCapabilityModeLabel(getGuildCapabilityMode(message.guildId))],
    ["Cache", true, `${messageHistoryCache.size} message channels, ${resourceFetchCache.size} resources`],
    ["Storage writes", true, `${pendingJsonWrites.size} pending`],
    ["Voice runtime", supportsCurrentVoiceRuntime(), `${process.version}; requires Node >=22.12.0`],
  ];
  return [
    "Duck diagnostics:",
    ...checks.map(([name, ok, detail]) => `${ok ? "PASS" : "FAIL"} - ${name}: ${detail}`),
    `Build: ${buildInfo.commit} (${buildInfo.branch})`,
    `Node: ${process.version}`,
  ].join("\n");
}

function destroyVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);
  if (session) {
    session.destroying = true;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
    voiceSessions.delete(guildId);
    return true;
  }
  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
    return true;
  }
  return false;
}

async function synthesizeVoiceAudio(text) {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) throw new Error("ElevenLabs TTS is not configured. Set ELEVENLABS_API_KEY.");

  const voiceId = String(process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB").trim();
  const modelId = String(process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5").trim();
  const outputFormat = String(process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32").trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref?.();

  let response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: text.slice(0, 200),
          model_id: modelId,
          apply_text_normalization: "auto",
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") throw new Error("ElevenLabs TTS timed out after 15 seconds.");
    throw new Error(`ElevenLabs TTS request failed: ${err?.message || String(err)}`);
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const details = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`ElevenLabs TTS returned HTTP ${response.status}${details ? `: ${details}` : "."}`);
  }
  if (!response.body) {
    clearTimeout(timeout);
    throw new Error("ElevenLabs TTS returned an empty audio stream.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > 2 * 1024 * 1024) throw new Error("TTS audio exceeded Duck's 2 MB memory limit.");
      chunks.push(chunk);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err?.name === "AbortError") throw new Error("ElevenLabs TTS timed out after 15 seconds.");
    throw err;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  if (!totalBytes) throw new Error("ElevenLabs TTS returned no audio data.");
  return Buffer.concat(chunks, totalBytes);
}

async function playNextVoiceItem(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session || !session.ready || session.playing || !session.queue.length) return;
  session.playing = true;
  const text = session.queue.shift();
  try {
    const audio = await synthesizeVoiceAudio(text);
    if (voiceSessions.get(guildId) !== session || !session.ready) {
      session.playing = false;
      session.queue.unshift(text);
      return;
    }
    session.player.play(createAudioResource(Readable.from([audio]), {
      inputType: StreamType.Arbitrary,
    }));
    logInfo("voice.tts-started", {
      guildId,
      remainingQueue: session.queue.length,
      textLength: text.length,
      audioBytes: audio.length,
    });
  } catch (err) {
    session.playing = false;
    logError("voice.tts-create-failed", err, { guildId });
    await notifyVoiceSessionError(guildId, err);
    await playNextVoiceItem(guildId);
  }
}

function markVoiceSessionReady(guildId, session) {
  if (voiceSessions.get(guildId) !== session || session.destroying) return;
  if (session.handshakeTimer) {
    clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
  }
  session.ready = true;
  session.connection.subscribe(session.player);
  logInfo("voice.ready", {
    guildId,
    voiceChannelId: session.voiceChannelId,
    queuedItems: session.queue.length,
  });
  playNextVoiceItem(guildId).catch((err) => logError("voice.queue-failed", err, { guildId }));
}

function scheduleVoiceHandshakeCheck(guildId, session) {
  if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
  session.handshakeTimer = setTimeout(() => {
    if (voiceSessions.get(guildId) !== session || session.destroying || session.ready) return;

    session.handshakeAttempts += 1;
    const status = session.connection.state.status;
    if (session.handshakeAttempts < 3 && status !== VoiceConnectionStatus.Destroyed) {
      logWarn("voice.handshake-retry", {
        guildId,
        voiceChannelId: session.voiceChannelId,
        attempt: session.handshakeAttempts + 1,
        status,
      });
      session.connection.rejoin();
      scheduleVoiceHandshakeCheck(guildId, session);
      return;
    }

    const err = new Error(`Discord voice handshake stayed in ${status} after ${session.handshakeAttempts} attempts.`);
    logError("voice.handshake-stalled", err, {
      guildId,
      voiceChannelId: session.voiceChannelId,
      status,
    });
    notifyVoiceSessionError(guildId, err).catch(() => {});
  }, 15_000);
  session.handshakeTimer.unref?.();
}

function createVoiceSession(message, channel, connection) {
  const guildId = message.guildId;
  const player = createAudioPlayer();
  const session = {
    connection,
    player,
    queue: [],
    playing: false,
    ready: connection.state.status === VoiceConnectionStatus.Ready,
    destroying: false,
    handshakeAttempts: 0,
    handshakeTimer: null,
    voiceChannelId: channel.id,
    textChannelId: channel.id,
    lastErrorNoticeAt: 0,
  };

  voiceSessions.set(guildId, session);
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    session.playing = false;
    playNextVoiceItem(guildId).catch((err) => logError("voice.queue-failed", err, { guildId }));
  });
  player.on(AudioPlayerStatus.Buffering, () => {
    logDebug("voice.player-buffering", { guildId, voiceChannelId: channel.id });
  });
  player.on(AudioPlayerStatus.Playing, () => {
    logInfo("voice.player-playing", { guildId, voiceChannelId: channel.id });
  });
  player.on("error", (err) => {
    session.playing = false;
    logError("voice.player-error", err, { guildId });
    notifyVoiceSessionError(guildId, err).catch(() => {});
    playNextVoiceItem(guildId).catch(() => {});
  });

  connection.on("stateChange", (oldState, newState) => {
    logDebug("voice.state-change", {
      guildId,
      voiceChannelId: channel.id,
      from: oldState.status,
      to: newState.status,
    });
    if (newState.status === VoiceConnectionStatus.Ready) {
      markVoiceSessionReady(guildId, session);
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      session.ready = false;
      if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
      if (voiceSessions.get(guildId) === session) voiceSessions.delete(guildId);
    } else {
      session.ready = false;
    }
  });
  connection.on("error", (err) => {
    logError("voice.connection-error", err, {
      guildId,
      voiceChannelId: channel.id,
      status: connection.state.status,
    });
    notifyVoiceSessionError(guildId, err).catch(() => {});
  });
  connection.on("debug", (details) => {
    logDebug("voice.transport", {
      guildId,
      voiceChannelId: channel.id,
      details: String(details).slice(0, 2_000),
    });
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        entersState(connection, VoiceConnectionStatus.Ready, 5_000),
      ]);
      logWarn("voice.reconnecting", { guildId, channelId: channel.id });
    } catch (err) {
      if (voiceSessions.get(guildId) === session) voiceSessions.delete(guildId);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      logWarn("voice.disconnected", {
        guildId,
        channelId: channel.id,
        error: err?.message || String(err),
      });
    }
  });

  if (session.ready) markVoiceSessionReady(guildId, session);
  else scheduleVoiceHandshakeCheck(guildId, session);
  return session;
}

async function waitForVoiceReady(connection, timeoutMs = 1_500) {
  if (connection.state.status === VoiceConnectionStatus.Ready) return true;
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
    return true;
  } catch (err) {
    if (connection.state.status === VoiceConnectionStatus.Destroyed) {
      throw new Error("Discord destroyed the voice connection during the handshake.", { cause: err });
    }
    return false;
  }
}

async function notifyVoiceSessionError(guildId, err) {
  const session = voiceSessions.get(guildId);
  if (!session || Date.now() - (session.lastErrorNoticeAt || 0) < 30_000) return;
  session.lastErrorNoticeAt = Date.now();
  const channel = client.channels.cache.get(session.textChannelId)
    ?? await client.channels.fetch(session.textChannelId).catch(() => null);
  if (!channel?.isTextBased?.() || !("send" in channel)) return;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("Voice Reader Error")
      .setDescription(`TTS playback failed: ${String(err?.message || err).slice(0, 1000)}`)
      .setColor(DUCK_COLORS.danger)
      .setFooter({ text: "Check Wispbyte logs for voice.player-error or voice.tts-create-failed." })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

async function joinVoiceForMessage(message) {
  if (!supportsCurrentVoiceRuntime()) {
    return `Voice TTS requires Node 22.12 or newer for Discord's DAVE voice encryption. This server is running ${process.version}; update the Wispbyte Node/Docker image, restart Duck, then run join again.`;
  }
  const channel = message.member?.voice?.channel;
  if (!channel) return "Join a voice channel first, then run this command.";
  const botPermissions = channel.permissionsFor(message.guild.members.me);
  if (!botPermissions?.has(PermissionsBitField.Flags.Connect) || !botPermissions.has(PermissionsBitField.Flags.Speak)) {
    return "Duck needs Connect and Speak permissions in your voice channel.";
  }

  const current = voiceSessions.get(message.guildId);
  if (current?.voiceChannelId === channel.id && current.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    const ready = await waitForVoiceReady(current.connection);
    return ready
      ? `Already connected to ${channel}. I am reading this voice channel's text chat.`
      : `I am already in ${channel}, but Discord's voice handshake is still connecting. Messages will stay queued and play automatically when it becomes ready.`;
  }

  destroyVoiceSession(message.guildId);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: message.guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
    // DAVE currently causes silent outgoing audio for some Discord bot connections.
    daveEncryption: getEnvBoolean("DUCK_VOICE_DAVE", false),
    debug: isDebugEnabled(),
  });
  createVoiceSession(message, channel, connection);
  const ready = await waitForVoiceReady(connection);
  logInfo("voice.joined", {
    guildId: message.guildId,
    voiceChannelId: channel.id,
    textChannelId: channel.id,
    userId: message.author.id,
    daveEncryption: getEnvBoolean("DUCK_VOICE_DAVE", false),
    ready,
    status: connection.state.status,
  });
  return ready
    ? `Joined ${channel}. I will read messages from this voice channel's text chat.`
    : `Joined ${channel}. Discord's voice handshake is still connecting; messages in this voice channel's text chat will queue and play automatically when it becomes ready.`;
}

function enqueueVoiceText(guildId, spoken) {
  const session = voiceSessions.get(guildId);
  if (!session) return false;
  if (session.queue.length >= 20) session.queue.shift();
  session.queue.push(String(spoken).slice(0, 200));
  logDebug("voice.tts-queued", {
    guildId,
    channelId: session.textChannelId,
    queueLength: session.queue.length,
    textLength: String(spoken).length,
  });
  playNextVoiceItem(guildId).catch((err) => logError("voice.queue-failed", err, { guildId }));
  return true;
}

function queueVoiceMessage(message) {
  const session = voiceSessions.get(message.guildId);
  if (!session || session.textChannelId !== message.channelId || message.author.bot) return;
  if (getLegacyCommandContent(message.content, message.guildId) || /^\s*(duck\b|<@!?\d+>)/i.test(message.content)) return;
  const spoken = message.cleanContent.replace(/https?:\/\/\S+/gi, "link").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!spoken) return;
  enqueueVoiceText(message.guildId, `${message.member?.displayName || message.author.username} says: ${spoken}`);
}

function parseBulkCommands(text) {
  return String(text || "")
    .replace(/^bulk\b/i, "")
    .split(/(?:\r?\n|\s*;\s*)/)
    .map((item) => item.trim().replace(/^!{1,2}/, ""))
    .filter(Boolean)
    .slice(0, 11);
}

function buildBulkPlan(message, text) {
  const commands = parseBulkCommands(text);
  if (commands.length < 2) return { error: "Bulk needs at least 2 commands separated by semicolons or new lines." };
  if (commands.length > 10) return { error: "Bulk supports at most 10 actions at once." };
  const actions = [];
  for (const command of commands) {
    if (/^bulk\b/i.test(command)) return { error: "Nested bulk commands are not allowed." };
    const commandMessage = makeMessageWithContent(message, command);
    const action = planLocalModerationTool(commandMessage);
    if (!action || action.error) return { error: `Could not validate \`${command}\`: ${action?.error || "not a supported action"}` };
    actions.push(action);
  }
  return makeValidatedBulkPlan(message, actions);
}

async function handleExplicitCommand(message, text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  if (/^bulk\b/.test(normalized)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await sendMessageChunks(message, "Only an Administrator can prepare bulk actions.");
      return true;
    }
    const plan = buildBulkPlan(message, text);
    if (plan.error) {
      await sendMessageChunks(message, plan.error);
      return true;
    }
    await dispatchPlannedAction(message, plan, {
      content: `Prepared ${plan.actions.length} validated actions. One Administrator confirmation will run them in order.`,
      useEmbed: true,
    });
    return true;
  }

  if (/^prefix\b/.test(normalized)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await sendMessageChunks(message, "Only an Administrator can change Duck's command prefix.");
      return true;
    }
    const value = text.replace(/^prefix\b/i, "").trim();
    if (!value || value.length > 5 || /[\s/@]/.test(value)) {
      await sendMessageChunks(message, "Usage: `!prefix <1-5 visible characters>`");
      return true;
    }
    updateGuildSettings(message.guildId, { commandPrefix: value });
    await sendMessageChunks(message, `Duck's additional prefix is now \`${value}\`.`);
    return true;
  }

  if (/^synccommands\b/.test(normalized)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await sendMessageChunks(message, "Only an Administrator can synchronize Duck's slash commands.");
      return true;
    }
    const result = await registerCommands(client, { guildIds: [message.guildId], syncGlobal: false });
    await sendMessageChunks(message, `Synchronized ${result.commandCount} slash commands in this server. Discord should show the current options immediately.`);
    return true;
  }

  if (/^sendrules\b/.test(normalized)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await sendMessageChunks(message, "Only an Administrator can post the server rules embed.");
      return true;
    }
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`${message.guild.name} Rules`)
        .setDescription(formatRulesText())
        .setColor(0x3b82f6)
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
    await sendMessageChunks(message, "Rules posted.");
    return true;
  }

  if (/^announce\b/.test(normalized)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await sendMessageChunks(message, "Only an Administrator can prepare announcements.");
      return true;
    }
    const match = text.match(/^announce\s+(true|false)\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) {
      await sendMessageChunks(message, "Usage: `!announce <true/false> <@role/None> <message>`");
      return true;
    }
    const roleToken = match[2];
    const roleId = /^none$/i.test(roleToken) ? null : roleToken.match(/^<@&(\d+)>$/)?.[1];
    if (!/^none$/i.test(roleToken) && !roleId) {
      await sendMessageChunks(message, "Mention one role or use `None`.");
      return true;
    }
    const role = roleId ? message.guild.roles.cache.get(roleId) : null;
    if (roleId && (!role || role.id === message.guild.id)) {
      await sendMessageChunks(message, "I could not resolve that role.");
      return true;
    }
    await dispatchPlannedAction(message, {
      tool: "announce",
      risk: "high",
      channelId: message.channelId,
      channelName: message.channel.name,
      messageText: match[3].trim(),
      embedAnnouncement: match[1].toLowerCase() === "true",
      mentionRoleId: roleId,
      reason: "Administrator announcement request.",
      summary: `announce in ${summarizeChannel(message.channel)}${role ? ` mentioning @${role.name}` : " without a role ping"}`,
    }, { content: "Announcement prepared for confirmation.", useEmbed: true });
    return true;
  }

  const utilityResponse = await makeUtilityResponse(message, text);
  if (utilityResponse) {
    await sendMessageChunks(message, utilityResponse);
    return true;
  }

  const plan = planLocalModerationTool(message);
  if (!plan) return false;
  if (plan.error) {
    await sendMessageChunks(message, plan.error);
    return true;
  }
  const needed = TOOL_REQUIREMENTS[plan.tool];
  if (needed && !hasPermission(message.member, needed)) {
    await sendMessageChunks(message, `You need ${describePermissionRequirement(needed)} to prepare \`${plan.tool}\`.`);
    return true;
  }
  const hierarchyError = requesterActionBlockReason(message, plan);
  if (hierarchyError) {
    await sendMessageChunks(message, hierarchyError);
    return true;
  }
  await dispatchPlannedAction(message, plan, {
    content: "Command validated. Waiting for Administrator confirmation.",
    useEmbed: true,
  });
  return true;
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
    const cooldownKey = `${message.guildId}:${message.author.id}:ping`;
    const now = Date.now();
    const lastUsed = commandCooldowns.get(cooldownKey) || 0;
    if (now - lastUsed < 3_000) return `Ping is on cooldown for ${Math.ceil((3_000 - (now - lastUsed)) / 1000)}s.`;
    commandCooldowns.set(cooldownKey, now);
    if (commandCooldowns.size > 1_000) {
      for (const [key, usedAt] of commandCooldowns) {
        if (now - usedAt > 60_000) commandCooldowns.delete(key);
      }
    }
    return `Pong. Discord gateway ping: ${Math.round(client.ws.ping)}ms.`;
  }

  if (/^test\b/.test(normalized)) {
    return makeDiagnosticResponse(message);
  }

  if (/^join\b/.test(normalized)) {
    try {
      return await joinVoiceForMessage(message);
    } catch (err) {
      logError("voice.join-failed", err, { guildId: message.guildId, userId: message.author.id });
      return `I could not join voice: ${err?.message || String(err)}`;
    }
  }

  if (/^leave\b/.test(normalized)) {
    return destroyVoiceSession(message.guildId) ? "Disconnected from voice." : "I am not connected to voice.";
  }

  if (/^tts\b/.test(normalized)) {
    const session = voiceSessions.get(message.guildId);
    if (!session) return "Use `/join` or `!join` before queueing TTS.";
    if (message.member?.voice?.channelId !== session.connection.joinConfig.channelId) {
      return "Join Duck's current voice channel before queueing TTS.";
    }
    const spoken = text.replace(/^tts\b/i, "").replace(/https?:\/\/\S+/gi, "link").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!spoken) {
      return session.ready
        ? `TTS is active in <#${session.textChannelId}>. Send a normal message there and Duck will read it aloud.`
        : `TTS is bound to <#${session.textChannelId}>, but the voice handshake is still connecting. Messages will queue until it is ready.`;
    }
    enqueueVoiceText(message.guildId, `${message.member.displayName} says: ${spoken}`);
    return session.ready ? `Queued for voice: ${spoken}` : `Queued while voice connects: ${spoken}`;
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

  if (/^coinflip\b/.test(normalized)) {
    return `The coin landed on **${Math.random() < 0.5 ? "heads" : "tails"}**.`;
  }

  if (/^roll\b/.test(normalized)) {
    const notation = text.replace(/^roll\b/i, "").trim().toLowerCase() || "1d6";
    const match = notation.match(/^(\d{1,2})?d(\d{1,4})$/);
    if (!match) return "Usage: `!roll 2d20` (up to 20 dice with 1,000 sides).";
    const count = Math.max(1, Math.min(Number(match[1]) || 1, 20));
    const sides = Math.max(2, Math.min(Number(match[2]), 1000));
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((sum, value) => sum + value, 0);
    return `Rolled **${count}d${sides}**: ${rolls.join(", ")}\nTotal: **${total}**`;
  }

  if (/^eightball\b/.test(normalized)) {
    const question = text.replace(/^eightball\b/i, "").trim();
    if (!question) return "Usage: `!eightball <question>`";
    const answer = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
    return `**Question:** ${limitDiscordContent(question, 500)}\n**Answer:** ${answer}`;
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

function makeSlashCommandMessage(interaction, content, channelOverride = null) {
  const channel = channelOverride ?? interaction.channel;
  const members = new Collection();
  const channels = new Collection();
  const roles = new Collection();
  for (const match of String(content).matchAll(/<@!?(\d+)>/g)) {
    const member = interaction.guild.members.cache.get(match[1]);
    if (member) members.set(member.id, member);
  }
  for (const match of String(content).matchAll(/<#(\d+)>/g)) {
    const target = interaction.guild.channels.cache.get(match[1]);
    if (target) channels.set(target.id, target);
  }
  for (const match of String(content).matchAll(/<@&(\d+)>/g)) {
    const role = interaction.guild.roles.cache.get(match[1]);
    if (role) roles.set(role.id, role);
  }
  const member = interaction.guild.members.cache.get(interaction.user.id) ?? interaction.member;
  return {
    id: interaction.id,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel,
    channelId: channel.id,
    member,
    author: interaction.user,
    content,
    cleanContent: content,
    createdAt: interaction.createdAt,
    reference: null,
    mentions: { members, channels, roles, repliedUser: null },
    async reply(payload) {
      const data = typeof payload === "string" ? { content: payload } : payload;
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(data);
        return interaction.fetchReply();
      }
      return interaction.followUp({ ...data, fetchReply: true });
    },
  };
}

function slashCommandContent(interaction) {
  const name = interaction.commandName;
  const userMention = (optionName) => {
    const user = interaction.options.getUser(optionName, false);
    return user ? `<@${user.id}>` : "";
  };
  const roleMention = (optionName) => {
    const role = interaction.options.getRole(optionName, false);
    return role ? `<@&${role.id}>` : "";
  };
  const channelMention = (optionName) => {
    const channel = interaction.options.getChannel(optionName, false);
    return channel ? `<#${channel.id}>` : "";
  };
  const reason = () => interaction.options.getString("reason", false) || "No reason provided.";
  switch (name) {
    case "commands": return "commands";
    case "ping": return "ping";
    case "test": return "test";
    case "serverinfo": return "serverinfo";
    case "userinfo": return `userinfo ${userMention("member")}`;
    case "avatar": return `avatar ${userMention("member")}`;
    case "channelinfo": return `channelinfo ${channelMention("channel")}`;
    case "roleinfo": return `roleinfo ${roleMention("role")}`;
    case "ship": return `ship ${userMention("user1")} ${userMention("user2")}`;
    case "curse": return `curse ${userMention("user")}`;
    case "spinwheel": return `spinwheel ${interaction.options.getString("choices", true)}`;
    case "roll": return `roll ${interaction.options.getString("dice", false) || "1d6"}`;
    case "coinflip": return "coinflip";
    case "eightball": return `eightball ${interaction.options.getString("question", true)}`;
    case "remind": return `remind ${interaction.options.getString("time", true)} ${interaction.options.getString("text", true)}`;
    case "join": return "join";
    case "leave": return "leave";
    case "tts": return `tts ${interaction.options.getString("message", true)}`;
    case "ban": return `ban ${userMention("member")} ${reason()}`;
    case "unban": return `unban ${interaction.options.getString("user-id", true)} ${reason()}`;
    case "kick": return `kick ${userMention("member")} ${reason()}`;
    case "timeout": return `timeout ${userMention("member")} ${interaction.options.getInteger("minutes", true)}m ${reason()}`;
    case "warn": return `warn ${userMention("member")} ${reason()}`;
    case "warnings": return `warnings ${userMention("member")}`;
    case "clearwarnings": return `clear ${interaction.options.getString("count", true)} warnings for ${userMention("member")}`;
    case "clear": return `purge ${interaction.options.getInteger("count", true)}`;
    case "voicequarantine": return `voice quarantine ${userMention("member")} ${interaction.options.getInteger("minutes", true)}m ${reason()}`;
    case "voicerelease": return `voice release ${userMention("member")} ${reason()}`;
    case "addrole": return `add role ${roleMention("role")} to ${userMention("member")} ${reason()}`;
    case "removerole": return `remove role ${roleMention("role")} from ${userMention("member")} ${reason()}`;
    case "tool": return interaction.options.getString("request", true);
    case "bulk": return `bulk ${interaction.options.getString("commands", true)}`;
    case "sendrules": return "sendrules";
    case "quote": {
      const action = interaction.options.getString("action", false) || "view";
      const quoteText = interaction.options.getString("text", false) || "";
      return action === "view" ? "quote" : `quote ${action} ${quoteText}`.trim();
    }
    default: return null;
  }
}

function validateSlashCommandDispatchers(commandBodies) {
  const separatelyHandled = new Set(["duck", "setup", "duck-tools", "entry-setup", "announce", "prefix", "capibility", "synccommands"]);
  const setupCommand = commandBodies.find((command) => command.name === "setup");
  const setupOptions = new Map((setupCommand?.options || []).map((option) => [option.name, option]));
  if (!setupOptions.has("channel") || !setupOptions.has("quarantine-channel")) {
    throw new Error("/setup must expose both channel and quarantine-channel options.");
  }
  if (setupOptions.get("quarantine-channel").required) {
    throw new Error("/setup quarantine-channel must remain optional so either setup field can be changed independently.");
  }
  let validated = 0;
  for (const command of commandBodies) {
    if (separatelyHandled.has(command.name)) continue;
    const optionNames = new Set((command.options || []).map((option) => option.name));
    const readOption = (name, value) => {
      if (!optionNames.has(name)) throw new Error(`/${command.name} dispatcher read undeclared option '${name}'.`);
      return value;
    };
    const interaction = {
      commandName: command.name,
      options: {
        getString: (name) => readOption(name, name === "action" ? "view" : name === "dice" ? "1d6" : "test"),
        getInteger: (name) => readOption(name, 1),
        getUser: (name) => readOption(name, { id: "100000000000000001" }),
        getRole: (name) => readOption(name, { id: "100000000000000002" }),
        getChannel: (name) => readOption(name, { id: "100000000000000003" }),
      },
    };
    if (!slashCommandContent(interaction)) throw new Error(`/${command.name} has no slash dispatcher.`);
    validated += 1;
  }
  return validated;
}

async function makeSlashDuckResponse(interaction, prompt) {
  const normalized = normalizeText(prompt || "commands");

  if (/^(help|commands|tools|what can you do)\b/.test(normalized)) {
    return [
      makeUtilityHelp(),
      "",
      "Slash commands:",
      "- `/commands`, `/ping`, `/test`, `/userinfo`, `/serverinfo`",
      "- `/ban`, `/unban`, `/kick`, `/timeout`, `/warn`, `/warnings`",
      "- `/clear`, `/clearwarnings`, `/voicequarantine`, `/voicerelease`",
      "- `/addrole`, `/removerole`, `/tool`",
      "- `/announce`, `/sendrules`, `/bulk`, `/prefix`, `/join`, `/leave`",
      "- `/setup`, `/entry-setup`, `/synccommands`, `/duck-tools`",
      "",
      "For AI chat and moderation, use normal messages like `duck warn @user spam` or `hey duck show me commands`.",
    ].join("\n");
  }

  if (/^(ping|latency)\b/.test(normalized)) {
    return `Pong. Discord gateway ping: ${Math.round(client.ws.ping)}ms.`;
  }

  if (/^(rules|sendrules)\b/.test(normalized)) {
    return formatRulesText();
  }

  if (/^(botinfo|bot info|about duck|version)\b/.test(normalized)) {
    return [
      "Duck bot info",
      `Version: ${packageInfo.version}`,
      `Commit: ${buildInfo.commit}`,
      `Commit name: ${buildInfo.commitName}`,
      `Branch: ${buildInfo.branch}`,
      `Node: ${process.version}`,
      `AI provider: ${process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "none")}`,
    ].join("\n");
  }

  logInfo("discord.duck-slash-prompt-redirected", {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    promptLength: String(prompt || "").length,
  });
  return "For AI requests, use normal chat so Duck can see message context. Example: `hey duck show me commands`.";
}

function getResponsePresentation(message, content, options = {}) {
  const command = normalizeText(options.command || message.content || "duck").split(/\s+/)[0];
  const configured = COMMAND_PRESENTATION[command] ?? ["Duck", DUCK_COLORS.neutral];
  const text = String(content || "");
  const isError = /^(only |usage:|unknown |you need |you cannot |i cannot |i could not |could not |give me |mention |pick )/i.test(text)
    || /\bfailed\b/i.test(text);
  const isSuccess = /^(pong|pass|joined|disconnected|reminder set|rules posted|quote #|duck's additional prefix)/i.test(text);
  return {
    title: options.title || configured[0],
    color: options.color || (isError ? DUCK_COLORS.danger : isSuccess ? DUCK_COLORS.success : configured[1]),
  };
}

function makeCommandResponseEmbed(message, content, options = {}) {
  const presentation = getResponsePresentation(message, content, options);
  const embed = new EmbedBuilder()
    .setTitle(presentation.title)
    .setDescription(String(content || "Duck has nothing to send.").slice(0, 4096))
    .setColor(presentation.color)
    .setTimestamp();

  const targetMember = message.mentions?.members?.first?.() ?? message.member;
  const command = normalizeText(options.command || message.content || "").split(/\s+/)[0];
  if (["userinfo", "whois", "avatar"].includes(command) && targetMember?.user) {
    embed.setThumbnail(targetMember.user.displayAvatarURL({ size: 256 }));
  } else if (command === "serverinfo" && message.guild?.iconURL) {
    const icon = message.guild.iconURL({ size: 256 });
    if (icon) embed.setThumbnail(icon);
  } else if (["commands", "help"].includes(command) && client.user) {
    embed.setThumbnail(client.user.displayAvatarURL({ size: 256 }));
  }

  const pageText = options.pageCount > 1 ? ` | Page ${options.page}/${options.pageCount}` : "";
  embed.setFooter({
    text: `Requested by ${message.member?.displayName || message.author?.username || "Unknown"}${pageText}`,
    iconURL: message.author?.displayAvatarURL?.({ size: 64 }),
  });
  return embed;
}

function makeDuckChatEmbed(message, content, options = {}) {
  const embed = new EmbedBuilder()
    .setTitle(options.title || "Duck")
    .setDescription(limitDiscordContent(content, 4000))
    .setColor(options.color || DUCK_COLORS.brand)
    .setTimestamp();
  if (client.user) {
    embed.setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL({ size: 64 }) });
  }
  embed.setFooter({
    text: options.footer || `For ${message.member?.displayName || message.author?.username || "this server"}`,
  });
  return embed;
}

function makeDuckChatPayload(message, content, options = {}) {
  return {
    content: null,
    embeds: [makeDuckChatEmbed(message, content, options)],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function sendMessageChunks(message, content, options = {}) {
  const chunks = splitDiscordLines(String(content ?? "").split(/\r?\n/), 3900);
  const embeds = chunks.map((chunk, index) => makeCommandResponseEmbed(message, chunk, {
    ...options,
    page: index + 1,
    pageCount: chunks.length,
  }));
  const first = await message.reply({
    embeds: [embeds[0]],
    allowedMentions: { parse: [], repliedUser: false },
  });
  for (const embed of embeds.slice(1)) {
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
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
    const referenced = message.channel.messages.cache.get(message.reference.messageId)
      ?? await message.channel.messages.fetch(message.reference.messageId);
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

async function registerCommands(client, options = {}) {
  const startedAt = Date.now();
  const setupCommand = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Duck's moderation and voice quarantine channels.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel Duck should listen in.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName("quarantine-channel")
        .setDescription("Voice channel used by Administrator-only voice quarantine actions.")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false),
    );

  const toolsCommand = new SlashCommandBuilder()
    .setName("duck-tools")
    .setDescription("Show Duck's moderation tools.");

  const duckCommand = new SlashCommandBuilder()
    .setName("duck")
    .setDescription("Show Duck help or run a simple Duck utility.")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Try commands, help, ping, botinfo, rules, or use normal chat for AI requests.")
        .setRequired(false),
    );

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

  const memberReasonCommand = (name, description, permission) => new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(permission)
    .addUserOption((option) => option.setName("member").setDescription("Target member.").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("Reason for the action.").setRequired(true));

  const utilityCommands = [
    new SlashCommandBuilder().setName("commands").setDescription("Show Duck's command list."),
    new SlashCommandBuilder().setName("ping").setDescription("Show Duck's Discord gateway latency."),
    new SlashCommandBuilder().setName("test").setDescription("Run Duck's diagnostic checks."),
    new SlashCommandBuilder().setName("serverinfo").setDescription("Show server information."),
    new SlashCommandBuilder().setName("userinfo").setDescription("Show member information.")
      .addUserOption((option) => option.setName("member").setDescription("Member to inspect.").setRequired(false)),
    new SlashCommandBuilder().setName("avatar").setDescription("Show a member's avatar.")
      .addUserOption((option) => option.setName("member").setDescription("Member whose avatar to show.").setRequired(false)),
    new SlashCommandBuilder().setName("channelinfo").setDescription("Show channel information.")
      .addChannelOption((option) => option.setName("channel").setDescription("Channel to inspect.").setRequired(false)),
    new SlashCommandBuilder().setName("roleinfo").setDescription("Show role information.")
      .addRoleOption((option) => option.setName("role").setDescription("Role to inspect.").setRequired(true)),
    new SlashCommandBuilder().setName("ship").setDescription("Calculate a deterministic compatibility score.")
      .addUserOption((option) => option.setName("user1").setDescription("First user.").setRequired(true))
      .addUserOption((option) => option.setName("user2").setDescription("Second user; defaults to you.").setRequired(false)),
    new SlashCommandBuilder().setName("curse").setDescription("Cast a funny curse or blessing.")
      .addUserOption((option) => option.setName("user").setDescription("Target user.").setRequired(false)),
    new SlashCommandBuilder().setName("spinwheel").setDescription("Pick from comma-separated choices.")
      .addStringOption((option) => option.setName("choices").setDescription("Example: pizza, tacos, sushi").setRequired(true)),
    new SlashCommandBuilder().setName("roll").setDescription("Roll dice using notation such as 2d20.")
      .addStringOption((option) => option.setName("dice").setDescription("Dice notation; defaults to 1d6.").setRequired(false)),
    new SlashCommandBuilder().setName("coinflip").setDescription("Flip a coin."),
    new SlashCommandBuilder().setName("eightball").setDescription("Ask Duck's Magic 8-Ball a question.")
      .addStringOption((option) => option.setName("question").setDescription("Your question.").setRequired(true)),
    new SlashCommandBuilder().setName("remind").setDescription("Set a reminder in this channel.")
      .addStringOption((option) => option.setName("time").setDescription("Examples: 30s, 10m, 2h.").setRequired(true))
      .addStringOption((option) => option.setName("text").setDescription("Reminder text.").setRequired(true)),
    new SlashCommandBuilder().setName("quote").setDescription("View, add, or list quotes.")
      .addStringOption((option) => option.setName("action").setDescription("view, add, or list").setRequired(false)
        .addChoices({ name: "View random", value: "view" }, { name: "Add", value: "add" }, { name: "List", value: "list" }))
      .addStringOption((option) => option.setName("text").setDescription("Quote text when adding.").setRequired(false)),
    new SlashCommandBuilder().setName("join").setDescription("Join your voice channel and read its built-in text chat."),
    new SlashCommandBuilder().setName("leave").setDescription("Disconnect Duck from voice."),
    new SlashCommandBuilder().setName("tts").setDescription("Queue a short TTS message while connected to Duck's voice channel.")
      .addStringOption((option) => option.setName("message").setDescription("Text to read aloud.").setMaxLength(200).setRequired(true)),
  ];

  const moderationCommands = [
    memberReasonCommand("ban", "Ban a member after Administrator confirmation.", PermissionsBitField.Flags.BanMembers),
    new SlashCommandBuilder().setName("unban").setDescription("Unban an exact Discord user ID.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .addStringOption((option) => option.setName("user-id").setDescription("Exact Discord user ID.").setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for unbanning.").setRequired(true)),
    memberReasonCommand("kick", "Kick a member after Administrator confirmation.", PermissionsBitField.Flags.KickMembers),
    new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member for up to 28 days.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption((option) => option.setName("member").setDescription("Target member.").setRequired(true))
      .addIntegerOption((option) => option.setName("minutes").setDescription("Timeout duration in minutes.").setMinValue(1).setMaxValue(40320).setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for timeout.").setRequired(true)),
    memberReasonCommand("warn", "Store and DM a warning after confirmation.", PermissionsBitField.Flags.ModerateMembers),
    new SlashCommandBuilder().setName("warnings").setDescription("List stored warnings for a member.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption((option) => option.setName("member").setDescription("Member to inspect.").setRequired(true)),
    new SlashCommandBuilder().setName("clearwarnings").setDescription("Clear stored warnings after confirmation.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
      .addUserOption((option) => option.setName("member").setDescription("Target member.").setRequired(true))
      .addStringOption((option) => option.setName("count").setDescription("Number to clear, or all.").setRequired(true)),
    new SlashCommandBuilder().setName("clear").setDescription("Purge recent messages after confirmation.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
      .addIntegerOption((option) => option.setName("count").setDescription("Messages to remove.").setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName("voicequarantine").setDescription("Keep a member in the configured quarantine VC for up to 24 hours.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addUserOption((option) => option.setName("member").setDescription("Member to quarantine.").setRequired(true))
      .addIntegerOption((option) => option.setName("minutes").setDescription("Duration from 1 to 1440 minutes.").setMinValue(1).setMaxValue(1440).setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for voice quarantine.").setRequired(true)),
    new SlashCommandBuilder().setName("voicerelease").setDescription("Release a member from voice quarantine.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addUserOption((option) => option.setName("member").setDescription("Member to release.").setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for release.").setRequired(false)),
    new SlashCommandBuilder().setName("addrole").setDescription("Assign an editable role after confirmation.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
      .addUserOption((option) => option.setName("member").setDescription("Target member.").setRequired(true))
      .addRoleOption((option) => option.setName("role").setDescription("Role to add.").setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for role assignment.").setRequired(false)),
    new SlashCommandBuilder().setName("removerole").setDescription("Remove an editable role after confirmation.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
      .addUserOption((option) => option.setName("member").setDescription("Target member.").setRequired(true))
      .addRoleOption((option) => option.setName("role").setDescription("Role to remove.").setRequired(true))
      .addStringOption((option) => option.setName("reason").setDescription("Reason for role removal.").setRequired(false)),
    new SlashCommandBuilder().setName("tool").setDescription("Run any Duck tool using a normal-language request.")
      .addStringOption((option) => option.setName("request").setDescription("Example: lock #general for a raid").setRequired(true)),
  ];

  const adminCommands = [
    new SlashCommandBuilder().setName("sendrules").setDescription("Post the formatted server rules embed.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName("announce").setDescription("Send an approved server announcement.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addBooleanOption((option) => option.setName("embed").setDescription("Use an embed instead of raw text.").setRequired(true))
      .addStringOption((option) => option.setName("message").setDescription("Announcement text.").setRequired(true))
      .addRoleOption((option) => option.setName("role").setDescription("Optional role to mention.").setRequired(false))
      .addChannelOption((option) => option.setName("channel").setDescription("Destination; defaults to this channel.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
    new SlashCommandBuilder().setName("bulk").setDescription("Prepare 2-10 moderation actions as one confirmed batch.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption((option) => option.setName("commands").setDescription("Separate actions with semicolons.").setRequired(true)),
    new SlashCommandBuilder().setName("prefix").setDescription("Set this server's additional Duck command prefix.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption((option) => option.setName("value").setDescription("1-5 visible characters, such as !! or ?").setMinLength(1).setMaxLength(5).setRequired(true)),
    new SlashCommandBuilder().setName("capibility").setDescription("Set how Duck approves and executes server actions.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption((option) => option
        .setName("mode")
        .setDescription("Choose Duck's server action policy.")
        .setRequired(true)
        .addChoices(
          { name: "Ask for approval", value: CAPABILITY_MODES.ask },
          { name: "Approve for me (Recommended)", value: CAPABILITY_MODES.approve },
          { name: "Agent mode", value: CAPABILITY_MODES.agent },
        )),
    new SlashCommandBuilder().setName("synccommands").setDescription("Immediately synchronize Duck's slash commands in this server.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  ];

  const body = [
      duckCommand,
      setupCommand,
      toolsCommand,
      entrySetupCommand,
      ...utilityCommands,
      ...moderationCommands,
      ...adminCommands,
    ].map((command) => command.toJSON());
  if (options.dryRun) return body;

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const guildIds = options.guildIds ?? [...client.guilds.cache.keys()];
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
  }
  if (options.syncGlobal !== false) {
    await rest.put(Routes.applicationCommands(client.user.id), { body });
  }
  logInfo("discord.commands-registered", {
    appId: client.user.id,
    count: body.length,
    guilds: guildIds.length,
    global: options.syncGlobal !== false,
    ms: elapsedMs(startedAt),
  });
  return {
    commandCount: body.length,
    guildCount: guildIds.length,
    globalSynced: options.syncGlobal !== false,
  };
}

export {
  cacheMaintenanceTimer,
  cacheRefreshTimer,
  cacheRefreshRunning,
  keepAliveServer,
  inviteCleanupTimer,
  normalizeText,
  parseDurationMs,
  parseSlowmodeSeconds,
  parseMessageCount,
  extractExactUserId,
  parseGrepResultCount,
  parseWarningClearCount,
  extractQuotedName,
  extractGrepQuery,
  extractNickname,
  extractReason,
  inferReasonFromRequest,
  extractChannelReason,
  findChannelByNameOrMention,
  findRoleByNameOrMention,
  findVoiceChannelByNameOrMention,
  findChannelByToolTarget,
  channelNameMatchesExactTarget,
  findExactChannelByToolTarget,
  findRoleByToolTarget,
  canManageRole,
  getVoiceQuarantine,
  clearVoiceQuarantine,
  scheduleVoiceQuarantineExpiry,
  restoreVoiceQuarantineTimers,
  handleVoiceQuarantineState,
  requesterActionBlockReason,
  summarizeMemberName,
  memberActionBlockReason,
  extractNewChannelName,
  extractPlainName,
  extractSpeakMessage,
  isLikelySpeakRequest,
  isDraftSpeakRequest,
  hasExplicitSpeakMessage,
  extractMessageTarget,
  extractMessageId,
  resolveMessageTargetForPlan,
  extractThreadName,
  ROLE_COLOR_NAMES,
  parseRoleColor,
  formatRoleColor,
  extractPollParts,
  extractRoleName,
  extractVoiceChannelName,
  getTextChannelTarget,
  summarizeChannel,
  normalizeMemberLookup,
  getMemberNames,
  textReferencesMember,
  findMemberByTextReference,
  findMentionedMemberForPlan,
  planLocalModerationTool,
  planModerationTool,
  isLikelyModerationRequest,
  planModerationToolFromText,
  cleanJsonResponse,
  getMentionContext,
  summarizeMember,
  summarizeChannelForContext,
  isImageLikeAttachment,
  summarizeAttachment,
  summarizeAttachments,
  summarizeMessageForContext,
  getReferencedMessageContext,
  channelIsPrivate,
  canIncludeChannelMessages,
  getChannelCacheKey,
  normalizeCachedMessages,
  rememberMessage,
  removeCachedMessage,
  removeCachedMessages,
  invalidateChannelMessageCache,
  getRecentChannelMessages,
  getResourceCacheTtlMs,
  cachedResourceFetch,
  cachedGuild,
  cachedBotMember,
  cachedMember,
  cachedChannel,
  cachedRole,
  getCacheSweepMs,
  runBoundedTasks,
  pruneMapToLimit,
  pruneRuntimeCaches,
  refreshRuntimeCaches,
  startCacheMaintenance,
  flushRuntimeStateAndExit,
  findHistoryChannelTarget,
  getContextPriorityChannels,
  getExplicitContextChannelIds,
  collectRecentMessages,
  measureContextChars,
  compactServerContext,
  buildCurrentMessageContext,
  collectServerContext,
  resolveMemberForPlan,
  makeValidatedBulkPlan,
  validateAiPlan,
  collectVisionAttachmentsFromContext,
  makeUserMessagesWithVision,
  isOpenRouterProvider,
  makePlannerMessages,
  makePlannerResponseFormat,
  planWithOpenAiCompatible,
  planWithOllama,
  planWithConfiguredAi,
  getConfiguredAiProvider,
  getOpenAiCompatibleConfig,
  hasConfiguredAi,
  makeChatMessages,
  chatWithOpenAiCompatible,
  chatWithOllama,
  extractAiTextContent,
  INLINE_TOOL_MAP,
  parseInlineToolCall,
  generateChatResponse,
  planModerationRequest,
  hasPermission,
  describePermissionRequirement,
  canApprove,
  commandLabel,
  makeConfirmationRows,
  makeAgentModeConfirmationRows,
  handleCapabilityCommand,
  handleCapabilityButton,
  formatWarningsForMember,
  makeActionEmbed,
  describeAction,
  makeActionAuditReason,
  promptForConfirmation,
  executeAction,
  shouldAutoExecuteAction,
  dispatchPlannedAction,
  resolveApprover,
  approveAction,
  sendApprovalResult,
  cancelAction,
  makeDuckHelp,
  isNegativeConfirmation,
  cancelLatestActionFromMessage,
  wantsRecentHistory,
  makeRecentHistoryResponse,
  discordTimestamp,
  formatBoolean,
  findUtilityMemberTarget,
  channelTypeName,
  formatMemberInfo,
  formatServerInfo,
  formatChannelInfo,
  formatRoleInfo,
  loadQuotes,
  saveQuotes,
  parseReminderDuration,
  formatRulesText,
  formatShipResult,
  parseSpinOptions,
  makeUtilityHelp,
  makeDiagnosticResponse,
  destroyVoiceSession,
  synthesizeVoiceAudio,
  playNextVoiceItem,
  markVoiceSessionReady,
  scheduleVoiceHandshakeCheck,
  createVoiceSession,
  waitForVoiceReady,
  notifyVoiceSessionError,
  joinVoiceForMessage,
  enqueueVoiceText,
  queueVoiceMessage,
  parseBulkCommands,
  buildBulkPlan,
  handleExplicitCommand,
  makeUtilityResponse,
  makeSlashCommandMessage,
  slashCommandContent,
  validateSlashCommandDispatchers,
  makeSlashDuckResponse,
  getResponsePresentation,
  makeCommandResponseEmbed,
  makeDuckChatEmbed,
  makeDuckChatPayload,
  sendMessageChunks,
  makeMessageWithContent,
  isReplyToDuck,
  getDuckInvocation,
  startKeepAliveServer,
  sendLogMessage,
  handleMemberJoin,
  handleMemberRemove,
  cleanupOldInvites,
  startInviteCleanupLoop,
  registerCommands,
};
