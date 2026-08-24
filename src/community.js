import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomBytes, randomInt } from "node:crypto";
import { getGuildSettings, updateGuildSettings } from "./config.js";
import { getPublicGuildSettings, hasPlusEntitlement } from "./dashboard-config.js";
import { getImageCaptcha, getImageCaptchaStatus, normalizeCaptchaAnswer } from "./captcha.js";

const activity = new Map();
const ticketLocks = new Set();
const ticketCloseLocks = new Set();
const ticketVerificationChallenges = new Map();
const TICKET_VERIFICATION_TTL_MS = 10 * 60_000;
const TICKET_VERIFICATION_LIMIT = 2_000;
const verificationWords = Object.freeze([
  ["Apple", "Amber", "Cedar", "Copper", "Maple", "Mango", "Orbit", "Puddle", "River", "Velvet"],
  ["Beacon", "Feather", "Garden", "Honeycomb", "Lantern", "Meadow", "Pebble", "Rocket", "Sunrise", "Willow"],
]);
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
function normalizeTicketVerificationAnswer(value) { return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"); }
function createTicketVerificationPhrase(random = randomInt) { const first = verificationWords[0][random(verificationWords[0].length)]; const second = verificationWords[1][random(verificationWords[1].length)]; const number = random(1, 1_000_000).toLocaleString("en-US"); return `${first} ${second} ${number}`; }
function isTicketVerificationType(type) { return type === "verification" || type === "image_verification"; }
function pruneTicketVerificationChallenges(now = Date.now()) { for (const [token, challenge] of ticketVerificationChallenges) if (challenge.expiresAt <= now) ticketVerificationChallenges.delete(token); while (ticketVerificationChallenges.size >= TICKET_VERIFICATION_LIMIT) ticketVerificationChallenges.delete(ticketVerificationChallenges.keys().next().value); }
function withSafeEmoji(button, value, fallback) { try { return button.setEmoji(value || fallback); } catch { return button.setEmoji(fallback); } }
function isSafeSelfAssignableRole(role) { return Boolean(role && !role.managed && role.editable && !role.permissions.any(SELF_ASSIGN_BLOCKED_PERMISSIONS)); }
function assertCanPublishTo(guild, channel) {
  const botMember = guild?.members?.me;
  if (!botMember) throw Object.assign(new Error("Duck is still connecting to this server. Try publishing again in a moment."), { status: 503 });
  const permissions = channel?.permissionsFor?.(botMember);
  const required = [
    [PermissionsBitField.Flags.ViewChannel, "View Channel"],
    [PermissionsBitField.Flags.SendMessages, "Send Messages"],
    [PermissionsBitField.Flags.EmbedLinks, "Embed Links"],
  ];
  const missing = required.filter(([permission]) => !permissions?.has(permission)).map(([, label]) => label);
  if (missing.length) throw Object.assign(new Error(`Duck needs ${missing.join(", ")} in #${channel?.name || "the selected channel"}.`), { status: 403 });
  return botMember;
}
function getActivity(guildId) {
  let current = activity.get(guildId);
  const today = new Date().toISOString().slice(0, 10);
  if (!current || current.day !== today) { current = { day: today, messages: 0, activeUsers: new Set(), aiFlags: 0, ticketsOpened: 0, actions: 0 }; activity.set(guildId, current); if (activity.size > 2_000) activity.delete(activity.keys().next().value); }
  return current;
}
function recordMessageActivity(message) { const current = getActivity(message.guildId); current.messages += 1; if (current.activeUsers.size < 10_000) current.activeUsers.add(message.author.id); }
function recordAiFlag(guildId) { getActivity(guildId).aiFlags += 1; }
function auditSourceLabel(source) { return ({ discord: "Discord command", dashboard: "Web dashboard", automod: "Duck AutoMod", "ai-review": "AI review suggestion" })[source] || "Discord"; }
function ticketClosePermissionOverwrites(channel, ownerId) {
  const overwrites = channel?.permissionOverwrites?.cache;
  if (!overwrites?.values) return [];
  return [...overwrites.values()]
    .filter((overwrite) => overwrite.id !== ownerId)
    .map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny }));
}

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
    const embed = new EmbedBuilder().setColor(0x16845c).setTitle("Duck activity log").setDescription(`**${entry.action}**`).addFields(
      { name: "Started by", value: entry.userId ? `<@${entry.userId}> (Discord ID \`${entry.userId}\`)` : "Duck automatically", inline: true },
      { name: "When", value: `<t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:F>`, inline: true },
      { name: "Why it happened", value: entry.reason },
      ...(entry.targetId ? [{ name: "Member affected", value: `<@${entry.targetId}> (Discord ID \`${entry.targetId}\`)` }] : []),
    ).setFooter({ text: `${auditSourceLabel(entry.source)} · Duck keeps this record for your staff team` });
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
  const settings = getPublicGuildSettings(getGuildSettings(guild.id));
  if (!settings.reactionRolesEnabled) throw Object.assign(new Error("Enable reaction roles first."), { status: 409 });
  const channel = guild.channels.cache.get(settings.reactionRoleChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") throw Object.assign(new Error("Choose a valid reaction-role channel."), { status: 400 });
  const botMember = assertCanPublishTo(guild, channel);
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw Object.assign(new Error("Duck needs Manage Roles to publish a working reaction-role panel."), { status: 403 });
  const options = settings.reactionRoleOptions;
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
  const settings = getPublicGuildSettings(getGuildSettings(guild.id));
  if (!settings.ticketsEnabled) throw Object.assign(new Error("Enable tickets first."), { status: 409 });
  const channel = guild.channels.cache.get(settings.ticketPanelChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") throw Object.assign(new Error("Choose a valid ticket panel channel."), { status: 400 });
  const botMember = assertCanPublishTo(guild, channel);
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw Object.assign(new Error("Duck needs Manage Channels to create tickets from this panel."), { status: 403 });
  const options = settings.ticketOptions;
  if (!options.length) throw Object.assign(new Error("Add at least one ticket option."), { status: 400 });
  if (options.some(({ type }) => isTicketVerificationType(type)) && !botMember.permissions.has(PermissionsBitField.Flags.KickMembers)) throw Object.assign(new Error("Duck needs Kick Members before publishing verification tickets."), { status: 403 });
  if (options.some(({ type }) => type === "image_verification")) {
    const captcha = getImageCaptchaStatus();
    if (!captcha.ready) throw Object.assign(new Error(`Image CAPTCHA is not installed on this Duck host. ${captcha.error || "Run npm run setup:captcha."}`), { status: 503 });
  }
  const rows = [];
  for (let index = 0; index < options.length; index += 5) rows.push(new ActionRowBuilder().addComponents(...options.slice(index, index + 5).map((option) => withSafeEmoji(new ButtonBuilder().setCustomId(`duck_ticket:${option.id}`).setLabel(option.label).setStyle(ButtonStyle.Primary), option.emoji, "🎫"))));
  const embed = new EmbedBuilder().setColor(0xf2c85b).setTitle(settings.ticketPanelTitle || "Duck Support").setDescription("Choose the kind of ticket you need. A private channel will be created for you and the support team.");
  const message = await channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
  await recordAuditEvent(guild, { userId: actorId, action: "Published ticket panel", reason: `Panel posted in #${channel.name}`, source: "dashboard" });
  return message;
}

async function handleReactionRole(interaction, roleId) {
  const raw = getGuildSettings(interaction.guildId);
  const settings = getPublicGuildSettings(raw);
  if (!settings.reactionRolesEnabled || !settings.reactionRoleOptions?.some((option) => option.roleId === roleId)) return interaction.reply({ content: "That reaction role is no longer configured.", ephemeral: true });
  const role = interaction.guild.roles.cache.get(roleId);
  const member = interaction.member;
  if (!isSafeSelfAssignableRole(role)) return interaction.reply({ content: "Duck cannot safely manage that role.", ephemeral: true });
  const removing = member.roles.cache.has(roleId);
  if (!removing) {
    const configuredIds = settings.reactionRoleOptions.map((option) => option.roleId);
    const selectedIds = configuredIds.filter((id) => member.roles.cache.has(id));
    if (settings.reactionRoleLimit > 0 && selectedIds.length >= settings.reactionRoleLimit) return interaction.reply({ content: `This panel allows up to ${settings.reactionRoleLimit} role${settings.reactionRoleLimit === 1 ? "" : "s"}. Remove one first.`, ephemeral: true });
    if (settings.reactionRoleMode === "exclusive" && selectedIds.length) await member.roles.remove(selectedIds, "Exclusive Duck reaction-role selection");
  }
  await (removing ? member.roles.remove(role, "Self-service reaction role") : member.roles.add(role, "Self-service reaction role"));
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: removing ? "Removed self role" : "Added self role", reason: role.name, source: "discord" });
  return interaction.reply({ content: `${removing ? "Removed" : "Added"} **${role.name}**.`, ephemeral: true });
}

