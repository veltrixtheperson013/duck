import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
} from "discord.js";
import { getGuildSettings, updateGuildSettings } from "./config.js";

const activity = new Map();
const ticketLocks = new Set();
const SELF_ASSIGN_BLOCKED_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageEvents,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageGuildExpressions,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.ManageNicknames,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageThreads,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.MentionEveryone,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.MuteMembers,
  PermissionsBitField.Flags.DeafenMembers,
  PermissionsBitField.Flags.ViewAuditLog,
];

function clean(value, max = 240) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function withSafeEmoji(button, value, fallback) { try { return button.setEmoji(value || fallback); } catch { return button.setEmoji(fallback); } }
function isSafeSelfAssignableRole(role) { return Boolean(role && !role.managed && role.editable && !role.permissions.any(SELF_ASSIGN_BLOCKED_PERMISSIONS)); }
function getActivity(guildId) {
  let current = activity.get(guildId);
  const today = new Date().toISOString().slice(0, 10);
  if (!current || current.day !== today) { current = { day: today, messages: 0, activeUsers: new Set(), aiFlags: 0, ticketsOpened: 0, actions: 0 }; activity.set(guildId, current); if (activity.size > 2_000) activity.delete(activity.keys().next().value); }
  return current;
}
function recordMessageActivity(message) { const current = getActivity(message.guildId); current.messages += 1; if (current.activeUsers.size < 10_000) current.activeUsers.add(message.author.id); }
function recordAiFlag(guildId) { getActivity(guildId).aiFlags += 1; }

async function recordAuditEvent(guild, event) {
  if (!guild?.id) return null;
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: /^\d{10,}$/.test(String(event.userId || "")) ? String(event.userId) : null,
    targetId: /^\d{10,}$/.test(String(event.targetId || "")) ? String(event.targetId) : null,
    action: clean(event.action, 80) || "Unknown action",
    reason: clean(event.reason, 240) || "No reason provided",
    source: ["discord", "dashboard", "automod", "ai-review"].includes(event.source) ? event.source : "discord",
    createdAt: new Date().toISOString(),
  };
  const settings = getGuildSettings(guild.id);
  const auditLog = [entry, ...(Array.isArray(settings.auditLog) ? settings.auditLog : [])].slice(0, 250);
  updateGuildSettings(guild.id, { auditLog });
  getActivity(guild.id).actions += 1;
  const logChannelId = settings.entryChannels?.logChannelId;
  const channel = logChannelId ? guild.channels.cache.get(logChannelId) : null;
  if (channel?.isTextBased?.() && typeof channel.send === "function") {
    const embed = new EmbedBuilder().setColor(0x16845c).setTitle(entry.action).addFields(
      { name: "User", value: entry.userId ? `<@${entry.userId}> (\`${entry.userId}\`)` : "Duck system", inline: true },
      { name: "Time", value: `<t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:F>`, inline: true },
      { name: "Reason", value: entry.reason },
      ...(entry.targetId ? [{ name: "Target", value: `<@${entry.targetId}> (\`${entry.targetId}\`)` }] : []),
    ).setFooter({ text: `${entry.source} · Duck audit log` });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  }
  return entry;
}

function getGuildInsights(guild) {
  if (!guild?.id) return { day: new Date().toISOString().slice(0, 10), messagesToday: 0, activeUsersToday: 0, aiFlagsToday: 0, ticketsOpenedToday: 0, actionsToday: 0, members: Number(guild?.memberCount) || 0, channels: guild?.channels?.cache?.size || 0, roles: 0, auditLog: [] };
  const current = getActivity(guild.id);
  const settings = getGuildSettings(guild.id);
  return {
    day: current.day,
    messagesToday: current.messages,
    activeUsersToday: current.activeUsers.size,
    aiFlagsToday: current.aiFlags,
    ticketsOpenedToday: current.ticketsOpened,
    actionsToday: current.actions,
    members: guild.memberCount || 0,
    channels: guild.channels?.cache?.size || 0,
    roles: Math.max(0, (guild.roles?.cache?.size || 0) - 1),
    auditLog: (Array.isArray(settings.auditLog) ? settings.auditLog : []).slice(0, 100),
  };
}

