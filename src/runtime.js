// Small dependency-free runtime primitives used by Duck's network and queue paths.

class QueueCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueCapacityError";
  }
}

class FairGuildScheduler {
  constructor({ globalConcurrency = 4, guildConcurrency = 1, maxQueuedPerGuild = 20, maxQueuedGlobal = 200 } = {}) {
    this.globalConcurrency = Math.max(1, Number(globalConcurrency) || 4);
    this.guildConcurrency = Math.max(1, Number(guildConcurrency) || 1);
    this.maxQueuedPerGuild = Math.max(1, Number(maxQueuedPerGuild) || 20);
    this.maxQueuedGlobal = Math.max(this.maxQueuedPerGuild, Number(maxQueuedGlobal) || 200);
    this.activeGlobal = 0;
    this.queuedGlobal = 0;
    this.guilds = new Map();
    this.order = [];
    this.cursor = 0;
    this.priorityBurst = 0;
    this.drainScheduled = false;
  }

  schedule(guildId, task, options = {}) {
    const key = String(guildId || "global");
    if (this.queuedGlobal >= this.maxQueuedGlobal) {
      throw new QueueCapacityError("Duck's global AI queue is full. Try again after the current requests finish.");
    }
    let state = this.guilds.get(key);
    if (!state) {
      state = { active: 0, queue: [] };
      this.guilds.set(key, state);
      this.order.push(key);
    }
    const priority = options.priority === true;
    const guildQueueLimit = priority ? Math.min(this.maxQueuedPerGuild * 2, 200) : this.maxQueuedPerGuild;
    if (state.queue.length >= guildQueueLimit) {
      throw new QueueCapacityError("This server's AI queue is full. Try again after the current requests finish.");
    }

    const position = state.queue.length + state.active + 1;
    const promise = new Promise((resolve, reject) => {
      state.queue.push({ task, resolve, reject, priority });
      this.queuedGlobal += 1;
    });
    this.scheduleDrain();
    return { position, promise };
  }

  snapshot(guildId) {
    const state = this.guilds.get(String(guildId || "global"));
    return {
      activeGlobal: this.activeGlobal,
      queuedGlobal: this.queuedGlobal,
      activeForGuild: state?.active ?? 0,
      queuedForGuild: state?.queue.length ?? 0,
      guilds: this.guilds.size,
    };
  }

  scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  drain() {
    while (this.activeGlobal < this.globalConcurrency && this.order.length) {
      const select = (priorityOnly, normalOnly = false) => {
        for (let checked = 0; checked < this.order.length; checked += 1) {
          this.cursor %= this.order.length;
          const key = this.order[this.cursor];
          this.cursor = (this.cursor + 1) % this.order.length;
          const state = this.guilds.get(key);
          const next = state?.queue?.[0];
          if (!state || state.active >= this.guildConcurrency || !next) continue;
          if (priorityOnly && !next.priority) continue;
          if (normalOnly && next.priority) continue;
          return { key, state };
        }
        return null;
      };
      let selected = this.priorityBurst < 2 ? select(true) : select(false, true);
      selected ??= select(false);
      if (!selected) return;

      const item = selected.state.queue.shift();
      this.priorityBurst = item.priority ? this.priorityBurst + 1 : 0;
      this.queuedGlobal -= 1;
      selected.state.active += 1;
      this.activeGlobal += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          selected.state.active -= 1;
          this.activeGlobal -= 1;
          if (!selected.state.active && !selected.state.queue.length) {
            this.guilds.delete(selected.key);
            const index = this.order.indexOf(selected.key);
            if (index !== -1) this.order.splice(index, 1);
            if (this.cursor > index) this.cursor -= 1;
            if (this.cursor < 0) this.cursor = 0;
          }
          this.scheduleDrain();
        });
    }
  }
}

function parseRetryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 10_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 10_000)) : null;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithTimeoutAndRetry(url, options = {}, policy = {}) {
  const timeoutMs = Math.max(1_000, Number(policy.timeoutMs) || 30_000);
  const attempts = Math.max(1, Math.min(Number(policy.attempts) || 2, 5));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!isRetryableStatus(response.status) || attempt === attempts) return response;
      await response.body?.cancel?.().catch(() => {});
      const retryAfter = parseRetryAfterMs(response);
      await new Promise((resolve) => setTimeout(resolve, retryAfter ?? Math.min(250 * (2 ** (attempt - 1)), 2_000)));
    } catch (err) {
      lastError = err?.name === "AbortError" || controller.signal.aborted
        ? new Error(`Request timed out after ${timeoutMs}ms.`, { cause: err })
        : err;
      if (attempt === attempts) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (2 ** (attempt - 1)), 2_000)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("Network request failed.");
}

async function readBoundedText(response, maxBytes = 2 * 1024 * 1024) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedJson(response, maxBytes) {
  const text = await readBoundedText(response, maxBytes);
  return JSON.parse(text);
}

function modelSupportsVision(providerName, model, options = {}) {
  if (String(providerName || "").toLowerCase() !== "openrouter") return false;
  const normalized = String(model || "").toLowerCase();
  if (!normalized || /^tencent\/hy3(?:[:/]|$)/.test(normalized)) return false;
  const mode = String(options.mode || "auto").toLowerCase();
  if (["off", "false", "0", "no"].includes(mode)) return false;
  if (["on", "true", "1", "yes"].includes(mode)) return true;

  const configured = String(options.models || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (configured.includes(normalized)) return true;
  return /(?:^|[/_-])(vision|vl)(?:$|[:/_-])|gemini|gpt-4o|pixtral|qwen[^/]*[-_]vl|claude-3/.test(normalized);
}

export {
  FairGuildScheduler,
  QueueCapacityError,
  fetchWithTimeoutAndRetry,
  isRetryableStatus,
  modelSupportsVision,
  parseRetryAfterMs,
  readBoundedJson,
  readBoundedText,
};
