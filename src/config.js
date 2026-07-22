import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateDependencyReport, version as voicePackageVersion } from "@discordjs/voice";
import { dataDir, settingsPath, pendingActionsPath, warningsPath, MAX_TIMER_DELAY_MS, CAPABILITY_MODES, CAPABILITY_MODE_LABELS } from "./constants.js";
import { pendingActions, pendingByChannel, pendingExpiryTimers, jsonFileCache, pendingJsonWrites } from "./state.js";
import { isDebugEnabled, logInfo, logDebug, logWarn, logError, redact } from "./logging.js";

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

function getAiContextFocusedMessages() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_FOCUSED_MESSAGES) || 50, 100));
}

function getAiContextBackgroundMessages() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_BACKGROUND_MESSAGES) || 5, 50));
}

function getAiContextFetchConcurrency() {
  return Math.max(1, Math.min(Number(process.env.AI_CONTEXT_FETCH_CONCURRENCY) || 6, 20));
}

function getAiContextAttachmentLimit() {
  return Math.max(0, Math.min(Number(process.env.AI_CONTEXT_ATTACHMENT_LIMIT) || 6, 20));
}

function isAiVisionEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.AI_VISION_ENABLED || "true");
}

function getAiVisionMaxImages() {
  return Math.max(0, Math.min(Number(process.env.AI_VISION_MAX_IMAGES) || 4, 12));
}

function getAiVisionBatchSize() {
  return Math.max(1, Math.min(Number(process.env.AI_VISION_BATCH_SIZE) || 2, 6));
}

function getAiVisionMaxAttachmentBytes() {
  return Math.max(64 * 1024, Math.min(Number(process.env.AI_VISION_MAX_ATTACHMENT_BYTES) || 8 * 1024 * 1024, 25 * 1024 * 1024));
}

function getAiVisionDetail() {
  const detail = String(process.env.AI_VISION_DETAIL || "low").toLowerCase();
  return ["low", "high", "auto"].includes(detail) ? detail : "low";
}

function getMessageCacheTtlMs() {
  return Math.max(5_000, Math.min(Number(process.env.DUCK_MESSAGE_CACHE_TTL_MS) || 60_000, 10 * 60 * 1000));
}

function getMessageCacheLimit() {
  return Math.max(25, Math.min(Number(process.env.DUCK_MESSAGE_CACHE_LIMIT) || 100, 500));
}

function getCacheRefreshMs() {
  return Math.max(60_000, Math.min(Number(process.env.DUCK_CACHE_REFRESH_MS) || 3 * 60_000, 60 * 60 * 1000));
}

function getCacheRefreshChannelLimit() {
  return Math.max(1, Math.min(Number(process.env.DUCK_CACHE_REFRESH_MAX_CHANNELS) || 10, 200));
}

function getCacheRefreshConcurrency() {
  return Math.max(1, Math.min(Number(process.env.DUCK_CACHE_REFRESH_CONCURRENCY) || 2, 8));
}

function getQueueMessage() {
  return process.env.DUCK_QUEUE_MESSAGE || "Duck is thinking...";
}

function getEnvBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function supportsCurrentVoiceRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

function getEnvId(name) {
  const value = String(process.env[name] || "").trim();
  return /^\d{10,}$/.test(value) ? value : null;
}

function getLegacyCommandPrefixes(guildId = null) {
  const configured = guildId ? getGuildSettings(guildId).commandPrefix : null;
  return [configured, ...(process.env.DUCK_LEGACY_PREFIXES || "!,!!").split(",")]
    .map((prefix) => String(prefix || "").trim())
    .filter(Boolean)
    .filter((prefix, index, items) => items.indexOf(prefix) === index)
    .sort((a, b) => b.length - a.length);
}

