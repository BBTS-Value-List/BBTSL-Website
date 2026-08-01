const SITE_STATE_KEY = "__system/site-state.json";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function buildDirectMediaNormalization(state, options = {}) {
  const limit = normalizeLimit(options.limit);
  const migrationTime = normalizeTimestamp(options.now || new Date().toISOString());
  const covered = new Set();
  for (const variant of Object.values(state?.mediaVariants || {})) {
    for (const key of [variant?.lowKey, variant?.mediumKey, variant?.originalKey]) {
      if (typeof key === "string" && key) covered.add(key);
    }
  }

  const plan = [];
  for (const [key, record] of Object.entries(state?.mediaObjects || {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (covered.has(key) || state?.mediaVariants?.[key]) continue;
    const contentType = String(record?.contentType || "").toLowerCase();
    plan.push({
      baseKey: key,
      variant: {
        baseKey: key,
        mediaKind: inferKind(key, contentType),
        contentType: contentType || undefined,
        lowKey: key,
        mediumKey: key,
        originalKey: key,
        updatedAt: normalizeOptionalTimestamp(record?.updatedAt) || migrationTime
      }
    });
    if (plan.length >= limit) break;
  }
  return plan;
}

export async function normalizeDirectMediaForQuarantine(env, options = {}) {
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function" || typeof env.MEDIA_BUCKET.put !== "function") {
    throw new TypeError("MEDIA_BUCKET is required for direct media normalization.");
  }
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) throw new Error("Site state is unavailable for direct media normalization.");
  const state = JSON.parse(await object.text());
  const plan = buildDirectMediaNormalization(state, options);
  if (!plan.length) return { normalized: 0 };

  state.mediaVariants = state.mediaVariants || {};
  for (const entry of plan) state.mediaVariants[entry.baseKey] = entry.variant;
  await options.lock?.assertActive?.();
  await env.MEDIA_BUCKET.put(SITE_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  return { normalized: plan.length };
}

function inferKind(key, contentType) {
  if (contentType.startsWith("audio/") || /\.(mp3|mpeg|ogg|wav)$/i.test(key)) return "audio";
  if (contentType.startsWith("video/") || /\.mp4$/i.test(key)) return "video";
  return "image";
}

function normalizeLimit(value) {
  const number = value === undefined || value === null ? DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LIMIT) {
    throw new TypeError("Direct media normalization limit is invalid.");
  }
  return number;
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Direct media normalization timestamp is invalid.");
  }
  return timestamp.toISOString();
}

function normalizeOptionalTimestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}
