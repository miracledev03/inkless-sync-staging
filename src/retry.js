/**
 * Retry transient upstream failures (HubSpot 429/5xx, network blips).
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 429 || status >= 500) return true;
  const code = String(err?.code || '');
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }
  const msg = String(err?.message || '');
  return /fetch failed|network|timeout|socket/i.test(msg);
}

async function withRetry(fn, opts = {}) {
  const attempts = Number(opts.attempts || process.env.HTTP_RETRY_ATTEMPTS || 3);
  const baseMs = Number(opts.baseMs || process.env.HTTP_RETRY_BASE_MS || 400);
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i >= attempts - 1 || !isRetryableError(err)) throw err;
      const wait = baseMs * Math.pow(2, i);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryableError, sleep };
