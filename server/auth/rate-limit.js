const buckets = new Map();
const MAX_BUCKETS = 10000;

function consumeRateLimit(key, { limit, windowMs, now = Date.now() }) {
  const existing = buckets.get(key);
  if (!existing || now >= existing.resetAt) {
    if (buckets.size >= MAX_BUCKETS) pruneRateLimits(now);
    if (buckets.size >= MAX_BUCKETS) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000))
      };
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function pruneRateLimits(now = Date.now()) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

const cleanupTimer = setInterval(pruneRateLimits, 15 * 60 * 1000);
cleanupTimer.unref();

module.exports = { consumeRateLimit, pruneRateLimits };
