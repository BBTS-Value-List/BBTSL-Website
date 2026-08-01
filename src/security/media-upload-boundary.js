const MEBIBYTE = 1024 * 1024;

export const MEDIA_UPLOAD_BODY_LIMIT_BYTES = 16 * MEBIBYTE;
export const CARD_COMMIT_BODY_LIMIT_BYTES = 256 * 1024;

const MAX_IMAGE_BYTES = 3 * MEBIBYTE;
const MAX_MEDIA_BYTES = 8 * MEBIBYTE;
const MAX_SFX_BYTES = 1 * MEBIBYTE;
const MAX_VISUAL_PREVIEW_BYTES = 10 * MEBIBYTE;
const MEDIA_VARIANTS = new Set(["card-image", "detail", "slash", "slash-audio", "finisher"]);
const SWORD_MEDIA_FIELDS = [
  ["img", "card-image"],
  ["detailMedia", "detail"],
  ["slashMedia", "slash"],
  ["slashAudio", "slash-audio"],
  ["finisherMedia", "finisher"]
];

export class MediaUploadBoundaryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MediaUploadBoundaryError";
    this.status = status;
  }
}

export function isMediaUploadRequest(request) {
  const url = new URL(request.url);
  if (request.method === "POST" && ["/api/media", "/api/swords", "/api/swords/commit"].includes(url.pathname)) {
    return true;
  }
  if (request.method !== "PUT") return false;
  return /^\/api\/swords\/[^/]+$/.test(url.pathname)
    || /^\/api\/swords\/commit\/\d+$/.test(url.pathname);
}

export async function prepareBoundedMediaUploadRequest(request, options = {}) {
  if (!isMediaUploadRequest(request)) {
    return request;
  }

  const pathname = new URL(request.url).pathname;
  const defaultBodyLimit = pathname === "/api/swords/commit" || pathname.startsWith("/api/swords/commit/")
    ? CARD_COMMIT_BODY_LIMIT_BYTES
    : MEDIA_UPLOAD_BODY_LIMIT_BYTES;
  const maxBodyBytes = normalizePositiveLimit(options.maxBodyBytes, defaultBodyLimit);
  rejectOversizedContentLength(request.headers.get("content-length"), maxBodyBytes);
  const bodyText = await readBoundedBodyText(request, maxBodyBytes);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new MediaUploadBoundaryError(400, "Request body must be valid JSON.");
  }

  validateMediaPayload(body, new URL(request.url).pathname);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request, { headers, body: bodyText });
}

function normalizePositiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function rejectOversizedContentLength(headerValue, maxBodyBytes) {
  if (!headerValue || !/^\d+$/.test(headerValue.trim())) {
    return;
  }
  if (Number(headerValue) > maxBodyBytes) {
    throwBodySizeError(maxBodyBytes);
  }
}

async function readBoundedBodyText(request, maxBodyBytes) {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      try {
        await reader.cancel();
      } catch {
      }
      throwBodySizeError(maxBodyBytes);
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateMediaPayload(body, pathname) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return;
  }

  if (pathname === "/api/media") {
    if (MEDIA_VARIANTS.has(body.variant)) {
      validateMediaInput(body.media, body.variant);
    }
    return;
  }

  for (const [field, variant] of SWORD_MEDIA_FIELDS) {
    validateMediaInput(body[field], variant);
  }
}

function validateMediaInput(mediaInput, variant) {
  if (typeof mediaInput === "string") {
    validateDataUrlEncodedSize(mediaInput, variant);
    return;
  }
  if (!mediaInput || typeof mediaInput !== "object" || Array.isArray(mediaInput)) {
    return;
  }
  if (typeof mediaInput.key === "string" && mediaInput.key) {
    return;
  }

  validateDataUrlEncodedSize(mediaInput.low, variant);
  validateDataUrlEncodedSize(mediaInput.medium, variant);
  validateDataUrlEncodedSize(mediaInput.original, variant);
}

function validateDataUrlEncodedSize(input, variant) {
  if (typeof input !== "string" || input.slice(0, 5).toLowerCase() !== "data:") {
    return;
  }

  const commaIndex = input.indexOf(",");
  if (commaIndex < 0) {
    return;
  }
  const metadata = input.slice(0, commaIndex);
  if (!/^data:[^;,]+;base64$/i.test(metadata)) {
    return;
  }

  const contentType = metadata.slice(5, -7).toLowerCase();
  const kind = inferMediaKind(contentType);
  if (!kind) {
    return;
  }

  const maxBytes = getMaxMediaBytes(variant, kind);
  const maxEncodedCharacters = 4 * Math.ceil(maxBytes / 3);
  const encodedCharacters = input.length - commaIndex - 1;
  if (encodedCharacters > maxEncodedCharacters) {
    throwMediaSizeError(variant, maxBytes);
  }
}

function inferMediaKind(contentType) {
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  if (contentType.startsWith("image/")) {
    return "image";
  }
  return "";
}

function getMaxMediaBytes(variant, kind) {
  if (variant === "slash-audio") {
    return MAX_SFX_BYTES;
  }
  if (variant === "detail" || variant === "slash" || variant === "finisher") {
    return MAX_VISUAL_PREVIEW_BYTES;
  }
  return kind === "audio" || kind === "video" ? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES;
}

function throwBodySizeError(maxBodyBytes) {
  throw new MediaUploadBoundaryError(413, `Media upload request body must be ${formatMebibytes(maxBodyBytes)} MB or smaller.`);
}

function throwMediaSizeError(variant, maxBytes) {
  throw new MediaUploadBoundaryError(413, `${getMediaFieldLabel(variant)} must be ${formatMebibytes(maxBytes)} MB or smaller.`);
}

function formatMebibytes(bytes) {
  return bytes / MEBIBYTE;
}

function getMediaFieldLabel(variant) {
  const labels = {
    "card-image": "Card Media",
    detail: "VFX Preview",
    slash: "Slash Preview",
    "slash-audio": "SFX Preview",
    finisher: "Finisher Preview"
  };
  return labels[variant] || "Media";
}
