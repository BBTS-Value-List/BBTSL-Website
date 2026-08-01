import { createStagedMedia, getReusableStagedMedia } from "./staged-media-store.js";

const MEBIBYTE = 1024 * 1024;
const MAX_STAGE_BODY_BYTES = 24 * MEBIBYTE;
const STAGE_TTL_MS = 2 * 60 * 60 * 1000;
const VARIANTS = new Set(["card-image", "detail", "slash", "slash-audio", "finisher"]);
const MIME_TYPES = new Map([
  ["image/webp", { extension: "webp", kind: "image" }],
  ["image/png", { extension: "png", kind: "image" }],
  ["image/jpeg", { extension: "jpg", kind: "image" }],
  ["image/gif", { extension: "gif", kind: "image" }],
  ["video/mp4", { extension: "mp4", kind: "video" }],
  ["audio/mpeg", { extension: "mp3", kind: "audio" }],
  ["audio/x-mpeg", { extension: "mpeg", kind: "audio" }],
  ["audio/mpeg3", { extension: "mp3", kind: "audio" }],
  ["audio/mp3", { extension: "mp3", kind: "audio" }],
  ["audio/ogg", { extension: "ogg", kind: "audio" }],
  ["audio/wav", { extension: "wav", kind: "audio" }],
  ["audio/x-wav", { extension: "wav", kind: "audio" }]
]);

export class StagedMediaUploadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StagedMediaUploadError";
    this.status = status;
  }
}

export async function handleStagedMediaUpload(request, env, actor, options = {}) {
  const actorUserId = getActorUserId(actor);
  const variant = normalizeVariant(request.headers.get("x-bbtsl-media-variant"));
  const idempotencyKey = normalizeIdempotencyKey(request.headers.get("x-bbtsl-idempotency-key"));
  const swordName = normalizeSwordName(request.headers.get("x-bbtsl-sword-name"));
  const maxBodyBytes = normalizeBodyLimit(options.maxBodyBytes);
  rejectOversizedContentLength(request.headers.get("content-length"), maxBodyBytes);

  const findReusable = options.findReusable || getReusableStagedMedia;
  const existing = await findReusable(env, actorUserId, variant, idempotencyKey, options.now || new Date().toISOString());
  if (existing) return serializeResponse(existing, true);

  const boundedRequest = await createBoundedMultipartRequest(request, maxBodyBytes);
  const form = await boundedRequest.formData();
  const original = requireFile(form.get("original"), "original media");
  const originalInfo = validateFile(original, variant);
  const lowCandidate = form.get("low");
  const mediumCandidate = form.get("medium");
  const low = isFileLike(lowCandidate) ? lowCandidate : null;
  const medium = isFileLike(mediumCandidate) ? mediumCandidate : null;

  if (originalInfo.kind !== "image" && (low || medium)) {
    throw new StagedMediaUploadError(400, "Only images can include generated quality variants.");
  }
  if ((low && !medium) || (!low && medium)) {
    throw new StagedMediaUploadError(400, "Both low and medium image variants are required together.");
  }
  if (low) validateImageVariantFile(low, variant);
  if (medium) validateImageVariantFile(medium, variant);

  const idFactory = options.idFactory || (() => crypto.randomUUID());
  const stageId = normalizeGeneratedId(idFactory());
  const now = normalizeTimestamp(options.now || new Date().toISOString());
  const expiresAt = new Date(Date.parse(now) + STAGE_TTL_MS).toISOString();
  const baseKey = buildMediaSetKey(swordName, variant, stageId);
  const originalKey = buildPhysicalKey(baseKey, originalInfo.extension, variant, "full", "original");
  const lowKey = low ? buildPhysicalKey(baseKey, extensionForFile(low), variant, "low", "low") : originalKey;
  const mediumKey = medium ? buildPhysicalKey(baseKey, extensionForFile(medium), variant, "medium", "medium") : originalKey;
  const files = deduplicateFiles([
    { key: lowKey, file: low || original },
    { key: mediumKey, file: medium || original },
    { key: originalKey, file: original }
  ]);
  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (totalBytes > MAX_STAGE_BODY_BYTES) throw new StagedMediaUploadError(413, "Combined staged media variants must be 24 MB or smaller.");

  const uploadedKeys = [];
  try {
    for (const { key, file } of files) {
      await env.MEDIA_BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: normalizeContentType(file.type) },
        customMetadata: { contentType: normalizeContentType(file.type), mediaSize: String(file.size), stagedMediaId: stageId }
      });
      uploadedKeys.push(key);
    }

    const objects = files.map(({ key, file }) => ({
      mediaKey: key,
      contentType: normalizeContentType(file.type),
      sizeBytes: file.size,
      updatedAt: now
    }));
    const descriptor = {
      baseKey,
      mediaKind: originalInfo.kind,
      contentType: originalInfo.contentType,
      lowKey,
      mediumKey,
      originalKey,
      updatedAt: now
    };
    const createRecord = options.createRecord || createStagedMedia;
    const record = await createRecord(env, {
      id: stageId,
      actorUserId,
      variant,
      idempotencyKey,
      baseKey,
      descriptor,
      objects,
      sizeBytes: totalBytes,
      createdAt: now,
      expiresAt
    });
    if (record.id !== stageId) {
      await Promise.all(uploadedKeys.map((key) => env.MEDIA_BUCKET.delete(key).catch(() => {})));
    }
    return serializeResponse(record, record.id !== stageId);
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => env.MEDIA_BUCKET.delete(key).catch(() => {})));
    if (error instanceof StagedMediaUploadError) throw error;
    throw error;
  }
}

