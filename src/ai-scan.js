import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { getGuildSettings } from "./config.js";
import { getAiModelDefinition, getPublicGuildSettings } from "./dashboard-config.js";
import { FairGuildScheduler, QueueCapacityError, fetchWithTimeoutAndRetry, readBoundedJson, readBoundedText } from "./runtime.js";
import { recordAiFlag } from "./community.js";

const CATEGORIES = new Set(["harassment", "hate", "sexual", "violence", "self_harm", "scam", "spam", "other"]);
const thresholds = { low: 0.9, balanced: 0.75, high: 0.6 };
const scheduler = new FairGuildScheduler({ globalConcurrency: 2, guildConcurrency: 1, maxQueuedPerGuild: 10, maxQueuedGlobal: 50 });
const recentScans = new Map();
const rulesCache = new Map();

function parseScanResult(value) {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let result;
  try { result = JSON.parse(raw); } catch { return null; }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.flag !== true) return null;
  const confidence = Number(result.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !CATEGORIES.has(result.category)) return null;
  const reason = String(result.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return reason ? { category: result.category, confidence, reason } : null;
}

function shouldQueueScan(message, settings, now = Date.now()) {
  if (!settings.aiScanEnabled || !settings.aiScanFlagChannelId || !settings.aiScanChannelIds.includes(message.channelId)) return false;
  const content = String(message.content || "").trim();
  if (content.length < 4 || !process.env.OPENROUTER_API_KEY) return false;
  const key = `${message.guildId}:${message.channelId}:${message.author.id}`;
  if ((recentScans.get(key) || 0) > now - 4_000) return false;
  recentScans.set(key, now);
  if (recentScans.size > 10_000) for (const [id, usedAt] of recentScans) if (usedAt < now - 60_000) recentScans.delete(id);
  return true;
}

async function requestSuggestion(content, { rules = "No server-specific rules were supplied.", model, fetchImpl = fetch } = {}) {
  const selectedModel = getAiModelDefinition(model);
  if (!selectedModel) throw new TypeError("AI scanning requires a server-selected model from Duck's allowlist.");
  const response = await fetchWithTimeoutAndRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://duck.wispbyte.app",
      "X-OpenRouter-Title": `${process.env.OPENROUTER_APP_NAME || "Duck Discord Bot"} advisory scanner`,
    },
    body: JSON.stringify({
      model: selectedModel.id,
      ...(selectedModel.providerRouting ? { provider: selectedModel.providerRouting } : {}),
      temperature: 0,
      max_tokens: 160,
      messages: [
        { role: "system", content: `You are an advisory-only Discord safety classifier. Never recommend or perform an action. Compare the message against the supplied server rules as well as credible harassment, hate, sexual content, violence, self-harm risk, scams, or spam. Consider context uncertainty and avoid flagging quoted discussion. Server rules:\n${String(rules).slice(0, 5_000)}\nReturn only JSON: {"flag":boolean,"category":"harassment|hate|sexual|violence|self_harm|scam|spam|other","confidence":0.0,"reason":"short neutral explanation naming the relevant rule when possible"}.` },
        { role: "user", content: String(content).slice(0, 1_500) },
      ],
    }),
  }, { timeoutMs: 12_000, attempts: 2, fetchImpl });
  if (!response.ok) throw new Error(`AI scan provider returned HTTP ${response.status}: ${(await readBoundedText(response, 16 * 1024)).slice(0, 160)}`);
  const body = await readBoundedJson(response, 256 * 1024);
  return parseScanResult(body?.choices?.[0]?.message?.content);
}

async function getServerRules(message, settings, now = Date.now()) {
  if (!settings.aiScanRulesChannelId) return "No server-specific rules were supplied.";
  const cached = rulesCache.get(message.guildId);
  if (cached?.channelId === settings.aiScanRulesChannelId && cached.expiresAt > now) return cached.text;
  const channel = message.guild.channels.cache.get(settings.aiScanRulesChannelId) ?? await message.guild.channels.fetch(settings.aiScanRulesChannelId).catch(() => null);
  if (!channel?.messages?.fetch) return "The configured rules channel could not be read.";
  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const text = messages ? [...messages.values()].reverse().flatMap((item) => [String(item.content || "").trim(), ...(item.embeds || []).flatMap((embed) => [embed.title, embed.description, ...(embed.fields || []).flatMap((field) => [field.name, field.value])])]).filter(Boolean).join("\n").slice(0, 5_000) : "The configured rules channel could not be read.";
  rulesCache.set(message.guildId, { channelId: settings.aiScanRulesChannelId, text, expiresAt: now + 5 * 60_000 });
  if (rulesCache.size > 1_000) rulesCache.delete(rulesCache.keys().next().value);
  return text;
}

async function scanMessage(message, settings) {
  const result = await requestSuggestion(message.content, { rules: await getServerRules(message, settings), model: settings.aiModel });
  if (!result || result.confidence < thresholds[settings.aiScanSensitivity]) return null;
  const channel = message.guild.channels.cache.get(settings.aiScanFlagChannelId)
    ?? await message.guild.channels.fetch(settings.aiScanFlagChannelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") return null;
  const excerpt = String(message.content || "").replace(/\s+/g, " ").slice(0, 500);
  const embed = new EmbedBuilder()
    .setColor(0xf0a33a)
    .setTitle("AI review suggestion")
    .setDescription("Duck's experimental scanner suggests a human review. **No moderation action was taken.**")
    .addFields(
      { name: "Suggested category", value: result.category.replace("_", " "), inline: true },
      { name: "Confidence", value: `${Math.round(result.confidence * 100)}%`, inline: true },
      { name: "Author", value: `<@${message.author.id}> (\`${message.author.id}\`)` },
      { name: "Reason", value: result.reason },
      { name: "Message excerpt", value: excerpt || "(no text)" },
    )
    .setURL(message.url)
    .setFooter({ text: `Advisory only · ${settings.aiModel}` })
    .setTimestamp();
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duck_ai_action:${message.channelId}:${message.id}:${message.author.id}`).setLabel("Take Action").setEmoji("🛡️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel("Go To Message").setEmoji("↗️").setStyle(ButtonStyle.Link).setURL(message.url),
  );
  const sent = await channel.send({ embeds: [embed], components: [actions], allowedMentions: { parse: [] } });
  recordAiFlag(message.guildId);
  return sent;
}

function queueAiScan(message) {
  const settings = getPublicGuildSettings(getGuildSettings(message.guildId));
  if (!shouldQueueScan(message, settings)) return null;
  try { return scheduler.schedule(message.guildId, () => scanMessage(message, settings)).promise; }
  catch (error) { if (error instanceof QueueCapacityError) return null; throw error; }
}

export { getServerRules, parseScanResult, queueAiScan, requestSuggestion, shouldQueueScan };
