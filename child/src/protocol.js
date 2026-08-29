const JSON_CONTENT_TYPE = /(?:^|\s|;)application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i;
const MAX_CLOCK_CORRECTION_MS = 24 * 60 * 60_000;

function safeHeader(response, name) {
  return String(response?.headers?.get?.(name) || "").replace(/[\r\n]/g, " ").slice(0, 160);
}

export async function readManagerJson(response, maximum = 512 * 1024, source = "Manager") {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) {
    const error = new Error(`${source} response exceeded ${maximum} bytes.`);
    error.code = "manager_response_too_large";
    error.retryable = true;
    throw error;
  }

  const contentType = safeHeader(response, "content-type");
  const requestId = safeHeader(response, "x-request-id");
  const protocol = safeHeader(response, "x-duck-child-protocol");
  const text = bytes.toString("utf8");
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    const suffix = [contentType || "missing content-type", requestId ? `request ${requestId}` : null]
      .filter(Boolean)
      .join(", ");
    const error = new Error(`${source} returned non-JSON HTTP ${response.status} (${suffix}). The proxy or upstream served a web page instead of the expected API.`);
    error.code = "manager_non_json";
    error.status = response.status;
    error.retryable = true;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    const error = new Error(`${source} returned malformed JSON over HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}.`);
    error.code = "manager_invalid_json";
    error.status = response.status;
    error.retryable = true;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(typeof value?.error === "string" ? value.error.slice(0, 300) : `${source} returned HTTP ${response.status}.`);
    error.code = typeof value?.code === "string" && /^[a-z0-9_]{3,80}$/i.test(value.code) ? value.code : "manager_http_error";
    error.status = response.status;
    error.retryAfterMs = Math.max(0, Math.min(Number(response.headers.get("retry-after")) * 1_000 || 0, 5 * 60_000));
    const headerTime = Date.parse(safeHeader(response, "date"));
    const managerTime = Number(value?.managerTime);
    error.managerTime = Number.isSafeInteger(managerTime) ? managerTime : Number.isFinite(headerTime) ? headerTime : null;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw error;
  }

  if (protocol && protocol !== "1") {
    const error = new Error(`Manager child protocol ${protocol} is not supported by this worker.`);
    error.code = "manager_protocol_mismatch";
    error.retryable = false;
    throw error;
  }
  return value;
}

export function createManagerClock(now = Date.now) {
  let offsetMs = 0;
  return {
    now: () => Math.round(now() + offsetMs),
    offset: () => offsetMs,
    observe(managerTime, { immediate = false } = {}) {
      const remote = Number(managerTime);
      if (!Number.isSafeInteger(remote)) return false;
      const candidate = remote - now();
      if (Math.abs(candidate) > MAX_CLOCK_CORRECTION_MS) return false;
      offsetMs = immediate || Math.abs(candidate - offsetMs) > 30_000
        ? candidate
        : Math.round((offsetMs * 0.75) + (candidate * 0.25));
      return true;
    },
  };
}

export async function fetchWithDeadline(url, options = {}, timeoutMs = 12_000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Manager request timed out.")), Math.max(1_000, Math.min(timeoutMs, 60_000)));
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error("Manager request timed out.");
      timeout.code = "manager_timeout";
      timeout.retryable = true;
      throw timeout;
    }
    error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function retryDelay(attempt, { baseMs = 1_000, maximumMs = 30_000, retryAfterMs = 0, random = Math.random } = {}) {
  const exponent = Math.max(0, Math.min(Number(attempt) - 1 || 0, 8));
  const backoff = Math.min(maximumMs, baseMs * (2 ** exponent));
  const jitter = Math.floor(backoff * 0.2 * Math.max(0, Math.min(Number(random()) || 0, 1)));
  return Math.max(Math.min(Number(retryAfterMs) || 0, maximumMs), backoff + jitter);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
