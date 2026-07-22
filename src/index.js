import { Events, ActivityType, PermissionsBitField } from "discord.js";
import { client } from "./client.js";
import { logInfo, logDebug, logWarn, logError, elapsedMs, splitDiscordLines } from "./logging.js";
import { pendingActions, pendingByChannel } from "./state.js";
import { TOOL_DEFINITIONS, TOOL_REQUIREMENTS, DUCK_COLORS } from "./constants.js";
import { packageInfo, buildInfo, flushJsonWrites, getQueueMessage, getLegacyCommandContent, getEntryChannelConfig, updateEntryChannelConfig, loadPendingActions, getGuildSettings, updateGuildSettings, requireConfig } from "./config.js";
import { normalizeText, isLikelySpeakRequest, hasExplicitSpeakMessage, summarizeChannel, isLikelyModerationRequest, rememberMessage, removeCachedMessage, removeCachedMessages, startCacheMaintenance, flushRuntimeStateAndExit, hasConfiguredAi, parseInlineToolCall, generateChatResponse, planModerationRequest, hasPermission, describePermissionRequirement, handleCapabilityCommand, handleCapabilityButton, dispatchPlannedAction, approveAction, cancelAction, makeDuckHelp, isNegativeConfirmation, cancelLatestActionFromMessage, wantsRecentHistory, makeRecentHistoryResponse, makeUtilityHelp, queueVoiceMessage, handleExplicitCommand, makeUtilityResponse, makeSlashCommandMessage, slashCommandContent, validateSlashCommandDispatchers, makeSlashDuckResponse, makeDuckChatPayload, sendMessageChunks, makeMessageWithContent, getDuckInvocation, startKeepAliveServer, handleMemberJoin, handleMemberRemove, startInviteCleanupLoop, restoreVoiceQuarantineTimers, handleVoiceQuarantineState, registerCommands } from "./core.js";

if (process.argv.includes("--check-commands")) {
  const body = await registerCommands({ user: { id: "validation" } }, { dryRun: true });
  const dispatcherCount = validateSlashCommandDispatchers(body);
  console.log(`Validated ${body.length} slash commands and ${dispatcherCount} dispatchers: ${body.map((command) => command.name).join(", ")}`);
  process.exit(0);
}

requireConfig();
loadPendingActions();
startKeepAliveServer();
startCacheMaintenance();
process.once("beforeExit", flushJsonWrites);
process.once("SIGINT", () => flushRuntimeStateAndExit("SIGINT"));
process.once("SIGTERM", () => flushRuntimeStateAndExit("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logError("process.unhandled-rejection", reason instanceof Error ? reason : new Error(String(reason)));
});
process.on("uncaughtException", (err) => {
  logError("process.uncaught-exception", err);
});
process.on("warning", (warning) => {
  logWarn("process.warning", {
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  });
});


client.on(Events.Error, (err) => {
  logError("discord.client-error", err);
});

client.on(Events.Warn, (message) => {
  logWarn("discord.client-warning", { message });
});

client.on(Events.ShardError, (err, shardId) => {
  logError("discord.shard-error", err, { shardId });
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  logWarn("discord.shard-disconnect", {
    shardId,
    code: event?.code,
    reason: event?.reason,
    wasClean: event?.wasClean,
  });
});

client.on(Events.ShardReconnecting, (shardId) => {
  logWarn("discord.shard-reconnecting", { shardId });
});

