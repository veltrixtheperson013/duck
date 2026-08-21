import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } from "discord.js";
import { addMemberWarning, getGuildSettings, updateGuildSettings } from "./config.js";
import { getPublicGuildSettings } from "./dashboard-config.js";
import { recordAuditEvent } from "./community.js";

const SWEAR_WORDS = ["fuck", "shit", "bitch", "cunt", "nigger", "nigga", "faggot", "retard"];
const SEXUAL_TERMS = ["porn", "hentai", "nudes", "nude", "onlyfans", "sex tape", "rule34", "r34", "xxx"];
const DISCORD_INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
const violationCounts = new Map();
const messageCooldowns = new Map();
const actionCooldowns = new Map();
const honeypotProcessing = new Set();

function normalizedText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\u200b-\u200d\ufeff]/g, "");
}

function includesTerm(text, terms) {
  const haystack = ` ${normalizedText(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return terms.some((term) => haystack.includes(` ${normalizedText(term).replace(/[^\p{L}\p{N}]+/gu, " ")} `));
}

function pruneRuntimeMaps(now = Date.now()) {
  for (const map of [messageCooldowns, actionCooldowns]) {
    if (map.size < 10_000) continue;
    for (const [key, expiresAt] of map) if (expiresAt <= now) map.delete(key);
    while (map.size > 10_000) map.delete(map.keys().next().value);
  }
  for (const [key, entry] of violationCounts) if (entry.updatedAt + 24 * 60 * 60_000 <= now) violationCounts.delete(key);
  while (violationCounts.size > 10_000) violationCounts.delete(violationCounts.keys().next().value);
}

function templateText(template, message) {
  return String(template || "")
    .replaceAll("{user}", `<@${message.author.id}>`)
    .replaceAll("{username}", message.author.username)
    .replaceAll("{channel}", `<#${message.channelId}>`)
    .replaceAll("{server}", message.guild.name)
    .slice(0, 1_900);
}