async function promptTicketVerification(interaction, option) {
  pruneTicketVerificationChallenges();
  const token = randomBytes(12).toString("base64url");
  const phrase = createTicketVerificationPhrase();
  ticketVerificationChallenges.set(token, { guildId: interaction.guildId, userId: interaction.user.id, optionId: option.id, mode: "text", answer: normalizeTicketVerificationAnswer(phrase), expiresAt: Date.now() + TICKET_VERIFICATION_TTL_MS });
  const answer = new TextInputBuilder().setCustomId("duck_ticket_verify_answer").setLabel(`Type: ${phrase}`.slice(0, 45)).setPlaceholder(phrase).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
  const modal = new ModalBuilder().setCustomId(`duck_ticket_verify:${token}`).setTitle(clean(option.verificationLabel, 45) || "Human verification").addComponents(new ActionRowBuilder().addComponents(answer));
  return interaction.showModal(modal);
}

async function promptImageTicketVerification(interaction, option) {
  pruneTicketVerificationChallenges();
  let sample;
  try { sample = getImageCaptcha(); } catch (error) {
    return interaction.reply({ content: `Image verification is temporarily unavailable. A server administrator needs to install the CAPTCHA dataset. (${clean(error?.message, 140)})`, ephemeral: true });
  }
  const token = randomBytes(12).toString("base64url");
  ticketVerificationChallenges.set(token, { guildId: interaction.guildId, userId: interaction.user.id, optionId: option.id, mode: "image", answer: normalizeCaptchaAnswer(sample.answer), expiresAt: Date.now() + TICKET_VERIFICATION_TTL_MS });
  const filename = `duck-captcha${sample.extension}`;
  const file = new AttachmentBuilder(sample.buffer, { name: filename, description: "Duck image verification challenge" });
  const embed = new EmbedBuilder().setColor(0x16845c).setTitle(clean(option.verificationLabel, 80) || "Image verification").setDescription("Read the characters in the image, then press **Enter answer**. This one-time challenge expires in 10 minutes.").setImage(`attachment://${filename}`);
  const controls = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`duck_ticket_image_answer:${token}`).setLabel("Enter answer").setStyle(ButtonStyle.Primary));
  return interaction.reply({ embeds: [embed], components: [controls], files: [file], ephemeral: true });
}

