const SITE_STATE_KEY = "__system/site-state.json";
const INITIALIZED_KEY = "public_media_registry_initialized";
const MEDIA_KEY_LIMIT = 512;

export class PublicMediaRegistryStateError extends Error {
  constructor(message = "Public media registry is unavailable.") {
    super(message);
    this.name = "PublicMediaRegistryStateError";
    this.status = 503;
  }
}

const SWORD_MEDIA_FIELDS = [
  "image_key",
  "detail_image_key",
  "slash_media_key",
  "slash_audio_key",
  "finisher_media_key"
];

export function collectLivePhysicalMediaKeys(state) {
  const keys = new Set();
  const variants = state?.mediaVariants || {};
  const objects = state?.mediaObjects || {};

  for (const row of [...(state?.swords || []), ...(state?.baseline || [])]) {
    for (const field of SWORD_MEDIA_FIELDS) {
      const baseKey = normalizeMediaKey(row?.[field]);
      if (!baseKey) continue;
      const variant = variants[baseKey];
      if (variant && typeof variant === "object") {
        for (const value of [variant.lowKey, variant.mediumKey, variant.originalKey]) {
          const physicalKey = normalizeMediaKey(value);
          if (physicalKey) keys.add(physicalKey);
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(objects, baseKey)) {
        keys.add(baseKey);
      }
    }
  }
  return keys;
}

export async function replacePublicMediaRegistry(env, state, options = {}) {
  const database = requireDatabase(env);
  const keys = [...collectLivePhysicalMediaKeys(state)].sort();
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const marker = buildReadyMarker(keys.length);
  await runRegistryReplacement(database, keys, now, database.prepare(`
    INSERT INTO security_maintenance_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).bind(INITIALIZED_KEY, JSON.stringify(marker), now));
  return { count: keys.length, initialized: true, blocked: false };
}

export async function initializePublicMediaRegistry(env, state = null, options = {}) {
  const database = requireDatabase(env);
  const existing = await readRegistryState(database);
  if (existing?.initialized === true && existing?.blocked !== true) {
    return { initialized: false, blocked: false };
  }
  if ((existing?.blocked === true || existing?.initializing === true) && options.allowBlockedRebuild !== true) {
    return { initialized: false, blocked: true };
  }

  let claimJson = "";
  if (!existing && options.allowBlockedRebuild !== true) {
    const now = normalizeTimestamp(options.now || new Date().toISOString());
    claimJson = JSON.stringify({
      initialized: false,
      initializing: true,
      blocked: true,
      claim: crypto.randomUUID()
    });
    const claim = await database.prepare(`
      INSERT INTO security_maintenance_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `).bind(INITIALIZED_KEY, claimJson, now).run();
    if (getChanges(claim) === 0) {
      return { initialized: false, blocked: true };
    }
  }

  try {
    let currentState = state;
    if (!currentState) {
      if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function") {
        throw new TypeError("MEDIA_BUCKET is required to initialize the public media registry.");
      }
      const object = await env.MEDIA_BUCKET.get(options.siteStateKey || SITE_STATE_KEY);
      currentState = object ? JSON.parse(await object.text()) : {};
    }
    if (!claimJson) {
      return replacePublicMediaRegistry(env, currentState, options);
    }
    return replaceClaimedPublicMediaRegistry(database, currentState, claimJson, options);
  } catch (error) {
    if (claimJson) {
      await database.prepare(`
        DELETE FROM security_maintenance_state
        WHERE key = ? AND value_json = ?
      `).bind(INITIALIZED_KEY, claimJson).run().catch(() => {});
    }
    throw error;
  }
}

export async function isPublicMediaKey(env, key) {
  const normalized = normalizeMediaKey(key);
  if (!normalized) return false;
  const database = requireDatabase(env);
  const state = await readRegistryState(database);
  if (state?.initialized !== true || state?.blocked === true || state?.initializing === true) {
    return false;
  }
  const row = await database.prepare(`
    SELECT media_key
    FROM public_media_registry
    WHERE media_key = ?
  `).bind(normalized).first();
  return Boolean(row?.media_key);
}

export async function removePublicMediaKeys(env, keys) {
  const database = requireDatabase(env);
  const normalized = [...new Set([...keys].map(normalizeMediaKey).filter(Boolean))];
  if (!normalized.length) return 0;
  if (typeof database.batch !== "function") {
    throw new TypeError("D1 batch support is required for public media registry updates.");
  }
  await database.batch(normalized.map((key) => database.prepare(
    "DELETE FROM public_media_registry WHERE media_key = ?"
  ).bind(key)));
  return normalized.length;
}

export async function updatePublicMediaRegistryDelta(env, changes = {}, options = {}) {
  const database = requireDatabase(env);
  if (typeof database.batch !== "function") {
    throw new TypeError("D1 batch support is required for public media registry updates.");
  }
  const registryState = await readRegistryState(database);
  if (registryState?.initialized !== true || registryState?.initializing === true || registryState?.blocked === true) {
    throw new PublicMediaRegistryStateError();
  }
  const removeKeys = normalizeMediaKeys(changes.removeKeys || []);
  const addKeys = normalizeMediaKeys(changes.addKeys || []);
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const statements = [];
  for (const key of removeKeys) {
    statements.push(database.prepare("DELETE FROM public_media_registry WHERE media_key = ?").bind(key));
  }
  for (const key of addKeys) {
    statements.push(database.prepare(`
      INSERT INTO public_media_registry (media_key, updated_at)
      VALUES (?, ?)
      ON CONFLICT(media_key) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(key, now));
  }
  if (statements.length) await database.batch(statements);
  const countRow = await database.prepare("SELECT COUNT(*) AS count FROM public_media_registry").first();
  const count = Math.max(0, Number(countRow?.count || 0));
  return { added: addKeys.length, removed: removeKeys.length, count };
}

export async function clearPublicMediaRegistry(env, options = {}) {
  const database = requireDatabase(env);
  if (typeof database.batch !== "function") {
    throw new TypeError("D1 batch support is required for public media registry clearing.");
  }
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const results = await database.batch([
    database.prepare("DELETE FROM public_media_registry").bind(),
    database.prepare(`
      INSERT INTO security_maintenance_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).bind(INITIALIZED_KEY, JSON.stringify({
      initialized: true,
      initializing: false,
      blocked: true,
      count: 0
    }), now)
  ]);
  return getChanges(results?.[0]);
}

async function replaceClaimedPublicMediaRegistry(database, state, claimJson, options) {
  const keys = [...collectLivePhysicalMediaKeys(state)].sort();
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const marker = buildReadyMarker(keys.length);
  const results = await runRegistryReplacement(database, keys, now, database.prepare(`
    UPDATE security_maintenance_state
    SET value_json = ?, updated_at = ?
    WHERE key = ? AND value_json = ?
  `).bind(JSON.stringify(marker), now, INITIALIZED_KEY, claimJson));
  const finalized = getChanges(results.at(-1)) > 0;
  return {
    count: finalized ? keys.length : 0,
    initialized: finalized,
    blocked: !finalized
  };
}

async function runRegistryReplacement(database, keys, now, markerStatement) {
  if (typeof database.batch !== "function") {
    throw new TypeError("D1 batch support is required for public media registry replacement.");
  }
  const statements = [database.prepare("DELETE FROM public_media_registry").bind()];
  for (const key of keys) {
    statements.push(database.prepare(`
      INSERT INTO public_media_registry (media_key, updated_at)
      VALUES (?, ?)
    `).bind(key, now));
  }
  statements.push(markerStatement);
  return database.batch(statements);
}

async function readRegistryState(database) {
  const row = await database.prepare(`
    SELECT value_json
    FROM security_maintenance_state
    WHERE key = ?
  `).bind(INITIALIZED_KEY).first();
  return parseInitializationState(row?.value_json);
}

function buildReadyMarker(count) {
  return {
    initialized: true,
    initializing: false,
    blocked: false,
    count
  };
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("A D1 database binding is required for the public media registry.");
  }
  return env.DB;
}

function normalizeMediaKeys(values) {
  return [...new Set([...values].map(normalizeMediaKey).filter(Boolean))];
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

function normalizeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Public media registry timestamp is invalid.");
  }
  return date.toISOString();
}

function parseInitializationState(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getChanges(result) {
  return Math.max(0, Number(result?.meta?.changes ?? result?.changes ?? 0));
}