client.on(Events.ShardReady, (shardId) => {
  logInfo("discord.shard-ready", { shardId });
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
  restoreVoiceQuarantineTimers();
  try {
    await registerCommands(client);
  } catch (err) {
    logError("discord.commands-register-failed", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "duck") {
        const prompt = interaction.options.getString("prompt", false) || "commands";
        const response = await makeSlashDuckResponse(interaction, prompt);
        const chunks = splitDiscordLines(String(response).split(/\r?\n/));
        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp({ content: chunk, ephemeral: true });
        }
        return;
      }

      if (interaction.commandName === "prefix") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: "Only an Administrator can change Duck's command prefix.", ephemeral: true });
          return;
        }
        const value = interaction.options.getString("value", true).trim();
        if (!value || value.length > 5 || /[\s/@]/.test(value)) {
          await interaction.reply({ content: "Use 1-5 visible characters without spaces, `/`, or `@`.", ephemeral: true });
          return;
        }
        updateGuildSettings(interaction.guildId, { commandPrefix: value });
        await interaction.reply({ content: `Duck's additional prefix is now \`${value}\`. \`!\`, \`!!\`, and slash commands still work.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === "capibility") {
        await handleCapabilityCommand(interaction);
        return;
      }

      if (interaction.commandName === "announce") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: "Only an Administrator can prepare announcements.", ephemeral: true });
          return;
        }
        const targetChannel = interaction.options.getChannel("channel", false) ?? interaction.channel;
        const role = interaction.options.getRole("role", false);
        const messageText = interaction.options.getString("message", true).trim();
        const slashMessage = makeSlashCommandMessage(interaction, "announce");
        await dispatchPlannedAction(slashMessage, {
          tool: "announce",
          risk: "high",
          channelId: targetChannel.id,
          channelName: targetChannel.name,
          messageText,
          embedAnnouncement: interaction.options.getBoolean("embed", true),
          mentionRoleId: role?.id ?? null,
          reason: "Administrator announcement request.",
          summary: `announce in ${summarizeChannel(targetChannel)}${role ? ` mentioning @${role.name}` : " without a role ping"}`,
        }, { content: "Announcement prepared for confirmation.", useEmbed: true });
        return;
      }

      const explicitContent = slashCommandContent(interaction);
      if (explicitContent) {
        const slashMessage = makeSlashCommandMessage(interaction, explicitContent);
        if (await handleExplicitCommand(slashMessage, explicitContent)) return;
        await interaction.reply({ content: "I could not validate that command. Check the target and arguments, then try again.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "setup") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: "Only an Administrator can set up Duck.", ephemeral: true });
          return;
        }

        const channel = interaction.options.getChannel("channel", false);
        const quarantineChannel = interaction.options.getChannel("quarantine-channel", false);
        if (!channel && !quarantineChannel) {
          await interaction.reply({ content: "Choose a moderation channel, a voice quarantine channel, or both.", ephemeral: true });
          return;
        }

        if (quarantineChannel) {
          const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
          const permissions = quarantineChannel.permissionsFor(botMember);
          const required = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.MoveMembers,
          ];
          if (!permissions?.has(required)) {
            await interaction.reply({
              content: "Duck needs View Channel, Connect, and Move Members in the selected voice quarantine channel.",
              ephemeral: true,
            });
            return;
          }
        }

        const patch = {};
        if (channel) patch.modChannelId = channel.id;
        if (quarantineChannel) {
          patch.voiceQuarantineChannelId = quarantineChannel.id;
        }
        updateGuildSettings(interaction.guildId, patch);
        logInfo("settings.setup-updated", {
          guildId: interaction.guildId,
          channelId: channel?.id,
          voiceQuarantineChannelId: quarantineChannel?.id,
          userId: interaction.user.id,
        });
        await interaction.reply({
          content: [
            channel ? `Duck will now listen in ${channel}.` : null,
            quarantineChannel ? `Voice quarantine will use ${quarantineChannel}.` : null,
          ].filter(Boolean).join("\n"),
          ephemeral: true,
        });
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

      logWarn("discord.unknown-slash-command", {
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      await interaction.reply({
        content: "That Duck slash command is not available in this build. Try `/duck prompt:commands`, `/duck-tools`, or `duck commands` in chat.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.isButton()) {
      const [kind, actionId] = interaction.customId.split(":");
      if (kind === "duck_confirm") {
        await approveAction(interaction, actionId, client);
      } else if (kind === "duck_cancel") {
        await cancelAction(interaction, actionId);
      } else if (kind === "duck_capability_agent" || kind === "duck_capability_cancel") {
        await handleCapabilityButton(interaction, kind, actionId);
      } else {
        logWarn("discord.unknown-button", {
          customId: interaction.customId,
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        await interaction.reply({ content: "That Duck button is no longer available.", ephemeral: true });
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

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await handleVoiceQuarantineState(oldState, newState);
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
    queueVoiceMessage(message);

    const guildSettings = getGuildSettings(message.guildId);
    const configuredChannelId = guildSettings.modChannelId;
    const invocation = await getDuckInvocation(message, client);
    const legacyCommandContent = getLegacyCommandContent(message.content, message.guildId);
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
      if (await handleExplicitCommand(legacyMessage, legacyCommandContent)) {
        logInfo("message.legacy-command", {
          messageId: message.id,
          command: normalizeText(legacyCommandContent).split(" ")[0],
          ms: elapsedMs(messageStartedAt),
        });
        return;
      }
      await sendMessageChunks(message, "Unknown command. Use `!commands` or `/commands`.");
      return;
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
      await message.reply(makeDuckChatPayload(message, makeDuckHelp(invocation.content), {
        title: "Duck Command Center",
      }));
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
      ? await message.reply(makeDuckChatPayload(message, getQueueMessage(), {
          title: "Duck is thinking",
          color: DUCK_COLORS.neutral,
          footer: "Gathering relevant server context",
        })).catch(() => null)
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
        await queueMessage.edit(makeDuckChatPayload(message, content, { title: "Recent Activity" })).catch(() => {});
      } else {
        await message.reply(makeDuckChatPayload(message, content, { title: "Recent Activity" }));
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
            await dispatchPlannedAction(message, parsedToolCall.plan, {
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
        await queueMessage.edit(makeDuckChatPayload(message, parsedToolCall.content || content, {
          color: chatResult.error ? DUCK_COLORS.danger : DUCK_COLORS.brand,
        })).catch(() => {});
      } else if (content) {
        const parsedToolCall = parseInlineToolCall(planningMessage, content);
        await message.reply(makeDuckChatPayload(message, parsedToolCall.content || content, {
          color: chatResult.error ? DUCK_COLORS.danger : DUCK_COLORS.brand,
        }));
      } else if (queueMessage) {
        await queueMessage.edit(makeDuckChatPayload(message, "I tried to answer, but AI returned no content and I do not have a local fallback for that.", {
          title: "AI Response Failed",
          color: DUCK_COLORS.danger,
        })).catch(() => {});
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
        await queueMessage.edit(makeDuckChatPayload(message, plan.error, {
          title: "Request Needs Attention",
          color: DUCK_COLORS.danger,
        })).catch(() => {});
      } else {
        await message.reply(makeDuckChatPayload(message, plan.error, {
          title: "Request Needs Attention",
          color: DUCK_COLORS.danger,
        }));
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
        await queueMessage.edit(makeDuckChatPayload(message, content, {
          title: "Permission Required",
          color: DUCK_COLORS.danger,
        })).catch(() => {});
      } else {
        await message.reply(makeDuckChatPayload(message, content, {
          title: "Permission Required",
          color: DUCK_COLORS.danger,
        }));
      }
      return;
    }

    const confirmationContent = toolResponseContent || "Prepared a moderation plan. Waiting for Administrator confirmation.";
    if (queueMessage) {
      await dispatchPlannedAction(message, plan, {
        messageToEdit: queueMessage,
        content: confirmationContent,
        useEmbed: true,
      });
    } else {
      await dispatchPlannedAction(message, plan, {
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

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  logError("discord.login-failed", err);
  process.exitCode = 1;
});