function automodEmbed(message, title, description, color = 0xe4a11b) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: "Duck AutoMod", iconURL: message.client.user.displayAvatarURL() })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${message.guild.name} • server safety` })
    .setTimestamp();
}

async function sendTemporaryNotice(message, title, description, color) {
  const sent = await message.channel.send({ embeds: [automodEmbed(message, title, description, color)], allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), 8_000).unref?.();
}

function getChannelSlowmode(settings, channelId) {
  const override = Array.isArray(settings.automodChannelSlowmodes)
    ? settings.automodChannelSlowmodes.find((item) => item.channelId === channelId)
    : null;
  return override ? override.seconds : Number(settings.automodGlobalSlowmodeSeconds) || 0;
}

async function handleRateGuard(message, settings, now = Date.now()) {
  const seconds = getChannelSlowmode(settings, message.channelId);
  if (!settings.automodEnabled || seconds <= 0 || message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages)) return false;
  const key = `${message.guildId}:${message.channelId}:${message.author.id}`;
  const expiresAt = messageCooldowns.get(key) || 0;
  messageCooldowns.set(key, now + seconds * 1_000);
  if (expiresAt <= now) return false;
  await message.delete().catch(() => null);
  await sendTemporaryNotice(message, "Easy there, speed-duck", `<@${message.author.id}>, this channel has a ${seconds}-second message rate guard.`);
  return true;
}

function detectViolation(message, settings) {
  const attachmentNames = [...(message.attachments?.values?.() || [])].map((item) => item.name || "").join(" ");
  if (settings.automodSwearFilter && includesTerm(message.content, SWEAR_WORDS)) return "Blocked language";
  if (settings.automodNsfwFilter && includesTerm(`${message.content} ${attachmentNames}`, SEXUAL_TERMS)) return "Sexual or NSFW content";
  if (settings.automodInviteFilter && DISCORD_INVITE_PATTERN.test(message.content || "")) return "Discord invite link";
  const mentionLimit = Number(settings.automodMentionLimit) || 0;
  if (mentionLimit > 0 && (message.mentions?.users?.size || 0) > mentionLimit) return `Too many user mentions (limit ${mentionLimit})`;
  if (settings.automodCapsFilter) {
    const letters = String(message.content || "").match(/\p{L}/gu) || [];
    const uppercase = String(message.content || "").match(/\p{Lu}/gu) || [];
    if (letters.length >= 12 && uppercase.length / letters.length >= 0.8) return "Excessive capital letters";
  }
  if (Array.isArray(settings.automodCustomWords) && settings.automodCustomWords.length && includesTerm(message.content, settings.automodCustomWords)) return "Custom blocked phrase";
  return null;
}

async function escalateViolation(message, settings, reason) {
  const member = message.member;
  if (!member || member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
  const key = `${message.guildId}:${message.author.id}`;
  const violations = (violationCounts.get(key)?.count || 0) + 1;
  const violationThreshold = Math.max(1, Number(settings.automodViolationsBeforeWarn) || 3);
  if (violations < violationThreshold) {
    violationCounts.set(key, { count: violations, updatedAt: Date.now() });
    await sendTemporaryNotice(message, "Message removed", `<@${message.author.id}>: ${reason}. Violation ${violations}/${violationThreshold} before an automatic warning.`);
    return;
  }
  violationCounts.delete(key);
  const warning = { id: `${Date.now()}_automod`, createdAt: new Date().toISOString(), moderatorId: message.client.user.id, moderatorTag: message.client.user.tag, reason: `AutoMod: ${reason}` };
  const warningTotal = addMemberWarning(message.guildId, message.author.id, warning);
  await recordAuditEvent(message.guild, { userId: message.client.user.id, targetId: message.author.id, action: "AutoMod warning", reason, source: "automod" });
  await member.send(`You were automatically warned in ${message.guild.name}: ${reason}`).catch(() => null);
  const warningThreshold = Math.max(1, Number(settings.automodWarningsBeforeAction) || 3);
  if (warningTotal < warningThreshold) {
    await sendTemporaryNotice(message, "Automatic warning issued", `<@${message.author.id}> now has ${warningTotal}/${warningThreshold} warning${warningTotal === 1 ? "" : "s"} before escalation.`, 0xedb84f);
    return;
  }
  const auditReason = `Duck AutoMod: ${reason}; ${warningTotal} stored warnings`;
  if (settings.automodEscalation === "softban" && member.bannable) {
    await message.guild.members.ban(member.id, { deleteMessageSeconds: 86_400, reason: auditReason });
    await message.guild.members.unban(member.id, "Duck AutoMod softban completed");
    await recordAuditEvent(message.guild, { userId: message.client.user.id, targetId: member.id, action: "AutoMod softban", reason: auditReason, source: "automod" });
    return;
  }
  if (member.kickable) { await member.kick(auditReason); await recordAuditEvent(message.guild, { userId: message.client.user.id, targetId: member.id, action: "AutoMod kick", reason: auditReason, source: "automod" }); }
}

function customActionMatches(action, message) {
  if (!action.enabled) return false;
  if (action.channelId && action.channelId !== message.channelId) return false;
  if (action.userId && action.userId !== message.author.id) return false;
  const content = normalizedText(message.content);
  const trigger = normalizedText(action.triggerValue);
  if (action.triggerType === "message") return true;
  if (action.triggerType === "contains") return Boolean(trigger && content.includes(trigger));
  if (action.triggerType === "starts_with") return Boolean(trigger && content.startsWith(trigger));
  return false;
}

async function executeCustomAction(action, message) {
  const member = message.member;
  const reason = `Duck custom action: ${action.name}`;
  if (action.actionType === "reply") return message.reply({ content: templateText(action.response, message), allowedMentions: { repliedUser: false, users: [message.author.id] } });
  if (action.actionType === "react") return message.react(action.response || "🦆");
  if (action.actionType === "delete") return message.delete();
  if (!member || member.id === message.guild.ownerId) return null;
  if (action.actionType === "warn") {
    addMemberWarning(message.guildId, member.id, { id: `${Date.now()}_${action.id}`, createdAt: new Date().toISOString(), moderatorId: message.client.user.id, moderatorTag: message.client.user.tag, reason });
    await member.send(`You were warned in ${message.guild.name}: ${reason}`).catch(() => null);
    return null;
  }
  if (action.actionType === "timeout" && member.moderatable) return member.timeout(5 * 60_000, reason);
  if (action.actionType === "kick" && member.kickable) return member.kick(reason);
  if (action.actionType === "softban" && member.bannable) {
    await message.guild.members.ban(member.id, { deleteMessageSeconds: 86_400, reason });
    return message.guild.members.unban(member.id, "Duck custom-action softban completed");
  }
  return null;
}

async function handleCustomActions(message, settings, now = Date.now()) {
  const actions = Array.isArray(settings.customActions) ? settings.customActions : [];
  let executed = 0;
  for (const action of actions) {
    if (executed >= 3 || !customActionMatches(action, message)) continue;
    const key = `${message.guildId}:${action.id}:${message.author.id}`;
    if ((actionCooldowns.get(key) || 0) > now) continue;
    actionCooldowns.set(key, now + 5_000);
    await executeCustomAction(action, message).catch(() => null);
    executed += 1;
    if (["delete", "timeout", "kick", "softban"].includes(action.actionType)) return true;
  }
  return false;
}

async function handleHoneypot(message, settings, storedSettings = {}, persist = updateGuildSettings) {
  if (!settings.automodHoneypotEnabled || settings.automodHoneypotChannelId !== message.channelId) return false;
  const member = message.member;
  if (!member || member.permissions?.has(PermissionsBitField.Flags.BanMembers) || !member.bannable) return false;
  const key = `${message.guildId}:${member.id}`;
  if (honeypotProcessing.has(key)) return true;
  honeypotProcessing.add(key);
  try {
    const previous = Array.isArray(storedSettings.honeypotTriggeredUserIds) && storedSettings.honeypotTriggeredUserIds.includes(member.id);
    const reason = previous ? "Duck honeypot: repeated entry after softban" : "Duck honeypot: message in protected trap channel";
    if (previous) { await message.guild.members.ban(member.id, { deleteMessageSeconds: 604_800, reason }); await recordAuditEvent(message.guild, { userId: message.client?.user?.id, targetId: member.id, action: "Honeypot permanent ban", reason, source: "automod" }); return true; }
    const invite = await message.channel.createInvite({ maxAge: 86_400, maxUses: 1, unique: true, reason: "Duck honeypot one-time return invitation" }).catch(() => null);
    const triggered = [...new Set([...(Array.isArray(storedSettings.honeypotTriggeredUserIds) ? storedSettings.honeypotTriggeredUserIds : []), member.id])].slice(-1_000);
    persist(message.guildId, { honeypotTriggeredUserIds: triggered });
    await message.guild.members.ban(member.id, { deleteMessageSeconds: 604_800, reason });
    await message.guild.members.unban(member.id, "Duck honeypot first trigger: one return allowed");
    await recordAuditEvent(message.guild, { userId: message.client?.user?.id, targetId: member.id, action: "Honeypot softban", reason, source: "automod" });
    if (invite?.url) await message.author.send({ content: `You triggered the honeypot in **${message.guild.name}**. You may return once; speaking in that channel again will permanently ban you.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Return to server").setURL(invite.url))] }).catch(() => null);
    return true;
  } finally { honeypotProcessing.delete(key); }
}

async function handleAutomodAndCustomActions(message) {
  const storedSettings = getGuildSettings(message.guildId);
  const settings = getPublicGuildSettings(storedSettings);
  pruneRuntimeMaps();
  if (await handleHoneypot(message, settings, storedSettings)) return true;
  if (await handleRateGuard(message, settings)) return true;
  if (settings.automodEnabled) {
    const violation = detectViolation(message, settings);
    if (violation) {
      await message.delete().catch(() => null);
      await escalateViolation(message, settings, violation);
      return true;
    }
  }
  return handleCustomActions(message, settings);
}

export { customActionMatches, detectViolation, handleAutomodAndCustomActions, handleHoneypot, includesTerm };