async function publishReactionRolePanel(guild, actorId) {
  const settings = getGuildSettings(guild.id);
  if (!settings.reactionRolesEnabled) throw Object.assign(new Error("Enable reaction roles first."), { status: 409 });
  const channel = guild.channels.cache.get(settings.reactionRoleChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") throw Object.assign(new Error("Choose a valid reaction-role channel."), { status: 400 });
  const options = Array.isArray(settings.reactionRoleOptions) ? settings.reactionRoleOptions.slice(0, 10) : [];
  if (!options.length) throw Object.assign(new Error("Add at least one reaction role."), { status: 400 });
  const rows = [];
  for (let index = 0; index < options.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(...options.slice(index, index + 5).map((option) => withSafeEmoji(new ButtonBuilder().setCustomId(`duck_rr:${option.roleId}`).setLabel(option.label).setStyle(ButtonStyle.Secondary), option.emoji, "🦆"))));
  }
  const embed = new EmbedBuilder().setColor(0x16845c).setTitle(settings.reactionRoleTitle || "Choose your roles").setDescription("Use the buttons below to add or remove your own roles.");
  const message = await channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
  await recordAuditEvent(guild, { userId: actorId, action: "Published reaction-role panel", reason: `Panel posted in #${channel.name}`, source: "dashboard" });
  return message;
}

async function publishTicketPanel(guild, actorId) {
  const settings = getGuildSettings(guild.id);
  if (!settings.ticketsEnabled) throw Object.assign(new Error("Enable tickets first."), { status: 409 });
  const channel = guild.channels.cache.get(settings.ticketPanelChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") throw Object.assign(new Error("Choose a valid ticket panel channel."), { status: 400 });
  const options = Array.isArray(settings.ticketOptions) ? settings.ticketOptions.slice(0, 5) : [];
  if (!options.length) throw Object.assign(new Error("Add at least one ticket option."), { status: 400 });
  const row = new ActionRowBuilder().addComponents(...options.map((option) => withSafeEmoji(new ButtonBuilder().setCustomId(`duck_ticket:${option.id}`).setLabel(option.label).setStyle(ButtonStyle.Primary), option.emoji, "🎫")));
  const embed = new EmbedBuilder().setColor(0xf2c85b).setTitle(settings.ticketPanelTitle || "Duck Support").setDescription("Choose the kind of ticket you need. A private channel will be created for you and the support team.");
  const message = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  await recordAuditEvent(guild, { userId: actorId, action: "Published ticket panel", reason: `Panel posted in #${channel.name}`, source: "dashboard" });
  return message;
}

async function handleReactionRole(interaction, roleId) {
  const settings = getGuildSettings(interaction.guildId);
  if (!settings.reactionRolesEnabled || !settings.reactionRoleOptions?.some((option) => option.roleId === roleId)) return interaction.reply({ content: "That reaction role is no longer configured.", ephemeral: true });
  const role = interaction.guild.roles.cache.get(roleId);
  const member = interaction.member;
  if (!isSafeSelfAssignableRole(role)) return interaction.reply({ content: "Duck cannot safely manage that role.", ephemeral: true });
  const removing = member.roles.cache.has(roleId);
  await (removing ? member.roles.remove(role, "Self-service reaction role") : member.roles.add(role, "Self-service reaction role"));
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: removing ? "Removed self role" : "Added self role", reason: role.name, source: "discord" });
  return interaction.reply({ content: `${removing ? "Removed" : "Added"} **${role.name}**.`, ephemeral: true });
}

