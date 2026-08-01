const PUBLIC_CONFIG_PATH = "/api/public-config";
const PRIVATE_ROBOTS_TAG = "noindex, nofollow, noarchive";
const PUBLIC_CONFIG_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=300";

export function normalizeGaMeasurementId(value) {
  const normalized = String(value || "").trim();
  if (normalized === "G-XXXXXXXXXX") return null;
  return /^G-[A-Z0-9]{6,20}$/.test(normalized) ? normalized : null;
}

export function getPublicConfig(env) {
  const measurementId = normalizeGaMeasurementId(env?.GA_MEASUREMENT_ID);
  return {
    analytics: {
      enabled: Boolean(measurementId),
      measurementId
    }
  };
}

export async function handlePublicConfigRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== PUBLIC_CONFIG_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": PUBLIC_CONFIG_CACHE_CONTROL,
        "allow": "GET, HEAD",
        "x-robots-tag": PRIVATE_ROBOTS_TAG
      }
    });
  }
  const body = JSON.stringify(getPublicConfig(env));
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CONFIG_CACHE_CONTROL,
      "x-robots-tag": PRIVATE_ROBOTS_TAG,
      "x-content-type-options": "nosniff"
    }
  });
}
