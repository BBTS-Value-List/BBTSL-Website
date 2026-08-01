import { extractAuditMediaKeys, REVERT_RETENTION_MS } from "./audit-retention.js";

const SITE_STATE_KEY = "__system/site-state.json";
const DEFAULT_STAGING_GRACE_MS = 15 * 60 * 1_000;
const DEFAULT_BATCH_LIMIT = 8;
const MAX_BATCH_LIMIT = 50;
const SWORD_MEDIA_FIELDS = [
  "image_key",
  "detail_image_key",
  "slash_media_key",
  "slash_audio_key",
  "finisher_media_key"
];

export function buildDetachedMediaPlan(state, options = {}) {
  const nowMs = parseTimestamp(options.now || new Date().toISOString(), "current time");
  const graceMs = normalizeNonNegativeInteger(options.graceMs, DEFAULT_STAGING_GRACE_MS);
  const liveBaseKeys = collectLiveBaseKeys(state);
  const plan = [];

  for (const [baseKey, variant] of Object.entries(state?.mediaVariants || {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (liveBaseKeys.has(baseKey)) continue;
    const updatedAt = Date.parse(String(variant?.updatedAt || ""));
    if (graceMs > 0 && Number.isFinite(updatedAt) && updatedAt > nowMs - graceMs) continue;
    const objectKeys = [...new Set([
      variant?.lowKey,
      variant?.mediumKey,
      variant?.originalKey
    ].filter((key) => typeof key === "string" && key))];
    const objects = {};
    let sizeBytes = 0;
    for (const key of objectKeys) {
      const record = state?.mediaObjects?.[key] || { mediaKey: key, sizeBytes: 0 };
      objects[key] = structuredClone(record);
      sizeBytes += Math.max(0, Number(record?.sizeBytes || 0));
    }
    plan.push({
      baseKey,
      variant: structuredClone(variant),
      objectKeys,
      objects,
      sizeBytes,
      updatedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null
    });
  }
  return plan;
}

export async function reconcileDetachedMedia(env, actor = null, options = {}) {
  requireEnvironment(env);
  const now = normalizeTimestamp(options.now || new Date().toISOString(), "current time");
  const limit = normalizeLimit(options.limit || DEFAULT_BATCH_LIMIT);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();
  const state = await loadState(env);
  const candidates = buildDetachedMediaPlan(state, { ...options, now }).slice(0, limit);
  let quarantined = 0;

  for (const candidate of candidates) {
    await options.lock?.assertActive?.();
    let manifest = await findActiveManifest(env, candidate.baseKey);
    const audit = await findAuditProtection(env, candidate.baseKey, now);
    if (!manifest) {
      const id = String(idFactory());
      const purgeAfter = audit?.revert_expires_at
        ? normalizeTimestamp(audit.revert_expires_at, "revert expiry")
        : getUnprotectedPurgeAfter(candidate, now, Boolean(options.migrationMode));
      const descriptor = {
        baseKey: candidate.baseKey,
        variant: candidate.variant,
        objects: candidate.objects,
        sizeBytes: candidate.sizeBytes
      };
      await env.DB.prepare(`
        INSERT INTO media_quarantine (
          id, base_key, audit_log_id, reason, status, descriptor_json,
          quarantined_at, purge_after, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        candidate.baseKey,
        audit?.audit_log_id || null,
        audit ? "audit_detach" : "orphaned_upload",
        "pending",
        JSON.stringify(descriptor),
        now,
        purgeAfter,
        now
      ).run();
      for (const key of candidate.objectKeys) {
        const record = candidate.objects[key] || {};
        await env.DB.prepare(`
          INSERT INTO media_quarantine_objects (
            quarantine_id, live_key, quarantine_key, size_bytes,
            content_type, etag, copy_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(quarantine_id, live_key) DO NOTHING
        `).bind(
          id,
          key,
          buildQuarantineKey(id, key),
          Math.max(0, Number(record.sizeBytes || 0)),
          record.contentType || candidate.variant?.contentType || null,
          null,
          "pending"
        ).run();
      }
      manifest = {
        id,
        base_key: candidate.baseKey,
        audit_log_id: audit?.audit_log_id || null,
        status: "pending",
        descriptor_json: JSON.stringify(descriptor),
        purge_after: purgeAfter
      };
    }

    try {
      await completeQuarantineManifest(env, manifest, state, options, now);
      quarantined += 1;
      if (manifest.audit_log_id) {
        await updateAuditStatus(env, manifest.audit_log_id, "available");
      }
    } catch (error) {
      await updateManifestStatus(env, manifest.id, "failed", now, String(error?.message || error));
      throw error;
    }
  }

  return { quarantined, candidates: candidates.length };
}

export async function restoreSnapshotMedia(env, snapshot, options = {}) {
  requireEnvironment(env);
  const now = normalizeTimestamp(options.now || new Date().toISOString(), "current time");
  const state = await loadState(env);
  const requiredKeys = [...extractAuditMediaKeys(snapshot)];
  const restoredManifests = [];
  let restored = 0;

  for (const baseKey of requiredKeys) {
    if (state.mediaVariants?.[baseKey] || state.mediaObjects?.[baseKey]) continue;
    const manifest = await findActiveManifest(env, baseKey);
    if (!manifest || manifest.status === "purged" || manifest.status === "unavailable" || manifest.purge_after <= now) {
      throw new Error(`Historical media ${baseKey} is unavailable.`);
    }
    const descriptor = parseDescriptor(manifest.descriptor_json);
    const objectRows = await loadManifestObjects(env, manifest.id);
    for (const row of objectRows) {
      const source = await env.MEDIA_QUARANTINE_BUCKET.get(row.quarantine_key);
      if (!source) throw new Error(`Historical media object ${row.live_key} is unavailable.`);
      await env.MEDIA_BUCKET.put(row.live_key, source.body || await source.arrayBuffer(), {
        httpMetadata: source.httpMetadata,
        customMetadata: source.customMetadata
      });
      await updateObjectStatus(env, manifest.id, row.live_key, "restored", now, null);
    }
    state.mediaVariants = state.mediaVariants || {};
    state.mediaObjects = state.mediaObjects || {};
    state.mediaVariants[baseKey] = structuredClone(descriptor.variant);
    let addedBytes = 0;
    for (const [key, record] of Object.entries(descriptor.objects || {})) {
      if (!state.mediaObjects[key]) addedBytes += Math.max(0, Number(record?.sizeBytes || 0));
      state.mediaObjects[key] = structuredClone(record);
    }
    state.usage = normalizeUsage(state.usage);
    state.usage.totalStorageBytes += addedBytes;
    restoredManifests.push(manifest.id);
    restored += 1;
  }

  if (restored) {
    await options.lock?.assertActive?.();
    await writeState(env, state);
    for (const id of restoredManifests) {
      await updateManifestStatus(env, id, "restored", now, null);
    }
  }
  return { restored };
}

export async function purgeExpiredQuarantine(env, now = new Date().toISOString(), limit = DEFAULT_BATCH_LIMIT) {
  requireEnvironment(env);
  const nowIso = normalizeTimestamp(now, "current time");
  const { results } = await env.DB.prepare(`
    SELECT id, base_key, audit_log_id, status, descriptor_json, purge_after
    FROM media_quarantine
    WHERE purge_after <= ? AND status != 'purged'
    ORDER BY purge_after ASC, id ASC
    LIMIT ?
  `).bind(nowIso, normalizeLimit(limit)).all();
  let purged = 0;

  for (const manifest of results || []) {
    await updateManifestStatus(env, manifest.id, "purging", nowIso, null);
    const objects = await loadManifestObjects(env, manifest.id);
    for (const row of objects) {
      await env.MEDIA_QUARANTINE_BUCKET.delete(row.quarantine_key);
      await updateObjectStatus(env, manifest.id, row.live_key, "purged", nowIso, null);
    }
    await updateManifestStatus(env, manifest.id, "purged", nowIso, null);
    if (manifest.audit_log_id) {
      await env.DB.prepare(`
        UPDATE audit_logs
        SET before_json = NULL,
            after_json = NULL,
            revert_status = ?,
            snapshots_disposed_at = COALESCE(snapshots_disposed_at, ?)
        WHERE id = ?
      `).bind("expired", nowIso, manifest.audit_log_id).run();
      await env.DB.prepare("DELETE FROM audit_media_refs WHERE audit_log_id = ?")
        .bind(manifest.audit_log_id).run();
    }
    purged += 1;
  }
  return { purged };
}

export async function resumeIncompleteMediaTransitions(env, options = {}) {
  const now = options.now || new Date().toISOString();
  const reconcile = await reconcileDetachedMedia(env, null, options);
  const purge = await purgeExpiredQuarantine(env, now, options.limit || DEFAULT_BATCH_LIMIT);
  return { ...reconcile, ...purge };
}

async function completeQuarantineManifest(env, manifest, state, options, now) {
  const descriptor = parseDescriptor(manifest.descriptor_json);
  await updateManifestStatus(env, manifest.id, "copying", now, null);
  const rows = await loadManifestObjects(env, manifest.id);
  for (const row of rows) {
    if (row.copy_status === "copied") continue;
    const source = await env.MEDIA_BUCKET.get(row.live_key);
    if (!source) {
      await updateObjectStatus(env, manifest.id, row.live_key, "missing", now, "Live source object is missing.");
      if (manifest.audit_log_id) await updateAuditStatus(env, manifest.audit_log_id, "unavailable");
      throw new Error(`Live media object ${row.live_key} is missing.`);
    }
    try {
      await env.MEDIA_QUARANTINE_BUCKET.put(row.quarantine_key, source.body || await source.arrayBuffer(), {
        httpMetadata: source.httpMetadata,
        customMetadata: source.customMetadata
      });
    } catch (error) {
      await updateObjectStatus(env, manifest.id, row.live_key, "failed", now, String(error?.message || error));
      throw error;
    }
    await updateObjectStatus(env, manifest.id, row.live_key, "copied", now, null);
  }

  await options.lock?.assertActive?.();
  removeDescriptorFromState(state, manifest.base_key, descriptor);
  await writeState(env, state);
  for (const row of rows) {
    await options.lock?.assertActive?.();
    await env.MEDIA_BUCKET.delete(row.live_key);
  }
  await updateManifestStatus(env, manifest.id, "quarantined", now, null);
}

async function findActiveManifest(env, baseKey) {
  return env.DB.prepare(`
    SELECT id, base_key, audit_log_id, status, descriptor_json, purge_after
    FROM media_quarantine
    WHERE base_key = ?
      AND status IN ('pending', 'copying', 'quarantined', 'restoring', 'failed')
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(baseKey).first();
}

async function findAuditProtection(env, baseKey, now) {
  return env.DB.prepare(`
    SELECT audit_logs.id AS audit_log_id, audit_logs.revert_expires_at
    FROM audit_media_refs
    INNER JOIN audit_logs ON audit_logs.id = audit_media_refs.audit_log_id
    WHERE audit_media_refs.base_key = ?
      AND audit_logs.before_json IS NOT NULL
      AND audit_logs.snapshots_disposed_at IS NULL
      AND audit_logs.revert_expires_at > ?
    ORDER BY audit_logs.revert_expires_at DESC, audit_logs.id DESC
    LIMIT 1
  `).bind(baseKey, now).first();
}

async function loadManifestObjects(env, manifestId) {
  const { results } = await env.DB.prepare(`
    SELECT quarantine_id, live_key, quarantine_key, size_bytes,
           content_type, etag, copy_status, copied_at, restored_at, purged_at
    FROM media_quarantine_objects
    WHERE quarantine_id = ?
    ORDER BY live_key ASC
  `).bind(manifestId).all();
  return results || [];
}

async function updateObjectStatus(env, manifestId, liveKey, status, now, lastError) {
  await env.DB.prepare(`
    UPDATE media_quarantine_objects
    SET copy_status = ?,
        copied_at = CASE WHEN ? = 'copied' THEN ? ELSE copied_at END,
        restored_at = CASE WHEN ? = 'restored' THEN ? ELSE restored_at END,
        purged_at = CASE WHEN ? = 'purged' THEN ? ELSE purged_at END,
        last_error = ?
    WHERE quarantine_id = ? AND live_key = ?
  `).bind(status, status, now, status, now, status, now, lastError, manifestId, liveKey).run();
}

async function updateManifestStatus(env, id, status, now, lastError) {
  await env.DB.prepare(`
    UPDATE media_quarantine
    SET status = ?,
        updated_at = ?,
        last_error = ?,
        restored_at = CASE WHEN ? = 'restored' THEN ? ELSE restored_at END,
        purged_at = CASE WHEN ? = 'purged' THEN ? ELSE purged_at END
    WHERE id = ?
  `).bind(status, now, lastError, status, now, status, now, id).run();
}

async function updateAuditStatus(env, auditId, status) {
  await env.DB.prepare("UPDATE audit_logs SET revert_status = ? WHERE id = ?")
    .bind(status, auditId).run();
}

function removeDescriptorFromState(state, baseKey, descriptor) {
  state.mediaVariants = state.mediaVariants || {};
  state.mediaObjects = state.mediaObjects || {};
  delete state.mediaVariants[baseKey];
  let removedBytes = 0;
  for (const key of Object.keys(descriptor.objects || {})) {
    const record = state.mediaObjects[key];
    if (record) removedBytes += Math.max(0, Number(record.sizeBytes || 0));
    delete state.mediaObjects[key];
  }
  state.usage = normalizeUsage(state.usage);
  state.usage.totalStorageBytes = Math.max(0, state.usage.totalStorageBytes - removedBytes);
}

function collectLiveBaseKeys(state) {
  const keys = new Set();
  for (const row of [...(state?.swords || []), ...(state?.baseline || [])]) {
    for (const field of SWORD_MEDIA_FIELDS) {
      if (typeof row?.[field] === "string" && row[field]) keys.add(row[field]);
    }
  }
  return keys;
}

async function loadState(env) {
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) throw new Error("Site state is unavailable for media quarantine.");
  return JSON.parse(await object.text());
}

async function writeState(env, state) {
  await env.MEDIA_BUCKET.put(SITE_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

function buildQuarantineKey(manifestId, liveKey) {
  return `quarantine/${encodeURIComponent(manifestId)}/${encodeURIComponent(liveKey)}`;
}

function getUnprotectedPurgeAfter(candidate, now, migrationMode) {
  const nowMs = Date.parse(now);
  const origin = migrationMode && candidate.updatedAt ? Date.parse(candidate.updatedAt) : nowMs;
  const deadline = (Number.isFinite(origin) ? origin : nowMs) + REVERT_RETENTION_MS;
  return new Date(Math.max(nowMs, deadline)).toISOString();
}

function parseDescriptor(value) {
  try {
    const descriptor = typeof value === "string" ? JSON.parse(value) : value;
    if (!descriptor || typeof descriptor !== "object" || !descriptor.variant || !descriptor.objects) {
      throw new Error("Quarantine descriptor is incomplete.");
    }
    return descriptor;
  } catch (error) {
    throw new Error(`Quarantine descriptor is invalid: ${error.message}`);
  }
}

function normalizeUsage(value) {
  return {
    ...(value || {}),
    monthly: value?.monthly || {},
    totalStorageBytes: Math.max(0, Number(value?.totalStorageBytes || 0))
  };
}

function requireEnvironment(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") throw new TypeError("D1 is required for media quarantine.");
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function") throw new TypeError("MEDIA_BUCKET is required for media quarantine.");
  if (!env?.MEDIA_QUARANTINE_BUCKET || typeof env.MEDIA_QUARANTINE_BUCKET.get !== "function") {
    throw new TypeError("MEDIA_QUARANTINE_BUCKET is required for media quarantine.");
  }
}

function normalizeTimestamp(value, label) {
  return new Date(parseTimestamp(value, label)).toISOString();
}

function parseTimestamp(value, label) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError(`${label} timestamp is invalid.`);
  return time;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_BATCH_LIMIT) {
    throw new TypeError("Media quarantine batch limit is invalid.");
  }
  return number;
}
