const MAX_STAGE_IDS = 5;
const MAX_ID_LENGTH = 96;
const MAX_KEY_LENGTH = 160;
const VALID_VARIANTS = new Set(["card-image", "detail", "slash", "slash-audio", "finisher"]);

export class StagedMediaStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StagedMediaStoreError";
    this.status = status;
  }
}

export async function createStagedMedia(env, input) {
  const database = requireDatabase(env);
  const record = normalizeCreateInput(input);
  const row = await database.prepare(`
    INSERT INTO media_upload_staging (
      id, actor_user_id, variant, idempotency_key, base_key,
      descriptor_json, objects_json, size_bytes, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)
    ON CONFLICT(actor_user_id, variant, idempotency_key) DO UPDATE SET
      id = media_upload_staging.id
    RETURNING id, actor_user_id, variant, idempotency_key, base_key,
              descriptor_json, objects_json, size_bytes, status,
              created_at, expires_at, committed_at, commit_id
  `).bind(
    record.id,
    record.actorUserId,
    record.variant,
    record.idempotencyKey,
    record.baseKey,
    JSON.stringify(record.descriptor),
    JSON.stringify(record.objects),
    record.sizeBytes,
    record.createdAt,
    record.expiresAt
  ).first();
  if (!row) throw new StagedMediaStoreError(500, "Could not record the staged media upload.");
  return serializeRow(row);
}

