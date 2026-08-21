import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } from "discord.js";
import { getGuildSettings, updateGuildSettings } from "./config.js";
import { getPublicGuildSettings, hasPlusEntitlement } from "./dashboard-config.js";
import { isSafeSelfAssignableRole, recordAuditEvent } from "./community.js";

const xpCooldowns = new Map();
const dirtyLevelGuilds = new Set();
const scheduledPostRuns = new Map();
let communityTimer = null;

function clean(value, max = 1_000) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function levelForXp(xp) { return Math.max(0, Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 100))); }
function xpForLevel(level) { return Math.max(0, Math.trunc(Number(level) || 0)) ** 2 * 100; }
function reactionKey(reaction) { return reaction?.emoji?.id ? reaction.emoji.toString() : reaction?.emoji?.name || ""; }
function safeProfiles(settings) {
  if (!settings.levelProfiles || typeof settings.levelProfiles !== "object" || Array.isArray(settings.levelProfiles)) settings.levelProfiles = {};
  return settings.levelProfiles;
}

async function applyAutoroles(member) {
  if (!member?.guild || member.user?.bot) return;
  const settings = getPublicGuildSettings(getGuildSettings(member.guild.id));
  if (!settings.autorolesEnabled) return;
  let applied = 0;
  for (const roleId of settings.autoroleRoleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (!isSafeSelfAssignableRole(role) || member.roles.cache.has(roleId)) continue;
    if (await member.roles.add(role, "Duck automatic join role").then(() => true).catch(() => false)) applied += 1;
  }
  if (applied) await recordAuditEvent(member.guild, { targetId: member.id, action: "Applied automatic roles", reason: `${applied} safe join role(s)`, source: "discord" });
}

async function awardMessageXp(message, now = Date.now()) {
  if (!message?.guildId || message.author?.bot) return null;
  const raw = getGuildSettings(message.guildId);
  const settings = getPublicGuildSettings(raw);
  if (!settings.levelsEnabled || settings.levelIgnoredChannelIds.includes(message.channelId)) return null;
  const cooldownKey = `${message.guildId}:${message.author.id}`;
  if ((xpCooldowns.get(cooldownKey) || 0) > now - 60_000) return null;
  xpCooldowns.set(cooldownKey, now);
  if (xpCooldowns.size > 50_000) for (const [key, usedAt] of xpCooldowns) if (usedAt < now - 120_000) xpCooldowns.delete(key);
  const profiles = safeProfiles(raw);
  if (!profiles[message.author.id] && Object.keys(profiles).length >= 5_000) return null;
  const current = profiles[message.author.id] && typeof profiles[message.author.id] === "object" ? profiles[message.author.id] : { xp: 0, messages: 0 };
  const oldLevel = levelForXp(current.xp);
  let variation = 0;
  try { variation = Number(BigInt(message.id) % 11n); } catch { variation = [...String(message.id || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 11; }
  const gained = 15 + variation;
  const next = { xp: Math.min(100_000_000, Math.max(0, Number(current.xp) || 0) + gained), messages: Math.min(10_000_000, Math.max(0, Number(current.messages) || 0) + 1), updatedAt: new Date(now).toISOString() };
  profiles[message.author.id] = next;
  dirtyLevelGuilds.add(message.guildId);
  const newLevel = levelForXp(next.xp);
  if (newLevel <= oldLevel) return next;
  if (hasPlusEntitlement(raw) && message.member?.roles?.cache) {
    for (const reward of settings.levelRewards.filter((item) => item.level <= newLevel)) {
      const role = message.guild.roles.cache.get(reward.roleId);
      if (isSafeSelfAssignableRole(role) && !message.member.roles.cache.has(role.id)) await message.member.roles.add(role, `Duck level ${reward.level} reward`).catch(() => null);
    }
  }
  const channel = settings.levelAnnouncementChannelId ? message.guild.channels.cache.get(settings.levelAnnouncementChannelId) : message.channel;
  if (channel?.isTextBased?.() && typeof channel.send === "function") await channel.send({ content: `🪷 <@${message.author.id}> reached **Pond Level ${newLevel}**!`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  return next;
}

function flushLevelProfiles() {
  for (const guildId of dirtyLevelGuilds) {
    const settings = getGuildSettings(guildId);
    updateGuildSettings(guildId, { levelProfiles: safeProfiles(settings) });
  }
  dirtyLevelGuilds.clear();
}

async function handleRankCommand(interaction) {
  const settings = getPublicGuildSettings(getGuildSettings(interaction.guildId));
  if (!settings.levelsEnabled) return interaction.reply({ content: "Levels are disabled in this server.", ephemeral: true });
  const target = interaction.options.getUser("member", false) || interaction.user;
  const profile = getGuildSettings(interaction.guildId).levelProfiles?.[target.id] || { xp: 0, messages: 0 };
  const level = levelForXp(profile.xp); const floor = xpForLevel(level); const ceiling = xpForLevel(level + 1);
  const progress = Math.max(0, Math.min(10, Math.round(((profile.xp - floor) / Math.max(1, ceiling - floor)) * 10)));
  const bar = `${"▰".repeat(progress)}${"▱".repeat(10 - progress)}`;
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x16845c).setAuthor({ name: target.globalName || target.username, iconURL: target.displayAvatarURL() }).setTitle(`Pond Level ${level}`).setDescription(`${bar}\n**${profile.xp || 0} XP** · ${profile.messages || 0} rewarded messages\n${Math.max(0, ceiling - (profile.xp || 0))} XP until level ${level + 1}`)], ephemeral: true });
}

