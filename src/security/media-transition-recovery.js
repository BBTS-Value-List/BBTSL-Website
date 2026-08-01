const SITE_STATE_KEY = "__system/site-state.json";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const LIVE_MEDIA_FIELDS = [
  "image_key",
  "detail_image_key",
  "slash_media_key",
  "slash_audio_key",
  "finisher_media_key"
];

export async function recoverIncompleteQuarantineTransitions(env, options = {}) {
  requireEnvironment(env);
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const limit = normalizeLimit(options.limit);
  const { results } = await env.DB.prepare(`
    SELECT id, base_key, audit_log_id, status, descriptor_json, purge_after
    FROM media_quarantine
    WHERE status IN ('pending', 'copying', 'failed', 'restoring')
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).bind(limit).all();

  const summary = { recovered: 0, unavailable: 0, skippedLive: 0 };
  for (const manifest of results || []) {
    await options.lock?.assertActive?.();
    const state = await loadState(env);
    if (isBaseKeyLive(state, manifest.base_key)) {
      await updateManifestStatus(env, manifest.id, "restored", now, null);
      summary.skippedLive += 1;
      continue;
    }

    const descriptor = parseDescriptor(manifest.descriptor_json);
    const objects = await loadManifestObjects(env, manifest.id);
    let unavailable = false;

    for (const row of objects) {
      const privateCopy = await env.MEDIA_QUARANTINE_BUCKET.get(row.quarantine_key);
      if (privateCopy) {
        if (row.copy_status !== "copied") {
          await updateObjectStatus(env, manifest.id, row.live_key, "copied", now, null);
        }
        continue;
      }

      const liveCopy = await env.MEDIA_BUCKET.get(row.live_key);
      if (!liveCopy) {
        await updateObjectStatus(env, manifest.id, row.live_key, "missing", now, "Both live and quarantine copies are missing.");
        unavailable = true;
        break;
      }

      try {
        await env.MEDIA_QUARANTINE_BUCKET.put(
          row.quarantine_key,
          liveCopy.body || await liveCopy.arrayBuffer(),
          {
            httpMetadata: liveCopy.httpMetadata,
            customMetadata: liveCopy.customMetadata
          }
        );
        await updateObjectStatus(env, manifest.id, row.live_key, "copied", now, null);
      } catch (error) {
        await updateObjectStatus(env, manifest.id, row.live_key, "failed", now, String(error?.message || error));
        await updateManifestStatus(env, manifest.id, "failed", now, String(error?.message || error));
        throw error;
      }
    }

    if (unavailable) {
      await updateManifestStatus(env, manifest.id, "unavailable", now, "Required media copy is missing.");
      if (manifest.audit_log_id) {
        await updateAuditStatus(env, manifest.audit_log_id, "unavailable");
      }
      summary.unavailable += 1;
      continue;
    }

    const stateChanged = removeDescriptorFromState(state, manifest.base_key, descriptor);
    if (stateChanged) {
      await options.lock?.assertActive?.();
      await writeState(env, state);
    }

    for (const row of objects) {
      await options.lock?.assertActive?.();
      await env.MEDIA_BUCKET.delete(row.live_key);
    }
    await updateManifestStatus(env, manifest.id, "quarantined", now, null);
    if (manifest.audit_log_id) {
      await updateAuditStatus(env, manifest.audit_log_id, "available");
    }
    summary.recovered += 1;
  }
  return summary;
}

async function loadManifestObjects(env, manifestId) {
  const { results } = await env.DB.prepare(`
    SELECT quarantine_id, live_key, quarantine_key, copy_status
    FROM media_quarantine_objects
    WHERE quarantine_id = ?
    ORDER BY live_key ASC
  `).bind(manifestId).all();
  return results || [];
}

async function loadState(env) {
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) throw new Error("Site state is unavailable while recovering media quarantine.");
  return JSON.parse(await object.text());
}

async function writeState(env, state) {
  await env.MEDIA_BUCKET.put(SITE_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

function isBaseKeyLive(state, baseKey) {
  for (const row of [...(state?.swords || []), ...(state?.baseline || [])]) {
    for (const field of LIVE_MEDIA_FIELDS) {
      if (row?.[field] === baseKey) return true;
    }
  }
  return false;
}

function removeDescriptorFromState(state, baseKey, descriptor) {
  state.mediaVariants = state.mediaVariants || {};
  state.mediaObjects = state.mediaObjects || {};
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(state.mediaVariants, baseKey)) {
    delete state.mediaVariants[baseKey];
    changed = true;
  }

  let removedBytes = 0;
  for (const key of Object.keys(descriptor.objects || {})) {
    const record = state.mediaObjects[key];
    if (!record) continue;
    removedBytes += Math.max(0, Number(record?.sizeBytes || 0));
    delete state.mediaObjects[key];
    changed = true;
  }
  if (changed) {
    state.usage = {
      ...(state.usage || {}),
      monthly: state.usage?.monthly || {},
      totalStorageBytes: Math.max(0, Number(state.usage?.totalStorageBytes || 0) - removedBytes)
    };
  }
  return changed;
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

function parseDescriptor(value) {
  try {
    const descriptor = typeof value === "string" ? JSON.parse(value) : value;
    if (!descriptor || typeof descriptor !== "object" || !descriptor.objects) {
      throw new Error("descriptor is incomplete");
    }
    return descriptor;
  } catch (error) {
    throw new Error(`Quarantine descriptor is invalid: ${error.message}`);
  }
}

function requireEnvironment(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") throw new TypeError("D1 is required for quarantine recovery.");
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function") throw new TypeError("MEDIA_BUCKET is required for quarantine recovery.");
  if (!env?.MEDIA_QUARANTINE_BUCKET || typeof env.MEDIA_QUARANTINE_BUCKET.get !== "function") {
    throw new TypeError("MEDIA_QUARANTINE_BUCKET is required for quarantine recovery.");
  }
}

function normalizeTimestamp(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError("Quarantine recovery timestamp is invalid.");
  return new Date(time).toISOString();
}

function normalizeLimit(value) {
  const number = value === undefined || value === null ? DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LIMIT) {
    throw new TypeError("Quarantine recovery limit is invalid.");
  }
  return number;
}
