export const REVERT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const ENRICH_QUERY_CHUNK_SIZE = 90;
const REVERTIBLE_STATUSES = new Set(["pending", "available", "reverted"]);
const MEDIA_KEY_LIMIT = 512;

export class AuditRetentionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuditRetentionError";
    this.status = status;
  }
}

export function getRevertExpiry(createdAt) {
  return new Date(parseTimestamp(createdAt, "audit creation") + REVERT_RETENTION_MS).toISOString();
}

export function classifyAuditLifecycle(row, now = new Date().toISOString()) {
  const nowMs = parseTimestamp(now, "current time");
  const createdMs = parseTimestamp(row?.created_at, "audit creation");
  if (nowMs >= createdMs + AUDIT_RETENTION_MS) {
    return { operation: "delete" };
  }

  const reversible = isRevertibleAction(row?.action_type);
  const revertExpiresAt = row?.revert_expires_at
    ? new Date(parseTimestamp(row.revert_expires_at, "revert expiry")).toISOString()
    : new Date(createdMs + REVERT_RETENTION_MS).toISOString();

  if (nowMs >= Date.parse(revertExpiresAt)) {
    return {
      operation: reversible ? "expire" : "dispose",
      ...(reversible ? { revertExpiresAt, revertStatus: "expired" } : { revertStatus: "not_applicable" })
    };
  }

  if (!reversible) {
    return { operation: "not_applicable", revertStatus: "not_applicable" };
  }

  return {
    operation: "activate",
    revertExpiresAt,
    revertStatus: row?.before_json ? normalizeActiveStatus(row?.revert_status) : "unavailable"
  };
}

export function isAuditRevertible(row, now = new Date().toISOString()) {
  if (!isRevertibleAction(row?.action_type)) return false;
  if (!row?.before_json || row?.snapshots_disposed_at) return false;
  if (!REVERTIBLE_STATUSES.has(String(row?.revert_status || ""))) return false;
  if (!row?.revert_expires_at) return false;
  return parseTimestamp(now, "current time") < parseTimestamp(row.revert_expires_at, "revert expiry");
}

export function extractAuditMediaKeys(...snapshots) {
  const keys = new Set();
  for (const snapshot of snapshots) {
    collectMediaKeys(parseSnapshot(snapshot), keys);
  }
  return keys;
}

export async function recordAuditMediaRefs(env, auditLogId, ...snapshots) {
  const database = requireDatabase(env);
  const id = normalizePositiveInteger(auditLogId, "audit log ID");
  const keys = [...extractAuditMediaKeys(...snapshots)].sort();
  if (typeof database.batch !== "function") {
    throw new TypeError("D1 batch support is required for audit media references.");
  }
  const statements = [database.prepare("DELETE FROM audit_media_refs WHERE audit_log_id = ?").bind(id)];
  for (const key of keys) {
    statements.push(database.prepare(`
      INSERT INTO audit_media_refs (audit_log_id, base_key)
      VALUES (?, ?)
      ON CONFLICT(audit_log_id, base_key) DO NOTHING
    `).bind(id, key));
  }
  await database.batch(statements);
  return keys;
}

