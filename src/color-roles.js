import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { getGuildSettings, updateGuildSettings } from "./config.js";
import { getPublicGuildSettings, hasPlusEntitlement } from "./dashboard-config.js";
import { isSafeSelfAssignableRole, recordAuditEvent } from "./community.js";

function hexColor(value) { return `#${Math.max(0, Math.min(0xffffff, Number(value) || 0)).toString(16).padStart(6, "0").toUpperCase()}`; }
function colorOptionEmoji(color) {
  const red = (color >> 16) & 255; const green = (color >> 8) & 255; const blue = color & 255;
  if (Math.max(red, green, blue) - Math.min(red, green, blue) < 28) return red > 200 ? "⬜" : red < 60 ? "⬛" : "🩶";
  if (red > green * 1.45 && red > blue * 1.45) return "🟥";
  if (green > red * 1.35 && green > blue * 1.25) return "🟩";
  if (blue > red * 1.3 && blue > green * 1.25) return "🟦";
  if (red > 190 && green > 125 && blue < 100) return "🟧";
  if (red > 175 && blue > 145) return "🟪";
  if (red > 180 && green > 175 && blue < 120) return "🟨";
  return "🎨";
}

async function materializeColorRoles(guild, options) {
  const resolved = [];
  for (const option of options) {
    let role = option.roleId ? guild.roles.cache.get(option.roleId) : null;
    if (role && !isSafeSelfAssignableRole(role)) throw Object.assign(new Error(`Duck cannot safely manage the ${role.name} role.`), { status: 400 });
    if (!role) {
      role = await guild.roles.create({ name: `🎨 ${option.label}`.slice(0, 100), color: option.color, permissions: [], reason: "Duck Color Dock palette" });
      const targetPosition = Math.max(1, (guild.members.me?.roles?.highest?.position || role.position + 1) - 1);
      await role.setPosition(targetPosition, "Place Duck color role below Duck").catch(() => null);
    } else if (role.color !== option.color) await role.setColor(option.color, "Duck Color Dock palette sync");
    resolved.push({ ...option, roleId: role.id });
  }
  return resolved;
}