export async function getReusableStagedMedia(env, actorUserId, variant, idempotencyKey, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const actor = normalizeActorId(actorUserId);
  const normalizedVariant = normalizeVariant(variant);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const nowIso = normalizeTimestamp(now, "current time");
  const row = await database.prepare(`
    SELECT id, actor_user_id, variant, idempotency_key, base_key,
           descriptor_json, objects_json, size_bytes, status,
           created_at, expires_at, committed_at, commit_id
    FROM media_upload_staging
    WHERE actor_user_id = ? AND variant = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actor, normalizedVariant, key).first();
  if (!row || row.status !== "staged" || String(row.expires_at) <= nowIso) return null;
  return serializeRow(row);
}

export async function loadStagedMediaForCommit(env, references, actorUserId, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const actor = normalizeActorId(actorUserId);
  const nowIso = normalizeTimestamp(now, "current time");
  const normalizedReferences = normalizeReferences(references);
  const rows = [];
  for (const reference of normalizedReferences) {
    const row = await database.prepare(`
      SELECT id, actor_user_id, variant, idempotency_key, base_key,
             descriptor_json, objects_json, size_bytes, status,
             created_at, expires_at, committed_at, commit_id
      FROM media_upload_staging
      WHERE id = ?
      LIMIT 1
    `).bind(reference.id).first();
    if (!row) throw new StagedMediaStoreError(404, "Staged media was not found. Upload it again.");
    if (Number(row.actor_user_id) !== actor) throw new StagedMediaStoreError(403, "Staged media does not belong to the current editor.");
    if (row.variant !== reference.variant) throw new StagedMediaStoreError(400, "Staged media does not match the requested media field.");
    if (row.status === "committed") throw new StagedMediaStoreError(409, "Staged media was already committed.");
    if (row.status !== "staged") throw new StagedMediaStoreError(409, "Staged media is not available for commit.");
    if (String(row.expires_at) <= nowIso) throw new StagedMediaStoreError(410, "Staged media expired. Upload it again.");
    rows.push(serializeRow(row));
  }
  return rows;
}

export async function markStagedMediaCommitted(env, ids, actorUserId, commitId, now = new Date().toISOString()) {
  const database = requireDatabase(env);
  const normalizedIds = normalizeIds(ids);
  if (!normalizedIds.length) return 0;
  const actor = normalizeActorId(actorUserId);
  const commit = normalizeOpaqueId(commitId, "commit id");
  const committedAt = normalizeTimestamp(now, "commit time");
  const placeholders = normalizedIds.map(() => "?").join(", ");
  const result = await database.prepare(`
    UPDATE media_upload_staging
    SET status = 'committed', committed_at = ?, commit_id = ?
    WHERE actor_user_id = ?
      AND status = 'staged'
      AND id IN (${placeholders})
  `).bind(committedAt, commit, actor, ...normalizedIds).run();
  return getChanges(result);
}

export async function deleteExpiredStagedMedia(env, now = new Date().toISOString(), limit = 100) {
  const database = requireDatabase(env);
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.delete !== "function") {
    throw new TypeError("MEDIA_BUCKET is required for staged media cleanup.");
  }
  const nowIso = normalizeTimestamp(now, "current time");
  const boundedLimit = normalizeLimit(limit);
  const { results } = await database.prepare(`
    SELECT id, status, objects_json
    FROM media_upload_staging
    WHERE expires_at <= ?
    ORDER BY expires_at ASC, id ASC
    LIMIT ?
  `).bind(nowIso, boundedLimit).all();
  const rows = results || [];
  let deletedObjects = 0;
  for (const row of rows) {
    if (row.status === "committed") continue;
    for (const object of parseObjects(row.objects_json)) {
      await env.MEDIA_BUCKET.delete(object.mediaKey);
      deletedObjects += 1;
    }
  }
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(", ");
    await database.prepare(`DELETE FROM media_upload_staging WHERE id IN (${placeholders})`)
      .bind(...rows.map((row) => row.id)).run();
  }
  return { deletedObjects, deletedRows: rows.length };
}

function normalizeCreateInput(input) {
  if (!input || typeof input !== "object") throw new TypeError("A staged media record is required.");
  const objects = normalizeObjects(input.objects);
  const sizeBytes = objects.reduce((sum, object) => sum + object.sizeBytes, 0);
  if (Number(input.sizeBytes) !== sizeBytes) throw new TypeError("Staged media size does not match its objects.");
  return {
    id: normalizeOpaqueId(input.id, "staged media id"),
    actorUserId: normalizeActorId(input.actorUserId),
    variant: normalizeVariant(input.variant),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    baseKey: normalizeMediaKey(input.baseKey),
    descriptor: normalizeDescriptor(input.descriptor),
    objects,
    sizeBytes,
    createdAt: normalizeTimestamp(input.createdAt, "creation time"),
    expiresAt: normalizeTimestamp(input.expiresAt, "expiry time")
  };
}

function normalizeReferences(references) {
  if (!Array.isArray(references) || references.length > MAX_STAGE_IDS) throw new StagedMediaStoreError(400, "Staged media references are invalid.");
  const seen = new Set();
  return references.map((reference) => {
    const id = normalizeOpaqueId(reference?.id, "staged media id");
    if (seen.has(id)) throw new StagedMediaStoreError(400, "A staged media upload cannot be used twice.");
    seen.add(id);
    return { id, variant: normalizeVariant(reference?.variant) };
  });
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_STAGE_IDS) throw new TypeError("Staged media ids are invalid.");
  return [...new Set(ids.map((id) => normalizeOpaqueId(id, "staged media id")))];
}

function normalizeObjects(objects) {
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > 3) throw new TypeError("Staged media objects are invalid.");
  const seen = new Set();
  return objects.map((object) => {
    const mediaKey = normalizeMediaKey(object?.mediaKey);
    if (seen.has(mediaKey)) throw new TypeError("Staged media objects contain duplicate keys.");
    seen.add(mediaKey);
    const sizeBytes = Number(object?.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError("Staged media object size is invalid.");
    return {
      mediaKey,
      contentType: normalizeContentType(object?.contentType),
      sizeBytes,
      updatedAt: normalizeTimestamp(object?.updatedAt, "object update time")
    };
  });
}

function normalizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new TypeError("Staged media descriptor is invalid.");
  return {
    baseKey: normalizeMediaKey(descriptor.baseKey),
    mediaKind: ["image", "video", "audio"].includes(descriptor.mediaKind) ? descriptor.mediaKind : (() => { throw new TypeError("Staged media kind is invalid."); })(),
    contentType: normalizeContentType(descriptor.contentType),
    lowKey: normalizeMediaKey(descriptor.lowKey),
    mediumKey: normalizeMediaKey(descriptor.mediumKey),
    originalKey: normalizeMediaKey(descriptor.originalKey),
    updatedAt: normalizeTimestamp(descriptor.updatedAt, "descriptor update time")
  };
}

function serializeRow(row) {
  return {
    id: String(row.id),
    actorUserId: Number(row.actor_user_id),
    variant: String(row.variant),
    idempotencyKey: String(row.idempotency_key),
    baseKey: String(row.base_key),
    descriptor: parseJson(row.descriptor_json, "descriptor"),
    objects: parseObjects(row.objects_json),
    sizeBytes: Number(row.size_bytes || 0),
    status: String(row.status),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    committedAt: row.committed_at ? String(row.committed_at) : null,
    commitId: row.commit_id ? String(row.commit_id) : null
  };
}

function parseObjects(value) {
  const objects = parseJson(value, "objects");
  return normalizeObjects(objects);
}

function parseJson(value, label) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new StagedMediaStoreError(500, `Staged media ${label} is corrupt.`);
  }
}

function normalizeActorId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError("Editor user id is invalid.");
  return number;
}

function normalizeVariant(value) {
  const variant = String(value || "").trim();
  if (!VALID_VARIANTS.has(variant)) throw new StagedMediaStoreError(400, "Media field is invalid.");
  return variant;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new StagedMediaStoreError(400, "Upload idempotency key is invalid.");
  return key;
}

function normalizeOpaqueId(value, label) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(id) || id.length > MAX_ID_LENGTH) throw new TypeError(`${label} is invalid.`);
  return id;
}

function normalizeMediaKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\\") || key.includes("..")) throw new TypeError("Staged media key is invalid.");
  return key;
}

function normalizeContentType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) || type.length > MAX_KEY_LENGTH) throw new TypeError("Staged media content type is invalid.");
  return type;
}

function normalizeTimestamp(value, label) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError(`Staged media ${label} is invalid.`);
  return new Date(time).toISOString();
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 500) throw new TypeError("Staged media cleanup limit is invalid.");
  return number;
}

function requireDatabase(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") throw new TypeError("D1 is required for staged media.");
  return env.DB;
}

function getChanges(result) {
  return Math.max(0, Number(result?.meta?.changes ?? result?.changes ?? 0));
}