export async function migrateAuditLifecycle(env, now = new Date().toISOString(), limit = DEFAULT_BATCH_LIMIT) {
  const database = requireDatabase(env);
  const nowIso = normalizeTimestamp(now, "current time");
  const batchLimit = normalizeLimit(limit);
  const deleteCutoff = new Date(Date.parse(nowIso) - AUDIT_RETENTION_MS).toISOString();
  const snapshotCutoff = new Date(Date.parse(nowIso) - REVERT_RETENTION_MS).toISOString();
  const { results } = await database.prepare(`
    SELECT id, action_type, created_at, before_json, after_json,
           revert_expires_at, revert_status, snapshots_disposed_at
    FROM audit_logs
    WHERE created_at <= ?
       OR (created_at <= ? AND (before_json IS NOT NULL OR after_json IS NOT NULL))
       OR ((action_type LIKE 'sword.%' OR action_type = 'audit.revert')
           AND (revert_expires_at IS NULL OR revert_status = 'not_applicable'))
    ORDER BY id ASC
    LIMIT ?
  `).bind(deleteCutoff, snapshotCutoff, batchLimit).all();

  const summary = { activated: 0, expired: 0, disposed: 0, deleted: 0, unavailable: 0 };
  for (const row of results || []) {
    const plan = classifyAuditLifecycle(row, nowIso);
    if (plan.operation === "delete") {
      await database.prepare("DELETE FROM audit_logs WHERE id = ?").bind(row.id).run();
      summary.deleted += 1;
      continue;
    }
    if (plan.operation === "expire" || plan.operation === "dispose") {
      await database.prepare(`
        UPDATE audit_logs
        SET before_json = NULL,
            after_json = NULL,
            revert_expires_at = ?,
            revert_status = ?,
            snapshots_disposed_at = COALESCE(snapshots_disposed_at, ?)
        WHERE id = ?
      `).bind(
        plan.revertExpiresAt || null,
        plan.revertStatus,
        nowIso,
        row.id
      ).run();
      await database.prepare("DELETE FROM audit_media_refs WHERE audit_log_id = ?").bind(row.id).run();
      summary[plan.operation === "expire" ? "expired" : "disposed"] += 1;
      continue;
    }
    if (plan.operation === "activate") {
      await database.prepare(`
        UPDATE audit_logs
        SET revert_expires_at = ?, revert_status = ?
        WHERE id = ?
      `).bind(plan.revertExpiresAt, plan.revertStatus, row.id).run();
      await recordAuditMediaRefs(env, row.id, row.before_json, row.after_json);
      summary.activated += 1;
      if (plan.revertStatus === "unavailable") summary.unavailable += 1;
    }
  }
  return summary;
}