async function promptImageTicketAnswer(interaction, token) {
  pruneTicketVerificationChallenges();
  const challenge = ticketVerificationChallenges.get(token);
  if (!challenge || challenge.mode !== "image" || challenge.guildId !== interaction.guildId || challenge.userId !== interaction.user.id) return interaction.reply({ content: "That image challenge expired or belongs to another member. Open a new verification ticket and try again.", ephemeral: true });
  const answer = new TextInputBuilder().setCustomId("duck_ticket_verify_answer").setLabel("Type the characters shown in the image").setPlaceholder("CAPTCHA answer").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(32);
  const modal = new ModalBuilder().setCustomId(`duck_ticket_verify:${token}`).setTitle("Image verification").addComponents(new ActionRowBuilder().addComponents(answer));
  return interaction.showModal(modal);
}

async function handleTicketOpen(interaction, optionId, verified = false) {
  const settings = getPublicGuildSettings(getGuildSettings(interaction.guildId));
  const option = settings.ticketOptions?.find((item) => item.id === optionId);
  if (!settings.ticketsEnabled || !option) return interaction.reply({ content: "That ticket option is no longer available.", ephemeral: true });
  const existing = interaction.guild.channels.cache.find((channel) => !channel.name.startsWith("closed-") && channel.topic?.match(/duck-ticket-owner:(\d{10,})/)?.[1] === interaction.user.id);
  if (existing) return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
  if (option.type === "verification" && !verified) return promptTicketVerification(interaction, option);
  if (option.type === "image_verification" && !verified) return promptImageTicketVerification(interaction, option);
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
    const ticketEmbed = new EmbedBuilder().setColor(0x16845c).setTitle(option.label).setDescription(option.description || "A support team member will be with you soon.");
    if (isTicketVerificationType(option.type)) ticketEmbed.addFields({ name: option.verificationLabel || "Verification", value: "Passed before this ticket was opened." });
    ticketEmbed.setFooter({ text: `Opened by ${interaction.user.tag}` }).setTimestamp();
    await channel.send({ content: `<@${interaction.user.id}>${settings.ticketSupportRoleId ? ` <@&${settings.ticketSupportRoleId}>` : ""}`, embeds: [ticketEmbed], components: [close], allowedMentions: { users: [interaction.user.id], roles: settings.ticketSupportRoleId ? [settings.ticketSupportRoleId] : [] } });
    if (isTicketVerificationType(option.type) && option.additionalMessage) await channel.send({ content: option.additionalMessage, allowedMentions: { parse: [] } });
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

async function handleTicketVerificationModal(interaction) {
  if (!interaction.customId.startsWith("duck_ticket_verify:")) return false;
  pruneTicketVerificationChallenges();
  const token = interaction.customId.slice("duck_ticket_verify:".length);
  const challenge = ticketVerificationChallenges.get(token);
  ticketVerificationChallenges.delete(token);
  if (!challenge || challenge.guildId !== interaction.guildId || challenge.userId !== interaction.user.id) return interaction.reply({ content: "That verification challenge expired or belongs to another member. Open a new verification ticket and try again.", ephemeral: true });
  const settings = getPublicGuildSettings(getGuildSettings(interaction.guildId));
  const expectedType = challenge.mode === "image" ? "image_verification" : "verification";
  const option = settings.ticketOptions?.find((item) => item.id === challenge.optionId && item.type === expectedType);
  if (!settings.ticketsEnabled || !option) return interaction.reply({ content: "That verification ticket is no longer available.", ephemeral: true });
  const rawAnswer = interaction.fields.getTextInputValue("duck_ticket_verify_answer");
  const submitted = challenge.mode === "image" ? normalizeCaptchaAnswer(rawAnswer) : normalizeTicketVerificationAnswer(rawAnswer);
  if (submitted !== challenge.answer) {
    const reason = `Failed Duck ticket verification for ${option.label}`;
    await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: "Failed ticket verification", reason: option.label, source: "discord" });
    if (!interaction.member?.kickable) return interaction.reply({ content: "Verification failed, but Duck cannot kick you because of Discord role hierarchy. Staff have been notified in the audit log.", ephemeral: true });
    await interaction.reply({ content: "Verification failed. You are being removed from this server.", ephemeral: true });
    try { await interaction.member.kick(reason); } catch { await interaction.editReply({ content: "Verification failed, but Discord prevented Duck from kicking you. Staff have been notified in the audit log." }).catch(() => null); }
    return true;
  }
  await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: "Passed ticket verification", reason: option.label, source: "discord" });
  return handleTicketOpen(interaction, option.id, true);
}

