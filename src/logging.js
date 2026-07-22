// Duck: logging, Discord-text formatting, and AI error helpers.

function isDebugEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.DUCK_DEBUG || "true");
}

function shouldLogAiBodies() {
  return /^(1|true|yes|on)$/i.test(process.env.DUCK_DEBUG_AI_BODY || "");
}

function timestamp() {
  return new Date().toISOString();
}

function redact(value) {
  if (value == null) return value;
  const text = String(value);
  if (!text || /^(optional_|your_|placeholder)/i.test(text)) return text;
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function logInfo(event, details = {}) {
  console.log(`[${timestamp()}] [duck] ${event}`, details);
}

function logDebug(event, details = {}) {
  if (isDebugEnabled()) {
    console.log(`[${timestamp()}] [duck:debug] ${event}`, details);
  }
}

function logWarn(event, details = {}) {
  console.warn(`[${timestamp()}] [duck:warn] ${event}`, details);
}

function logError(event, err, details = {}) {
  console.error(`[${timestamp()}] [duck:error] ${event}`, {
    ...details,
    error: err?.stack || err?.message || String(err),
  });
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function limitDiscordContent(content, maxLength = 1900) {
  const text = String(content ?? "").trim();
  if (!text) return "Duck has nothing to send.";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20).trim()}...`;
}

function splitDiscordLines(lines, maxLength = 1900) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const safeLine = limitDiscordContent(line, maxLength);
    const next = current ? `${current}\n${safeLine}` : safeLine;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = safeLine;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : ["Duck has nothing to send."];
}
class AiServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AiServiceError";
    this.details = details;
  }
}

function makeAiUserError(err, fallback = "AI failed before it could answer.") {
  if (err instanceof AiServiceError) return err.message;
  return fallback;
}

export {
  isDebugEnabled,
  shouldLogAiBodies,
  timestamp,
  redact,
  logInfo,
  logDebug,
  logWarn,
  logError,
  elapsedMs,
  limitDiscordContent,
  splitDiscordLines,
  AiServiceError,
  makeAiUserError,
};
