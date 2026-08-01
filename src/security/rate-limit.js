const RATE_LIMIT_TABLE = "request_rate_limits_v2";
const CLEANUP_INTERVAL_SECONDS = 60;
const nextCleanupAtByDatabase = new WeakMap();

export async function consumeAtomicRateLimit(database, bucket, key, limit, windowSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  validateArguments(database, bucket, key, limit, windowSeconds, nowSeconds);
  await cleanupExpiredRowsWhenDue(database, nowSeconds);

  const expiresAt = nowSeconds + windowSeconds;
  let row;
  try {
    row = await database.prepare(`
      INSERT INTO ${RATE_LIMIT_TABLE} (bucket, client_key, window_start, request_count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(bucket, client_key) DO UPDATE SET
        window_start = CASE
          WHEN ${RATE_LIMIT_TABLE}.expires_at <= excluded.window_start THEN excluded.window_start
          ELSE ${RATE_LIMIT_TABLE}.window_start
        END,
        request_count = CASE
          WHEN ${RATE_LIMIT_TABLE}.expires_at <= excluded.window_start THEN 1
          ELSE ${RATE_LIMIT_TABLE}.request_count + 1
        END,
        expires_at = CASE
          WHEN ${RATE_LIMIT_TABLE}.expires_at <= excluded.window_start THEN excluded.expires_at
          ELSE ${RATE_LIMIT_TABLE}.expires_at
        END
      RETURNING request_count, window_start, expires_at
    `).bind(bucket, key, nowSeconds, expiresAt).first();
  } catch (error) {
    if (!isMissingRateLimitSchemaError(error)) throw error;
    console.warn("Rate-limit state table is missing; allowing this request until migrations are applied.");
    return {
      allowed: true,
      requestCount: 1,
      windowStart: nowSeconds,
      retryAfter: windowSeconds,
      degraded: true
    };
  }

  if (!row) {
    throw new Error("Atomic rate-limit update returned no row.");
  }

  const requestCount = Number(row.request_count);
  const windowStart = Number(row.window_start);
  const storedExpiresAt = Number(row.expires_at);
  return {
    allowed: requestCount <= limit,
    requestCount,
    windowStart,
    retryAfter: Math.max(1, storedExpiresAt - nowSeconds)
  };
}

async function cleanupExpiredRowsWhenDue(database, nowSeconds) {
  const cleanupKey = database.__bbtslRateLimitKey && typeof database.__bbtslRateLimitKey === "object"
    ? database.__bbtslRateLimitKey
    : database;
  const nextCleanupAt = nextCleanupAtByDatabase.get(cleanupKey) || 0;
  if (nowSeconds < nextCleanupAt) {
    return;
  }
  nextCleanupAtByDatabase.set(cleanupKey, nowSeconds + CLEANUP_INTERVAL_SECONDS);
  try {
    await database.prepare(`
      DELETE FROM ${RATE_LIMIT_TABLE}
      WHERE expires_at <= ?
    `).bind(nowSeconds).run();
  } catch (error) {
    nextCleanupAtByDatabase.set(cleanupKey, nowSeconds + 5);
    if (!isMissingRateLimitSchemaError(error)) throw error;
  }
}

function isMissingRateLimitSchemaError(error) {
  return /request_rate_limits_v2|no such table|no such column/i.test(String(error?.message || error || ""));
}

function validateArguments(database, bucket, key, limit, windowSeconds, nowSeconds) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("A D1-compatible database is required.");
  }
  if (typeof bucket !== "string" || !bucket || bucket.length > 80) {
    throw new TypeError("Rate-limit bucket is invalid.");
  }
  if (typeof key !== "string" || !key || key.length > 240) {
    throw new TypeError("Rate-limit key is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Rate-limit count is invalid.");
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new TypeError("Rate-limit window is invalid.");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError("Rate-limit timestamp is invalid.");
  }
}