async function handleTicketOpen(interaction, optionId) {
  const settings = getGuildSettings(interaction.guildId);
  const option = settings.ticketOptions?.find((item) => item.id === optionId);
  if (!settings.ticketsEnabled || !option) return interaction.reply({ content: "That ticket option is no longer available.", ephemeral: true });
  const existing = interaction.guild.channels.cache.find((channel) => !channel.name.startsWith("closed-") && channel.topic?.match(/duck-ticket-owner:(\d{10,})/)?.[1] === interaction.user.id);
  if (existing) return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
  const lockKey = `${interaction.guildId}:${interaction.user.id}`;
  if (ticketLocks.has(lockKey)) return interaction.reply({ content: "Your ticket is already being created.", ephemeral: true });
  ticketLocks.add(lockKey);
  try {
    await interaction.deferReply({ ephemeral: true });
    const overwrites = [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
      { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
    ];
    for (const roleId of [settings.ticketSupportRoleId, settings.ticketAdminRoleId].filter(Boolean)) overwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] });
    const safeName = `${option.label}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `ticket-${interaction.user.id}`;
    const channel = await interaction.guild.channels.create({ name: safeName, type: ChannelType.GuildText, parent: settings.ticketCategoryId || null, topic: `duck-ticket-owner:${interaction.user.id};type:${option.id}`, permissionOverwrites: overwrites, reason: `Ticket opened by ${interaction.user.tag}` });
    const close = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("duck_ticket_close").setLabel("Close ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger));
    await channel.send({ content: `<@${interaction.user.id}>${settings.ticketSupportRoleId ? ` <@&${settings.ticketSupportRoleId}>` : ""}`, embeds: [new EmbedBuilder().setColor(0x16845c).setTitle(option.label).setDescription(option.description || "A support team member will be with you soon.").setFooter({ text: `Opened by ${interaction.user.tag}` }).setTimestamp()], components: [close], allowedMentions: { users: [interaction.user.id], roles: settings.ticketSupportRoleId ? [settings.ticketSupportRoleId] : [] } });
    getActivity(interaction.guildId).ticketsOpened += 1;
    await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: "Opened ticket", reason: option.label, source: "discord" });
    return interaction.editReply({ content: `Your ticket is ready: ${channel}` });
  } catch (error) {
    const failure = { content: `Duck could not create this ticket: ${clean(error?.message, 180) || "Discord rejected the channel setup."}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(failure).catch(() => null);
    else await interaction.reply(failure).catch(() => null);
    return null;
  } finally { ticketLocks.delete(lockKey); }
}

async function handleTicketClose(interaction) {
  const ownerId = interaction.channel?.topic?.match(/duck-ticket-owner:(\d{10,})/)?.[1];
  if (!ownerId) return interaction.reply({ content: "This is not a Duck ticket channel.", ephemeral: true });
  const settings = getGuildSettings(interaction.guildId);
  const staff = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels) || [settings.ticketSupportRoleId, settings.ticketAdminRoleId].some((id) => id && interaction.member.roles.cache.has(id));
  if (interaction.user.id !== ownerId && !staff) return interaction.reply({ content: "Only the ticket owner or support staff can close this ticket.", ephemeral: true });
  await interaction.deferReply();
  await interaction.channel.permissionOverwrites.edit(ownerId, { ViewChannel: false, SendMessages: false }, { reason: `Ticket closed by ${interaction.user.tag}` });
  await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 100), `Ticket closed by ${interaction.user.tag}`).catch(() => null);
  await interaction.channel.setTopic(`duck-ticket-closed:${ownerId};closed-by:${interaction.user.id}`).catch(() => null);
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: ownerId, action: "Closed ticket", reason: `#${interaction.channel.name}`, source: "discord" });
  return interaction.editReply({ content: "Ticket closed. Staff can review or delete this channel when ready." });
}

