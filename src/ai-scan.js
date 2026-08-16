import { EmbedBuilder } from "discord.js";
import { getGuildSettings } from "./config.js";
import { getPublicGuildSettings } from "./dashboard-config.js";
import { FairGuildScheduler, QueueCapacityError, fetchWithTimeoutAndRetry, readBoundedJson, readBoundedText } from "./runtime.js";

const AI_SCAN_MODEL = "openai/gpt-oss-20b:free";
const CATEGORIES = new Set(["harassment", "hate", "sexual", "violence", "self_harm", "scam", "spam", "other"]);
const thresholds = { low: 0.9, balanced: 0.75, high: 0.6 };
const scheduler = new FairGuildScheduler({ globalConcurrency: 2, guildConcurrency: 1, maxQueuedPerGuild: 10, maxQueuedGlobal: 50 });
const recentScans = new Map();

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

async function requestSuggestion(content, fetchImpl = fetch) {
  const response = await fetchWithTimeoutAndRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://duck.wispbyte.app",
      "X-OpenRouter-Title": `${process.env.OPENROUTER_APP_NAME || "Duck Discord Bot"} advisory scanner`,
    },
    body: JSON.stringify({
      model: AI_SCAN_MODEL,
      temperature: 0,
      max_tokens: 160,
      messages: [
        { role: "system", content: "You are an advisory-only Discord safety classifier. Never recommend or perform an action. Flag only credible harassment, hate, sexual content, violence, self-harm risk, scams, or spam. Consider context uncertainty and avoid flagging quoted discussion. Return only JSON: {\"flag\":boolean,\"category\":\"harassment|hate|sexual|violence|self_harm|scam|spam|other\",\"confidence\":0.0,\"reason\":\"short neutral explanation\"}." },
        { role: "user", content: String(content).slice(0, 1_500) },
      ],
    }),
  }, { timeoutMs: 12_000, attempts: 2, fetchImpl });
  if (!response.ok) throw new Error(`AI scan provider returned HTTP ${response.status}: ${(await readBoundedText(response, 16 * 1024)).slice(0, 160)}`);
  const body = await readBoundedJson(response, 256 * 1024);
  return parseScanResult(body?.choices?.[0]?.message?.content);
}

async function scanMessage(message, settings) {
  const result = await requestSuggestion(message.content);
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
    .setFooter({ text: `Advisory only · ${AI_SCAN_MODEL}` })
    .setTimestamp();
  return channel.send({ embeds: [embed], components: [], allowedMentions: { parse: [] } });
}

function queueAiScan(message) {
  const settings = getPublicGuildSettings(getGuildSettings(message.guildId));
  if (!shouldQueueScan(message, settings)) return null;
  try { return scheduler.schedule(message.guildId, () => scanMessage(message, settings)).promise; }
  catch (error) { if (error instanceof QueueCapacityError) return null; throw error; }
}

export { AI_SCAN_MODEL, parseScanResult, queueAiScan, requestSuggestion, shouldQueueScan };