async function handleLeaderboardCommand(interaction) {
  const settings = getPublicGuildSettings(getGuildSettings(interaction.guildId));
  if (!settings.levelsEnabled) return interaction.reply({ content: "Levels are disabled in this server.", ephemeral: true });
  const profiles = getGuildSettings(interaction.guildId).levelProfiles || {};
  const leaders = Object.entries(profiles).filter(([id, profile]) => /^\d{10,}$/.test(id) && profile && Number.isFinite(Number(profile.xp))).sort((a, b) => Number(b[1].xp) - Number(a[1].xp)).slice(0, 10);
  const lines = leaders.map(([id, profile], index) => `**${index + 1}.** <@${id}> — Level ${levelForXp(profile.xp)} · ${profile.xp} XP`);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf2c85b).setTitle("🏆 Pond leaderboard").setDescription(lines.join("\n") || "No one has earned XP yet.").setFooter({ text: "XP is awarded at most once per minute per member." })], allowedMentions: { parse: [] } });
}

async function handleSuggestCommand(interaction) {
  const raw = getGuildSettings(interaction.guildId); const settings = getPublicGuildSettings(raw);
  if (!settings.suggestionsEnabled || !settings.suggestionChannelId) return interaction.reply({ content: "Suggestions are not configured in this server.", ephemeral: true });
  const channel = interaction.guild.channels.cache.get(settings.suggestionChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") return interaction.reply({ content: "The suggestion channel is unavailable.", ephemeral: true });
  const text = clean(interaction.options.getString("idea", true), 1_000);
  if (!text) return interaction.reply({ content: "Write a suggestion first.", ephemeral: true });
  const requestedAnonymous = interaction.options.getBoolean("anonymous", false) === true;
  if (requestedAnonymous && (!settings.suggestionAnonymousEnabled || !hasPlusEntitlement(raw))) return interaction.reply({ content: "Anonymous proposals are not enabled for this server's plan.", ephemeral: true });
  const anonymous = requestedAnonymous;
  const embed = new EmbedBuilder().setColor(0x4d8c70).setTitle("New pond proposal").setDescription(text).setAuthor(anonymous ? { name: "Anonymous community member" } : { name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() }).setFooter({ text: `Submitted ${anonymous ? "anonymously" : `by ${interaction.user.id}`} · Awaiting staff review` }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duck_suggest:approve:${interaction.user.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`duck_suggest:decline:${interaction.user.id}`).setLabel("Decline").setEmoji("✖️").setStyle(ButtonStyle.Danger),
  );
  const sent = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  await Promise.allSettled([sent.react("👍"), sent.react("👎")]);
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, action: "Submitted suggestion", reason: `Suggestion ${sent.id} in #${channel.name}`, source: "discord" });
  return interaction.reply({ content: `Your suggestion is swimming over to ${channel}.`, ephemeral: true });
}

async function handleSuggestionDecision(interaction) {
  const match = interaction.customId.match(/^duck_suggest:(approve|decline):(\d{10,})$/);
  if (!match) return false;
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages)) return interaction.reply({ content: "You need Manage Messages to decide suggestions.", ephemeral: true });
  const approved = match[1] === "approve"; const original = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(original).setColor(approved ? 0x2fac72 : 0xc95b51).setTitle(approved ? "Approved pond proposal" : "Declined pond proposal").setFooter({ text: `${approved ? "Approved" : "Declined"} by ${interaction.user.tag}` });
  await interaction.update({ embeds: [embed], components: [] });
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: match[2], action: approved ? "Approved suggestion" : "Declined suggestion", reason: `Suggestion ${interaction.message.id}`, source: "discord" });
  return true;
}

