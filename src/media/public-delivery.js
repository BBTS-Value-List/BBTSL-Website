import {
  collectLivePhysicalMediaKeys,
  initializePublicMediaRegistry,
  isPublicMediaKey,
  updatePublicMediaRegistryDelta
} from "../security/public-media-registry.js";

const DEFAULT_SITE_STATE_KEY = "__system/site-state.json";
const DEFAULT_UNAVAILABLE_ASSET_PATH = "/images/unavailable.webp";
const MEDIA_KEY_LIMIT = 512;
const LIVE_REGISTRY_REPAIR_TTL_MS = 60_000;
const compatibilityRegistry = new WeakMap();
const liveRegistryRepairCache = new WeakMap();

export function invalidatePublicMediaRegistry(env) {
  const bucket = env?.MEDIA_BUCKET;
  if (bucket && (typeof bucket === "object" || typeof bucket === "function")) {
    compatibilityRegistry.delete(bucket);
    liveRegistryRepairCache.delete(bucket);
  }
}

export function isReservedMediaKey(key) {
  const normalized = String(key || "");
  return normalized === "__system" || normalized.startsWith("__system/");
}

export async function handlePublicMediaRequest(request, env, key, options = {}) {
  const unavailableAssetPath = options.unavailableAssetPath || DEFAULT_UNAVAILABLE_ASSET_PATH;
  const normalizedKey = normalizeMediaKey(key);

  if (normalizedKey === "unavailable.webp") {
    return fetchUnavailableAsset(request, env, unavailableAssetPath);
  }
  if (!normalizedKey || isReservedMediaKey(normalizedKey)) {
    return fetchUnavailableAsset(request, env, unavailableAssetPath);
  }

  const authorized = env?.DB
    ? await authorizeIndexedMediaKey(env, normalizedKey, options)
    : await authorizeCompatibilityMediaKey(env, normalizedKey, options);
  if (!authorized) {
    return fetchUnavailableAsset(request, env, unavailableAssetPath);
  }

  const cache = getDefaultCache();
  const cacheKey = buildCacheKey(request, normalizedKey);
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return responseForMethod(request, cachedResponse);
  }

  const mediaObject = await env.MEDIA_BUCKET.get(normalizedKey);
  if (!mediaObject) return fetchUnavailableAsset(request, env, unavailableAssetPath);

  const response = await buildMediaResponse(mediaObject, normalizedKey);
  if (cache) await cache.put(cacheKey, response.clone());
  return responseForMethod(request, response);
}

async function authorizeIndexedMediaKey(env, key, options) {
  await initializePublicMediaRegistry(env, null, {
    siteStateKey: options.siteStateKey
  });
  if (await isPublicMediaKey(env, key)) {
    return true;
  }
  return repairAndAuthorizeLiveMediaKey(env, key, options);
}

async function repairAndAuthorizeLiveMediaKey(env, key, options) {
  const bucket = env?.MEDIA_BUCKET;
  if (!bucket || typeof bucket.get !== "function") return false;
  const keys = await readLiveRegistryRepairKeys(env, options.siteStateKey || DEFAULT_SITE_STATE_KEY);
  if (!keys.has(key)) return false;
  try {
    await updatePublicMediaRegistryDelta(env, { addKeys: [key] });
  } catch (error) {
    console.error("Could not repair missing public media registry key.", error);
  }
  return true;
}

async function readLiveRegistryRepairKeys(env, siteStateKey) {
  const bucket = env.MEDIA_BUCKET;
  const now = Date.now();
  const cached = liveRegistryRepairCache.get(bucket);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = readLiveRegistryKeys(env, siteStateKey).catch((error) => {
    liveRegistryRepairCache.delete(bucket);
    throw error;
  });
  liveRegistryRepairCache.set(bucket, { expiresAt: now + LIVE_REGISTRY_REPAIR_TTL_MS, promise });
  return promise;
}

async function readLiveRegistryKeys(env, siteStateKey) {
  const object = await env.MEDIA_BUCKET.get(siteStateKey);
  if (!object) return new Set();
  const state = JSON.parse(await object.text());
  return collectLivePhysicalMediaKeys(state);
}

async function authorizeCompatibilityMediaKey(env, key, options) {
  const bucket = env?.MEDIA_BUCKET;
  if (!bucket || typeof bucket.get !== "function") return false;
  let promise = compatibilityRegistry.get(bucket);
  if (!promise) {
    promise = readCompatibilityRegistry(env, options.siteStateKey || DEFAULT_SITE_STATE_KEY)
      .catch((error) => {
        compatibilityRegistry.delete(bucket);
        throw error;
      });
    compatibilityRegistry.set(bucket, promise);
  }
  return (await promise).has(key);
}

async function readCompatibilityRegistry(env, siteStateKey) {
  const object = await env.MEDIA_BUCKET.get(siteStateKey);
  const keys = new Set();
  if (!object) return keys;
  const state = JSON.parse(await object.text());
  for (const value of Object.keys(state.mediaObjects || {})) addCompatibilityKey(keys, value);
  for (const variant of Object.values(state.mediaVariants || {})) {
    addCompatibilityKey(keys, variant?.lowKey);
    addCompatibilityKey(keys, variant?.mediumKey);
    addCompatibilityKey(keys, variant?.originalKey);
  }
  for (const row of [...(state.swords || []), ...(state.baseline || [])]) {
    for (const value of [row?.image_key, row?.detail_image_key, row?.slash_media_key, row?.slash_audio_key, row?.finisher_media_key]) {
      addCompatibilityKey(keys, value);
    }
  }
  return keys;
}

function addCompatibilityKey(keys, value) {
  const key = normalizeMediaKey(value);
  if (key && !isReservedMediaKey(key)) keys.add(key);
}

function normalizeMediaKey(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > MEDIA_KEY_LIMIT) return "";
  if (normalized.startsWith("/") || normalized.includes("\\") || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  if (normalized.split("/").some((segment) => segment === ".." || segment === "." || !segment)) return "";
  return normalized;
}

function getDefaultCache() {
  return typeof caches === "undefined" ? null : caches.default;
}

function buildCacheKey(request, normalizedKey) {
  const url = new URL(request.url);
  url.pathname = `/media/${normalizedKey.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

async function buildMediaResponse(mediaObject, key) {
  const contentType = String(mediaObject.httpMetadata?.contentType || mediaObject.customMetadata?.contentType || "").toLowerCase();
  const headers = new Headers();
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  if (contentType === "image/svg+xml" || key.toLowerCase().endsWith(".svg")) {
    headers.set("content-disposition", `attachment; filename="${sanitizeFilename(key)}"`);
    headers.set("content-security-policy", "default-src 'none'; sandbox");
  }
  const body = mediaObject.body || await mediaObject.arrayBuffer();
  return new Response(body, { status: 200, headers });
}

async function fetchUnavailableAsset(request, env, assetPath) {
  const assetUrl = new URL(assetPath, request.url);
  const assetRequest = new Request(assetUrl.toString(), {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: request.headers
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(assetResponse.headers);
  headers.set("cache-control", "public, max-age=60");
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
}

function responseForMethod(request, response) {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function sanitizeFilename(key) {
  return (key.split("/").pop() || "media").replace(/["\r\n]/g, "_");
}
