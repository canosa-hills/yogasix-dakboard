// Retries a Google API call with exponential backoff when it hits a rate-limit-shaped error
// (429, or 403 with a rate-limit/quota reason, or a transient 5xx). Any other error is rethrown
// immediately — no point retrying a genuine 400/404.
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
]);

function isRetryable(err) {
  const code = err?.code ?? err?.response?.status;

  if (code === 429 || code === 500 || code === 503) return true;

  if (code === 403) {
    const reason =
      err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
    if (RATE_LIMIT_REASONS.has(reason)) return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(fn, { retries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;

      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 250;
      console.error(
        `Rate-limited (attempt ${attempt}/${retries}), waiting ${Math.round(delay)}ms:`,
        err.message
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleepMs(ms) {
  return sleep(ms);
}