export async function disposeExpiredAuditSnapshots(env, now = new Date().toISOString(), limit = DEFAULT_BATCH_LIMIT) {
  const database = requireDatabase(env);
  const nowIso = normalizeTimestamp(now, "current time");
  const batchLimit = normalizeLimit(limit);
  const { results } = await database.prepare(`
    SELECT id, action_type, created_at, before_json, after_json,
           revert_expires_at, revert_status, snapshots_disposed_at
    FROM audit_logs
    WHERE (before_json IS NOT NULL OR after_json IS NOT NULL)
      AND created_at <= ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(new Date(Date.parse(nowIso) - REVERT_RETENTION_MS).toISOString(), batchLimit).all();
  let disposed = 0;
  for (const row of results || []) {
    const plan = classifyAuditLifecycle(row, nowIso);
    if (plan.operation !== "expire" && plan.operation !== "dispose" && plan.operation !== "delete") continue;
    await database.prepare(`
      UPDATE audit_logs
      SET before_json = NULL,
          after_json = NULL,
          revert_expires_at = ?,
          revert_status = ?,
          snapshots_disposed_at = COALESCE(snapshots_disposed_at, ?)
      WHERE id = ?
    `).bind(plan.revertExpiresAt || null, plan.revertStatus || "not_applicable", nowIso, row.id).run();
    await database.prepare("DELETE FROM audit_media_refs WHERE audit_log_id = ?").bind(row.id).run();
    disposed += 1;
  }
  return disposed;
}

export async function deleteExpiredAuditLogs(env, now = new Date().toISOString(), limit = DEFAULT_BATCH_LIMIT) {
  const database = requireDatabase(env);
  const cutoff = new Date(parseTimestamp(now, "current time") - AUDIT_RETENTION_MS).toISOString();
  const result = await database.prepare(`
    DELETE FROM audit_logs
    WHERE id IN (
      SELECT id
      FROM audit_logs
      WHERE created_at <= ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    )
  `).bind(cutoff, normalizeLimit(limit)).run();
  return getChanges(result);
}

export async function authorizeAuditRevertRequest(request, env, now = new Date().toISOString()) {
  const body = await request.clone().json().catch(() => ({}));
  const logId = normalizePositiveInteger(body?.logId, "audit log ID");
  const row = await requireDatabase(env).prepare(`
    SELECT id, action_type, created_at, before_json, after_json,
           revert_expires_at, revert_status, snapshots_disposed_at
    FROM audit_logs
    WHERE id = ?
  `).bind(logId).first();
  if (!row) throw new AuditRetentionError(404, "Audit log not found.");

  const plan = classifyAuditLifecycle(row, now);
  if (plan.operation === "delete" || plan.operation === "expire" || plan.operation === "dispose") {
    throw new AuditRetentionError(410, "This audit entry is no longer revertible.");
  }
  const effective = {
    ...row,
    revert_expires_at: row.revert_expires_at || plan.revertExpiresAt,
    revert_status: row.revert_status === "not_applicable" ? plan.revertStatus : row.revert_status
  };
  if (effective.revert_status === "unavailable") {
    throw new AuditRetentionError(409, "The historical data required for this revert is unavailable.");
  }
  if (!isAuditRevertible(effective, now)) {
    throw new AuditRetentionError(410, "This audit entry is no longer revertible.");
  }
  return effective;
}

export async function enrichAuditResponse(request, response, env, now = new Date().toISOString()) {
  if (
    request.method !== "GET"
    || new URL(request.url).pathname !== "/api/audit"
    || response.status < 200
    || response.status >= 300
    || !String(response.headers.get("content-type") || "").includes("application/json")
  ) {
    return response;
  }
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  const logs = Array.isArray(payload?.logs) ? payload.logs : [];
  const ids = logs.map((log) => Number(log?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return response;
  let lifecycle;
  try {
    lifecycle = await loadAuditLifecycleRowsById(requireDatabase(env), ids);
  } catch (error) {
    if (isMissingAuditLifecycleSchemaError(error)) {
      console.warn("Audit lifecycle enrichment skipped because the production D1 schema is behind migrations.");
      return response;
    }
    throw error;
  }
  payload.logs = logs.map((log) => {
    const row = lifecycle.get(Number(log.id));
    if (!row) return log;
    const plan = classifyAuditLifecycle(row, now);
    const effective = {
      ...row,
      revert_expires_at: row.revert_expires_at || plan.revertExpiresAt || null,
      revert_status: row.revert_status === "not_applicable" && plan.revertStatus
        ? plan.revertStatus
        : row.revert_status
    };
    return {
      ...log,
      revertStatus: effective.revert_status || "not_applicable",
      revertExpiresAt: effective.revert_expires_at || null,
      snapshotsDisposedAt: effective.snapshots_disposed_at || null,
      canRevert: isAuditRevertible(effective, now)
    };
  });
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function loadAuditLifecycleRowsById(database, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += ENRICH_QUERY_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + ENRICH_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await database.prepare(`
      SELECT id, action_type, created_at, before_json, after_json,
             revert_expires_at, revert_status, snapshots_disposed_at
      FROM audit_logs
      WHERE id IN (${placeholders})
    `).bind(...chunk).all();
    rows.push(...(results || []));
  }
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function isMissingAuditLifecycleSchemaError(error) {
  const message = String(error?.message || error || "");
  return /audit_logs|audit_media_refs|revert_expires_at|revert_status|snapshots_disposed_at|no such table|no such column/i.test(message);
}

function isRevertibleAction(value) {
  const action = String(value || "");
  return action.startsWith("sword.") || action === "audit.revert";
}

function normalizeActiveStatus(value) {
  const status = String(value || "");
  return REVERTIBLE_STATUSES.has(status) ? status : "pending";
}

function collectMediaKeys(value, keys) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMediaKeys(entry, keys));
    return;
  }
  if (!value || typeof value !== "object") return;
  const key = normalizeMediaKey(value.key);
  if (key) keys.add(key);
  Object.values(value).forEach((entry) => collectMediaKeys(entry, keys));
}

function parseSnapshot(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMediaKey(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > MEDIA_KEY_LIMIT) return "";
  if (normalized === "__system" || normalized.startsWith("__system/")) return "";
  if (normalized.startsWith("/") || normalized.includes("\\") || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  if (normalized.split("/").some((segment) => segment === "." || segment === ".." || !segment)) return "";
  return normalized;
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("A D1 database binding is required for audit retention.");
  }
  return env.DB;
}

function normalizeTimestamp(value, label) {
  return new Date(parseTimestamp(value, label)).toISOString();
}

function parseTimestamp(value, label) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError(`${label} timestamp is invalid.`);
  return time;
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} is invalid.`);
  return number;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_BATCH_LIMIT) {
    throw new TypeError("Audit retention batch limit is invalid.");
  }
  return number;
}

function getChanges(result) {
  return Math.max(0, Number(result?.meta?.changes ?? result?.changes ?? 0));
}