function colorDockRows(settings) {
  const options = settings.colorRoleOptions;
  const rows = [];
  for (let offset = 0; offset < options.length; offset += offset === 0 && settings.colorRoleAllowRemove ? 24 : 25) {
    const pageSize = offset === 0 && settings.colorRoleAllowRemove ? 24 : 25;
    const menu = new StringSelectMenuBuilder().setCustomId(`duck_color:${Math.floor(offset / 24)}`).setPlaceholder(offset ? "More pond colors…" : "Choose your name color…");
    const choices = options.slice(offset, offset + pageSize).map((option) => ({ label: option.label, value: option.roleId, description: hexColor(option.color), emoji: colorOptionEmoji(option.color) }));
    if (offset === 0 && settings.colorRoleAllowRemove) choices.unshift({ label: "Clear my color", value: "remove", description: "Remove your current Color Dock role", emoji: "🫧" });
    menu.addOptions(choices);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  return rows;
}

async function publishColorDock(guild, actorId) {
  const raw = getGuildSettings(guild.id); let settings = getPublicGuildSettings(raw);
  if (!settings.colorRolesEnabled) throw Object.assign(new Error("Enable Color Dock first."), { status: 409 });
  const channel = guild.channels.cache.get(settings.colorRoleChannelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") throw Object.assign(new Error("Choose a valid Color Dock channel."), { status: 400 });
  if (!settings.colorRoleOptions.length) throw Object.assign(new Error("Add at least one color first."), { status: 400 });
  const options = await materializeColorRoles(guild, settings.colorRoleOptions);
  if (options.some((option, index) => option.roleId !== settings.colorRoleOptions[index].roleId)) updateGuildSettings(guild.id, { colorRoleOptions: options });
  settings = { ...settings, colorRoleOptions: options };
  const list = options.slice(0, 18).map((option) => `${colorOptionEmoji(option.color)} **${option.label}** · \`${hexColor(option.color)}\``).join("\n");
  const embed = new EmbedBuilder().setColor(settings.colorRoleAccent).setTitle(settings.colorRoleTitle).setDescription(`${settings.colorRoleDescription}\n\n${list}${options.length > 18 ? `\n*…and ${options.length - 18} more colors in the menus.*` : ""}`).setFooter({ text: "One color per member • role hierarchy is checked every time" });
  const message = await channel.send({ embeds: [embed], components: colorDockRows(settings), allowedMentions: { parse: [] } });
  await recordAuditEvent(guild, { userId: actorId, action: "Published Color Dock", reason: `${options.length} colors in #${channel.name}`, source: "dashboard" });
  return message;
}

function memberHasColorAccess(member, settings) { return !settings.colorRoleRequiredRoleId || member.roles.cache.has(settings.colorRoleRequiredRoleId); }

async function assignColorRole(member, settings, roleId, reason) {
  if (!memberHasColorAccess(member, settings)) throw new Error("You need the configured access role before using Color Dock.");
  const configured = settings.colorRoleOptions.filter((option) => option.roleId).map((option) => option.roleId);
  const selected = configured.filter((id) => member.roles.cache.has(id) && isSafeSelfAssignableRole(member.guild.roles.cache.get(id)));
  if (selected.length) await member.roles.remove(selected, "Duck Color Dock exclusive selection");
  if (roleId === "remove") return { removed: true, role: null };
  const role = member.guild.roles.cache.get(roleId);
  if (!configured.includes(roleId) || !isSafeSelfAssignableRole(role)) throw new Error("That color is no longer safely available.");
  await member.roles.add(role, reason);
  return { removed: false, role };
}

async function handleColorSelect(interaction) {
  if (!interaction.customId.startsWith("duck_color:")) return false;
  const settings = getPublicGuildSettings(getGuildSettings(interaction.guildId));
  if (!settings.colorRolesEnabled) return interaction.reply({ content: "Color Dock is disabled in this server.", ephemeral: true });
  try {
    const result = await assignColorRole(interaction.member, settings, interaction.values[0], `Color Dock selection by ${interaction.user.tag}`);
    await recordAuditEvent(interaction.guild, { userId: interaction.user.id, targetId: interaction.user.id, action: result.removed ? "Removed name color" : "Selected name color", reason: result.role?.name || "Cleared Color Dock roles", source: "discord" });
    return interaction.reply({ content: result.removed ? "Your pond color has been cleared." : `${colorOptionEmoji(result.role.color)} Your name color is now **${result.role.name.replace(/^🎨\s*/, "")}**.`, ephemeral: true });
  } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
}

async function handleColorCommand(interaction) {
  if (!interaction.guildId || !["color", "colors"].includes(interaction.commandName)) return false;
  const raw = getGuildSettings(interaction.guildId); const settings = getPublicGuildSettings(raw);
  if (!settings.colorRolesEnabled || !settings.colorRoleOptions.length) return interaction.reply({ content: "Color Dock is not configured in this server.", ephemeral: true });
  if (interaction.commandName === "colors") {
    const lines = settings.colorRoleOptions.map((option, index) => `${index + 1}. ${colorOptionEmoji(option.color)} **${option.label}** · \`${hexColor(option.color)}\``);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(settings.colorRoleAccent).setTitle(settings.colorRoleTitle).setDescription(lines.join("\n").slice(0, 4_000))], ephemeral: true });
  }
  const requested = interaction.options.getString("choice", true).trim();
  let option = settings.colorRoleOptions.find((item) => item.label.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US") || hexColor(item.color).toLowerCase() === requested.toLowerCase());
  if (requested.toLowerCase() === "random") {
    if (!hasPlusEntitlement(raw)) return interaction.reply({ content: "Random color shuffle requires Duck Plus.", ephemeral: true });
    option = settings.colorRoleOptions[Math.floor(Math.random() * settings.colorRoleOptions.length)];
  }
  const roleId = ["remove", "clear", "none"].includes(requested.toLowerCase()) ? "remove" : option?.roleId;
  if (!roleId) return interaction.reply({ content: "That color is not in this server's palette. Use `/colors` to see the list.", ephemeral: true });
  try {
    const result = await assignColorRole(interaction.member, settings, roleId, `Color command by ${interaction.user.tag}`);
    return interaction.reply({ content: result.removed ? "Your pond color has been cleared." : `${colorOptionEmoji(result.role.color)} Your name color is now **${option.label}**.`, ephemeral: true });
  } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
}

async function applyRandomJoinColor(member) {
  if (!member?.guild || member.user?.bot) return;
  const raw = getGuildSettings(member.guild.id); const settings = getPublicGuildSettings(raw);
  if (!settings.colorRolesEnabled || !settings.colorRoleRandomOnJoin || !hasPlusEntitlement(raw) || !memberHasColorAccess(member, settings)) return;
  const options = settings.colorRoleOptions.filter((option) => option.roleId);
  if (!options.length) return;
  const option = options[Math.floor(Math.random() * options.length)];
  await assignColorRole(member, settings, option.roleId, "Duck Plus random join color").catch(() => null);
}

export { applyRandomJoinColor, colorOptionEmoji, handleColorCommand, handleColorSelect, hexColor, publishColorDock };
