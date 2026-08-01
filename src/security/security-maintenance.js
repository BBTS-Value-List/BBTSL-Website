import {
  deleteExpiredAuditLogs,
  disposeExpiredAuditSnapshots,
  migrateAuditLifecycle
} from "./audit-retention.js";
import {
  purgeExpiredQuarantine,
  reconcileDetachedMedia
} from "./media-quarantine.js";
import { recoverIncompleteQuarantineTransitions } from "./media-transition-recovery.js";
import { initializePublicMediaRegistry } from "./public-media-registry.js";
import { deleteExpiredSessions } from "./session-store.js";
import { deleteExpiredStagedMedia } from "../media/staged-media-store.js";

const MAINTENANCE_STATE_KEY = "security_maintenance_last_run";
const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_MEDIA_LIMIT = 8;
const MAX_BATCH_LIMIT = 500;
const MAX_MEDIA_LIMIT = 50;

const DEFAULT_STAGES = {
  migrateAuditLifecycle,
  initializePublicMediaRegistry,
  recoverIncompleteQuarantineTransitions,
  reconcileDetachedMedia,
  purgeExpiredQuarantine,
  disposeExpiredAuditSnapshots,
  deleteExpiredAuditLogs,
  deleteExpiredStagedMedia,
  deleteExpiredSessions
};

export async function runSecurityMaintenance(env, options = {}) {
  requireEnvironment(env);
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const batchLimit = normalizeLimit(options.batchLimit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT, "maintenance batch");
  const mediaLimit = normalizeLimit(options.mediaLimit, DEFAULT_MEDIA_LIMIT, MAX_MEDIA_LIMIT, "media maintenance");
  const stages = { ...DEFAULT_STAGES, ...(options.stages || {}) };
  let stage = "starting";
  const summary = {};

  await writeMaintenanceState(env, {
    status: "running",
    stage,
    startedAt: now,
    updatedAt: now
  }, now);

  try {
    stage = "audit-migrate";
    summary.auditMigration = await stages.migrateAuditLifecycle(env, now, batchLimit);

    stage = "registry-init";
    summary.registry = await stages.initializePublicMediaRegistry(env, null, {
      now,
      allowBlockedRebuild: true
    });

    stage = "media-recover";
    await options.lock?.assertActive?.();
    summary.mediaRecovery = await stages.recoverIncompleteQuarantineTransitions(env, {
      now,
      limit: mediaLimit,
      lock: options.lock
    });

    stage = "media-reconcile";
    summary.mediaReconcile = await stages.reconcileDetachedMedia(env, null, {
      now,
      limit: mediaLimit,
      migrationMode: true,
      lock: options.lock
    });

    stage = "media-purge";
    summary.mediaPurge = await stages.purgeExpiredQuarantine(env, now, mediaLimit);

    stage = "audit-dispose";
    summary.auditDisposed = await stages.disposeExpiredAuditSnapshots(env, now, batchLimit);

    stage = "audit-delete";
    summary.auditDeleted = await stages.deleteExpiredAuditLogs(env, now, batchLimit);

    stage = "staged-media-delete";
    summary.stagedMediaDeleted = await stages.deleteExpiredStagedMedia(env, now, batchLimit);

    stage = "session-delete";
    summary.sessionsDeleted = await stages.deleteExpiredSessions(env, now, batchLimit);

    await writeMaintenanceState(env, {
      status: "completed",
      stage: "completed",
      startedAt: now,
      completedAt: new Date().toISOString(),
      summary
    }, now);
    return { ok: true, ...summary };
  } catch (error) {
    await writeMaintenanceState(env, {
      status: "failed",
      stage,
      startedAt: now,
      failedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500)
    }, now).catch(() => {});
    throw error;
  }
}

async function writeMaintenanceState(env, value, now) {
  await env.DB.prepare(`
    INSERT INTO security_maintenance_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).bind(MAINTENANCE_STATE_KEY, JSON.stringify(value), now).run();
}

function requireEnvironment(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("D1 is required for security maintenance.");
  }
  if (!env.MEDIA_BUCKET) {
    throw new TypeError("MEDIA_BUCKET is required for security maintenance.");
  }
  if (!env.MEDIA_QUARANTINE_BUCKET) {
    throw new TypeError("MEDIA_QUARANTINE_BUCKET is required for security maintenance.");
  }
}

function normalizeTimestamp(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError("Security maintenance timestamp is invalid.");
  return new Date(time).toISOString();
}

function normalizeLimit(value, fallback, maximum, label) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TypeError(`${label} limit is invalid.`);
  }
  return number;
}
