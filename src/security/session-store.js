const SESSION_MODES = new Set(["user", "system"]);
const DEFAULT_CLEANUP_LIMIT = 100;
const MAX_CLEANUP_LIMIT = 1_000;

export async function hashSessionId(rawSessionId) {
  const normalized = normalizeSessionId(rawSessionId);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function createSession(env, record) {
  const database = requireDatabase(env);
  const sessionIdHash = await hashSessionId(record?.sessionId);
  const userId = normalizeUserId(record?.userId);
  const issuedAt = normalizeTimestamp(record?.issuedAt, "issuedAt");
  const expiresAt = normalizeTimestamp(record?.expiresAt, "expiresAt");
  const reauthAt = normalizeTimestamp(record?.reauthAt, "reauthAt");
  const mode = normalizeMode(record?.mode);
  if (expiresAt <= issuedAt) {
    throw new TypeError("Session expiry must be later than issuance.");
  }

  await database.prepare(`
    INSERT INTO sessions (
      session_id_hash,
      user_id,
      issued_at,
      expires_at,
      reauth_at,
      mode,
      revoked_at,
      revoke_reason
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `).bind(sessionIdHash, userId, issuedAt, expiresAt, reauthAt, mode).run();

  return {
    sessionIdHash,
    userId,
    issuedAt,
    expiresAt,
    reauthAt,
    mode
  };
}

export async function loadActiveSession(env, rawSessionId, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const sessionIdHash = await hashSessionId(rawSessionId);
  const row = await database.prepare(`
    SELECT session_id_hash, user_id, issued_at, expires_at, reauth_at, mode, revoked_at, revoke_reason
    FROM sessions
    WHERE session_id_hash = ?
  `).bind(sessionIdHash).first();
  if (!row || row.revoked_at) {
    return null;
  }

  const nowIso = normalizeTimestamp(now, "now");
  if (String(row.expires_at || "") <= nowIso) {
    return null;
  }

  return serializeSessionRow(row);
}

export async function revokeSession(env, rawSessionId, reason, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const sessionIdHash = await hashSessionId(rawSessionId);
  const revokedAt = normalizeTimestamp(now, "now");
  const normalizedReason = normalizeReason(reason);
  const result = await database.prepare(`
    UPDATE sessions
    SET revoked_at = ?, revoke_reason = ?
    WHERE session_id_hash = ? AND revoked_at IS NULL
  `).bind(revokedAt, normalizedReason, sessionIdHash).run();
  return getChanges(result) > 0;
}

export async function revokeUserSessions(env, userId, reason, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const revokedAt = normalizeTimestamp(now, "now");
  const normalizedReason = normalizeReason(reason);
  const result = await database.prepare(`
    UPDATE sessions
    SET revoked_at = ?, revoke_reason = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(revokedAt, normalizedReason, normalizeUserId(userId)).run();
  return getChanges(result);
}

export async function deleteExpiredSessions(env, now = new Date().toISOString(), limit = DEFAULT_CLEANUP_LIMIT) {
  const database = requireDatabase(env);
  const nowIso = normalizeTimestamp(now, "now");
  const boundedLimit = normalizeCleanupLimit(limit);
  const result = await database.prepare(`
    DELETE FROM sessions
    WHERE session_id_hash IN (
      SELECT session_id_hash
      FROM sessions
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, session_id_hash ASC
      LIMIT ?
    )
  `).bind(nowIso, boundedLimit).run();
  return getChanges(result);
}

function serializeSessionRow(row) {
  return {
    sessionIdHash: String(row.session_id_hash),
    userId: Number(row.user_id),
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    reauthAt: String(row.reauth_at),
    mode: normalizeMode(row.mode)
  };
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("A D1 database binding is required for sessions.");
  }
  return env.DB;
}

function normalizeSessionId(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Session ID is invalid.");
  }
  return value;
}

function normalizeUserId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError("Session user ID is invalid.");
  }
  return number;
}

function normalizeTimestamp(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`Session ${label} timestamp is invalid.`);
  }
  return timestamp.toISOString();
}

function normalizeMode(value) {
  const normalized = String(value || "user");
  if (!SESSION_MODES.has(normalized)) {
    throw new TypeError("Session mode is invalid.");
  }
  return normalized;
}

function normalizeReason(value) {
  const normalized = String(value || "revoked").trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError("Session revocation reason is invalid.");
  }
  return normalized;
}

function normalizeCleanupLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_CLEANUP_LIMIT) {
    throw new TypeError("Session cleanup limit is invalid.");
  }
  return number;
}

function getChanges(result) {
  return Math.max(0, Number(result?.meta?.changes ?? result?.changes ?? 0));
}