async function handleStarboardReaction(reaction, user) {
  if (user?.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const message = reaction.message?.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  if (!message?.guildId || message.author?.bot) return;
  const raw = getGuildSettings(message.guildId); const settings = getPublicGuildSettings(raw);
  if (!settings.starboardEnabled || !settings.starboardChannelId || reactionKey(reaction) !== settings.starboardEmoji || message.channelId === settings.starboardChannelId) return;
  if (message.channel?.nsfw && !settings.starboardAllowNsfw) return;
  const destination = message.guild.channels.cache.get(settings.starboardChannelId);
  if (!destination?.isTextBased?.() || typeof destination.send !== "function") return;
  const mappings = Array.isArray(raw.starboardPosts) ? raw.starboardPosts.filter((item) => item && /^\d{10,}$/.test(item.sourceId || "") && /^\d{10,}$/.test(item.boardId || "")).slice(-500) : [];
  const existing = mappings.find((item) => item.sourceId === message.id);
  if ((reaction.count || 0) < settings.starboardThreshold) {
    if (!existing) return;
    const boardMessage = await destination.messages.fetch(existing.boardId).catch(() => null); await boardMessage?.delete().catch(() => null);
    updateGuildSettings(message.guildId, { starboardPosts: mappings.filter((item) => item.sourceId !== message.id) });
    return;
  }
  const excerpt = clean(message.content, 1_500) || "*(attachment or embed)*";
  const embed = new EmbedBuilder().setColor(settings.starboardColor).setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() }).setDescription(`${excerpt}\n\n[Jump to the original message](${message.url})`).addFields({ name: "Channel", value: `<#${message.channelId}>`, inline: true }).setTimestamp(message.createdAt);
  const image = message.attachments.find((attachment) => attachment.contentType?.startsWith("image/")); if (image?.url) embed.setImage(image.url);
  const payload = { content: `${settings.starboardEmoji} **${reaction.count}** · <#${message.channelId}>`, embeds: [embed], allowedMentions: { parse: [] } };
  if (existing) { const boardMessage = await destination.messages.fetch(existing.boardId).catch(() => null); if (boardMessage) return boardMessage.edit(payload); }
  const boardMessage = await destination.send(payload);
  updateGuildSettings(message.guildId, { starboardPosts: [...mappings.filter((item) => item.sourceId !== message.id), { sourceId: message.id, channelId: message.channelId, boardId: boardMessage.id }].slice(-500) });
}

async function runScheduledPosts(client, now = Date.now()) {
  for (const guild of client.guilds.cache.values()) {
    const raw = getGuildSettings(guild.id); if (!hasPlusEntitlement(raw)) continue;
    const settings = getPublicGuildSettings(raw);
    for (const post of settings.scheduledPosts.filter((item) => item.enabled)) {
      const key = `${guild.id}:${post.id}`; const last = scheduledPostRuns.get(key);
      if (last == null) { scheduledPostRuns.set(key, now); continue; }
      if (last > now - post.intervalMinutes * 60_000) continue;
      scheduledPostRuns.set(key, now);
      const channel = guild.channels.cache.get(post.channelId);
      if (!channel?.isTextBased?.() || typeof channel.send !== "function") continue;
      await channel.send({ content: post.message, allowedMentions: { parse: [] } }).catch(() => null);
      await recordAuditEvent(guild, { action: "Sent scheduled pond post", reason: `${post.name} in #${channel.name}`, source: "discord" });
    }
  }
  if (scheduledPostRuns.size > 5_000) scheduledPostRuns.clear();
}

function startCommunityStudio(client) {
  if (communityTimer) return;
  communityTimer = setInterval(() => { flushLevelProfiles(); runScheduledPosts(client).catch(() => null); }, 30_000);
  communityTimer.unref?.();
}

async function handleCommunitySlashCommand(interaction) {
  if (interaction.commandName === "suggest") return handleSuggestCommand(interaction);
  if (interaction.commandName === "rank") return handleRankCommand(interaction);
  if (interaction.commandName === "leaderboard") return handleLeaderboardCommand(interaction);
  return false;
}

export { applyAutoroles, awardMessageXp, flushLevelProfiles, handleStarboardReaction as handleCommunityReaction, handleCommunitySlashCommand, handleSuggestionDecision, levelForXp, runScheduledPosts, startCommunityStudio };