function getLegacyCommandContent(content, guildId = null) {
  const prefixes = getLegacyCommandPrefixes(guildId);
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
  // Node's setTimeout overflows above ~24.8 days and fires almost immediately.
  // Re-arm in bounded chunks so a large PENDING_ACTION_TTL_MS still expires on time.
  if (delay > MAX_TIMER_DELAY_MS) {
    const timer = setTimeout(() => schedulePendingExpiry(action), MAX_TIMER_DELAY_MS);
    timer.unref?.();
    pendingExpiryTimers.set(action.id, timer);
    return;
  }
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

function getGuildCapabilityMode(guildId) {
  const mode = getGuildSettings(guildId).capabilityMode;
  return Object.values(CAPABILITY_MODES).includes(mode) ? mode : CAPABILITY_MODES.ask;
}

function getCapabilityModeLabel(mode) {
  return CAPABILITY_MODE_LABELS[mode] ?? CAPABILITY_MODE_LABELS.ask;
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
    contextFocusedMessages: getAiContextFocusedMessages(),
    contextBackgroundMessages: getAiContextBackgroundMessages(),
    contextMaxMessages: process.env.AI_CONTEXT_MAX_MESSAGES || "500",
    contextCacheTtlMs: getServerContextCacheTtlMs(),
    contextMemberLimit: getAiContextMemberLimit(),
    contextChannelLimit: getAiContextChannelLimit(),
    contextRoleLimit: getAiContextRoleLimit(),
    contextMaxChars: getAiContextMaxChars(),
    contextMessageChars: getAiContextMessageChars(),
    contextAttachmentLimit: getAiContextAttachmentLimit(),
    chatMaxTokens: getAiChatMaxTokens(),
    chatMaxAttempts: getAiChatMaxAttempts(),
    excludeReasoning: !/^(0|false|no|off)$/i.test(process.env.AI_EXCLUDE_REASONING || "true"),
    visionEnabled: isAiVisionEnabled(),
    visionMaxImages: getAiVisionMaxImages(),
    visionBatchSize: getAiVisionBatchSize(),
    visionMaxAttachmentBytes: getAiVisionMaxAttachmentBytes(),
    visionDetail: getAiVisionDetail(),
    pendingActionTtlMs: getPendingActionTtlMs(),
  });
  logInfo("voice.dependencies", {
    voicePackageVersion,
    runtimeSupported: supportsCurrentVoiceRuntime(),
    report: generateDependencyReport().split(/\r?\n/).filter(Boolean),
  });
  if (!supportsCurrentVoiceRuntime()) {
    logWarn("voice.runtime-unsupported", {
      currentNode: process.version,
      requiredNode: ">=22.12.0",
    });
  }

  if (!process.env.DISCORD_TOKEN) {
    throw new Error("Missing DISCORD_TOKEN. Copy config.example.json to config.json and fill it in.");
  }

  if (!process.env.CLIENT_ID) {
    throw new Error("Missing CLIENT_ID. Copy config.example.json to config.json and fill it in.");
  }
}

export {
  packageInfo,
  buildInfo,
  readGitValue,
  loadBuildInfo,
  loadDotEnv,
  loadJsonConfig,
  loadSettings,
  saveSettings,
  loadJsonFile,
  writeJsonFileNow,
  getJsonWriteDebounceMs,
  saveJsonFile,
  flushJsonWrites,
  loadWarnings,
  saveWarnings,
  getMemberWarnings,
  addMemberWarning,
  clearMemberWarnings,
  getPendingActionTtlMs,
  getServerContextCacheTtlMs,
  getAiContextMemberLimit,
  getAiContextChannelLimit,
  getAiContextRoleLimit,
  getAiContextMessageChannelLimit,
  getAiContextMaxChars,
  getAiContextMessageChars,
  getAiContextFocusedMessages,
  getAiContextBackgroundMessages,
  getAiContextFetchConcurrency,
  getAiContextAttachmentLimit,
  isAiVisionEnabled,
  getAiVisionMaxImages,
  getAiVisionBatchSize,
  getAiVisionMaxAttachmentBytes,
  getAiVisionDetail,
  getMessageCacheTtlMs,
  getMessageCacheLimit,
  getCacheRefreshMs,
  getCacheRefreshChannelLimit,
  getCacheRefreshConcurrency,
  getQueueMessage,
  getEnvBoolean,
  supportsCurrentVoiceRuntime,
  getEnvId,
  getLegacyCommandPrefixes,
  getLegacyCommandContent,
  getEntryChannelConfig,
  updateEntryChannelConfig,
  getAiChatMaxTokens,
  getAiChatMaxAttempts,
  shouldExcludeReasoning,
  savePendingActions,
  getActionRequestChannelId,
  schedulePendingExpiry,
  rebuildPendingByChannel,
  loadPendingActions,
  getGuildSettings,
  getGuildCapabilityMode,
  getCapabilityModeLabel,
  updateGuildSettings,
  requireConfig,
};