function aiActionParts(customId) { const match = customId.match(/^duck_ai_(?:action|pick):(\d{10,}):(\d{10,}):(\d{10,})$/); return match ? { channelId: match[1], messageId: match[2], userId: match[3] } : null; }
async function promptAiAction(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages)) return interaction.reply({ content: "You need Manage Messages to review this flag.", ephemeral: true });
  const target = aiActionParts(interaction.customId); if (!target) return interaction.reply({ content: "That review card is invalid.", ephemeral: true });
  const menu = new StringSelectMenuBuilder().setCustomId(`duck_ai_pick:${target.channelId}:${target.messageId}:${target.userId}`).setPlaceholder("Choose a reviewed action").addOptions(
    { label: "Delete message", value: "delete", description: "Remove only the flagged message", emoji: "🗑️" },
    { label: "Kick member", value: "kick", description: "Remove the member without banning", emoji: "👢" },
    { label: "Softban (24h cleanup)", value: "softban", description: "Ban, clear 24 hours, then immediately unban", emoji: "🧹" },
    { label: "Ban member", value: "ban", description: "Permanently ban and clear 24 hours", emoji: "⛔" },
  );
  return interaction.reply({ content: "Review the original message, then choose an action. Duck re-checks permissions and hierarchy when you submit.", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
}

async function handleAiActionSelection(interaction) {
  const target = aiActionParts(interaction.customId); const action = interaction.values?.[0];
  if (!target || !["delete", "kick", "softban", "ban"].includes(action)) return interaction.reply({ content: "That review action is invalid.", ephemeral: true });
  const permission = action === "delete" ? PermissionsBitField.Flags.ManageMessages : action === "kick" ? PermissionsBitField.Flags.KickMembers : PermissionsBitField.Flags.BanMembers;
  if (!interaction.memberPermissions?.has(permission)) return interaction.reply({ content: "You do not have the required Discord permission for that action.", ephemeral: true });
  await interaction.deferUpdate();
  const channel = interaction.guild.channels.cache.get(target.channelId) ?? await interaction.guild.channels.fetch(target.channelId).catch(() => null);
  const message = channel?.messages ? await channel.messages.fetch(target.messageId).catch(() => null) : null;
  const member = await interaction.guild.members.fetch(target.userId).catch(() => null);
  const reason = `AI flag reviewed by ${interaction.user.tag}; moderator selected ${action}`;
  if (message && message.author.id !== target.userId) return interaction.editReply({ content: "The flagged message no longer matches the reviewed user.", components: [] });
  if (action === "delete") { if (!message) return interaction.editReply({ content: "The flagged message no longer exists.", components: [] }); await message.delete(); }
  else {
    if (!member || member.id === interaction.guild.ownerId || member.id === interaction.user.id || member.user.bot) return interaction.editReply({ content: "That member cannot be moderated from this review card.", components: [] });
    const reviewerIsOwner = interaction.user.id === interaction.guild.ownerId;
    if (!reviewerIsOwner && interaction.member.roles.highest.comparePositionTo(member.roles.highest) <= 0) return interaction.editReply({ content: "You cannot moderate a member with an equal or higher role.", components: [] });
    if (action === "kick") { if (!member.kickable) return interaction.editReply({ content: "Duck cannot kick that member due to role hierarchy.", components: [] }); await member.kick(reason); }
    else { if (!member.bannable) return interaction.editReply({ content: "Duck cannot ban that member due to role hierarchy.", components: [] }); await interaction.guild.members.ban(member.id, { deleteMessageSeconds: 86_400, reason }); if (action === "softban") await interaction.guild.members.unban(member.id, "AI review softban completed"); }
  }
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: target.userId, action: `AI review: ${action}`, reason, source: "ai-review" });
  return interaction.editReply({ content: `Completed **${action}** after your explicit review.`, components: [] });
}

async function handleCommunityButton(interaction) {
  if (interaction.customId.startsWith("duck_rr:")) return handleReactionRole(interaction, interaction.customId.slice(8));
  if (interaction.customId === "duck_ticket_close") return handleTicketClose(interaction);
  if (interaction.customId.startsWith("duck_ticket:")) return handleTicketOpen(interaction, interaction.customId.slice(12));
  if (interaction.customId.startsWith("duck_ai_action:")) return promptAiAction(interaction);
  return false;
}

export { getGuildInsights, handleAiActionSelection, handleCommunityButton, isSafeSelfAssignableRole, publishReactionRolePanel, publishTicketPanel, recordAiFlag, recordAuditEvent, recordMessageActivity };