function serializeResponse(record, reused) {
  return {
    stagedMediaId: record.id,
    variant: record.variant,
    sizeBytes: Number(record.sizeBytes || 0),
    expiresAt: record.expiresAt,
    reused
  };
}

function getActorUserId(actor) {
  const value = Number(actor?.id ?? actor?.user?.id ?? actor?.baseUser?.id);
  if (!Number.isSafeInteger(value) || value < 1) throw new StagedMediaUploadError(401, "An authenticated editor is required.");
  return value;
}

function rejectOversizedContentLength(value, maxBodyBytes) {
  if (!value || !/^\d+$/.test(String(value).trim())) return;
  if (Number(value) > maxBodyBytes) throwStageBodySizeError(maxBodyBytes);
}

async function createBoundedMultipartRequest(request, maxBodyBytes) {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => {});
      throwStageBodySizeError(maxBodyBytes);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request, { headers, body: bytes });
}

function normalizeBodyLimit(value) {
  if (value === undefined || value === null) return MAX_STAGE_BODY_BYTES;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_STAGE_BODY_BYTES) {
    throw new TypeError("Staged media body limit is invalid.");
  }
  return number;
}

function throwStageBodySizeError(maxBodyBytes) {
  const megabytes = Math.max(1, Math.floor(maxBodyBytes / MEBIBYTE));
  throw new StagedMediaUploadError(413, `Staged media request must be ${megabytes} MB or smaller.`);
}

function normalizeVariant(value) {
  const variant = String(value || "").trim();
  if (!VARIANTS.has(variant)) throw new StagedMediaUploadError(400, "Media field is invalid.");
  return variant;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new StagedMediaUploadError(400, "Upload idempotency key is invalid.");
  return key;
}

function normalizeSwordName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) throw new StagedMediaUploadError(400, "Sword name is required for media upload.");
  return name;
}

function requireFile(value, label) {
  if (!isFileLike(value) || value.size < 1) throw new StagedMediaUploadError(400, `${label} is required.`);
  return value;
}

function isFileLike(value) {
  return Boolean(value && typeof value === "object" && typeof value.arrayBuffer === "function" && Number.isFinite(Number(value.size)) && typeof value.type === "string");
}

function validateFile(file, variant) {
  const contentType = normalizeContentType(file.type);
  const info = MIME_TYPES.get(contentType);
  if (!info) throw new StagedMediaUploadError(415, "Media format is not supported.");
  const supported = variant === "slash-audio" ? info.kind === "audio" : info.kind === "image" || info.kind === "video";
  if (!supported) throw new StagedMediaUploadError(415, variant === "slash-audio" ? "SFX Preview requires audio." : "This media field requires an image or MP4 video.");
  const maximum = getMaximumBytes(variant, info.kind);
  if (file.size > maximum) throw new StagedMediaUploadError(413, `${getFieldLabel(variant)} must be ${maximum / MEBIBYTE} MB or smaller.`);
  return { ...info, contentType };
}

function validateImageVariantFile(file, variant) {
  const info = validateFile(file, variant);
  if (info.kind !== "image") throw new StagedMediaUploadError(415, "Generated quality variants must be images.");
}

function getMaximumBytes(variant, kind) {
  if (variant === "slash-audio") return 1 * MEBIBYTE;
  if (["detail", "slash", "finisher"].includes(variant)) return 10 * MEBIBYTE;
  return kind === "video" || kind === "audio" ? 8 * MEBIBYTE : 3 * MEBIBYTE;
}

function getFieldLabel(variant) {
  return ({ "card-image": "Card Media", detail: "VFX Preview", slash: "Slash Preview", "slash-audio": "SFX Preview", finisher: "Finisher Preview" })[variant] || "Media";
}

function buildMediaSetKey(name, variant, stageId) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "sword";
  return `media/${slug}-${variant}-${stageId}`;
}

function buildPhysicalKey(baseKey, extension, variant, quality, suffix) {
  const folder = ({ "card-image": "card", detail: "vfx", "slash-audio": "sfx", slash: "slash", finisher: "finisher" })[variant] || "card";
  return `${folder}/${quality}/${baseKey.replace(/^media\//, "")}--${suffix}.${extension}`;
}

function extensionForFile(file) {
  const info = MIME_TYPES.get(normalizeContentType(file.type));
  if (!info) throw new StagedMediaUploadError(415, "Media format is not supported.");
  return info.extension;
}

function deduplicateFiles(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

function normalizeGeneratedId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(id)) throw new TypeError("Generated staged media id is invalid.");
  return id;
}

function normalizeTimestamp(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError("Staged media timestamp is invalid.");
  return new Date(time).toISOString();
}

function normalizeContentType(value) {
  return String(value || "").trim().toLowerCase();
}