async function handleTicketClose(interaction) {
  const ownerId = interaction.channel?.topic?.match(/duck-ticket-owner:(\d{10,})/)?.[1];
  if (!ownerId) return interaction.reply({ content: "This is not a Duck ticket channel.", ephemeral: true });
  const raw = getGuildSettings(interaction.guildId);
  const settings = getPublicGuildSettings(raw);
  const staff = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels) || [settings.ticketSupportRoleId, settings.ticketAdminRoleId].some((id) => id && interaction.member.roles.cache.has(id));
  if (interaction.user.id !== ownerId && !staff) return interaction.reply({ content: "Only the ticket owner or support staff can close this ticket.", ephemeral: true });
  const lockKey = `${interaction.guildId}:${interaction.channelId}`;
  if (ticketCloseLocks.has(lockKey)) return interaction.reply({ content: "This ticket is already being closed.", ephemeral: true });
  ticketCloseLocks.add(lockKey);
  try {
    await interaction.deferReply();
    const reason = `Ticket closed by ${interaction.user.tag}`;
    const retainedOverwrites = ticketClosePermissionOverwrites(interaction.channel, ownerId);
    await interaction.channel.permissionOverwrites.set(retainedOverwrites, reason);
    await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 100), reason).catch(() => null);
    await interaction.channel.setTopic(`duck-ticket-closed:${ownerId};closed-by:${interaction.user.id}`).catch(() => null);
    if (settings.ticketTranscriptsEnabled && hasPlusEntitlement(raw)) {
      const logChannelId = raw.entryChannels?.logChannelId;
      const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;
      if (logChannel?.isTextBased?.() && typeof logChannel.send === "function") {
        const messages = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (messages) {
          const transcript = [...messages.values()].reverse().map((message) => `[${message.createdAt.toISOString()}] ${message.author.tag} (${message.author.id}): ${String(message.cleanContent || message.content || "").replace(/[\r\n]+/g, " ").slice(0, 1_500)}${message.attachments.size ? ` [${message.attachments.size} attachment(s)]` : ""}`).join("\n").slice(0, 240_000);
          const file = new AttachmentBuilder(Buffer.from(transcript || "No cached ticket messages were available.", "utf8"), { name: `ticket-${interaction.channel.id}.txt`, description: "Duck Plus ticket transcript" });
          await logChannel.send({ content: `Transcript for closed ticket <#${interaction.channel.id}>`, files: [file], allowedMentions: { parse: [] } }).catch(() => null);
        }
      }
    }
    await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: ownerId, action: "Closed ticket", reason: `#${interaction.channel.name}`, source: "discord" });
    return interaction.editReply({ content: "Ticket closed. Staff can review or delete this channel when ready." });
  } catch (error) {
    const detail = error?.code === 10009 ? "Discord had stale ticket permissions. Please try again; Duck has refreshed the safe close operation." : clean(error?.message, 160) || "Discord rejected the channel update.";
    const failure = { content: `Duck could not close this ticket: ${detail}` };
    if (interaction.deferred || interaction.replied) return interaction.editReply(failure).catch(() => null);
    return interaction.reply({ ...failure, ephemeral: true }).catch(() => null);
  } finally {
    ticketCloseLocks.delete(lockKey);
  }
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
  if (interaction.customId.startsWith("duck_ticket_image_answer:")) return promptImageTicketAnswer(interaction, interaction.customId.slice("duck_ticket_image_answer:".length));
  if (interaction.customId.startsWith("duck_ticket:")) return handleTicketOpen(interaction, interaction.customId.slice(12));
  if (interaction.customId.startsWith("duck_ai_action:")) return promptAiAction(interaction);
  return false;
}

export { assertCanPublishTo, createTicketVerificationPhrase, getGuildInsights, handleAiActionSelection, handleCommunityButton, handleTicketVerificationModal, isSafeSelfAssignableRole, normalizeTicketVerificationAnswer, publishReactionRolePanel, publishTicketPanel, recordAiFlag, recordAuditEvent, recordMessageActivity, ticketClosePermissionOverwrites };
