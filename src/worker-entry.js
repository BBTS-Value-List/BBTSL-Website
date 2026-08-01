import baseWorker from "./worker.js";
import {
  enrichWebsiteAuditResponse,
  handleBotApiRequest,
  isBotApiRequest
} from "./bot-api/router.js";
import {
  cleanupFavoriteState,
  handleBotFavoritesApiRequest,
  handleFavoritesApiRequest,
  isBotFavoritesApiRequest,
  isFavoritesApiRequest,
  maybeInjectFavoritesIntoApiResponse,
  patchAppScript
} from "./favorites/user-favorites.js";

const APP_MIN_PATH = "/app.min.js";
const APP_SOURCE_PATH = "/app.js";
const FAVICON_PATH = "/favicon.ico";
const FAVICON_ASSET_PATH = "/og-image.png";
const BOT_PAGE_PATHS = new Set(["/bot", "/bot/", "/bot.html"]);
const BOT_PAGE_ASSET_PATH = "/bot/index.html";
const LOGIN_CONSENT_STYLE = '<link rel="stylesheet" href="/login-consent.css">';
const LOGIN_CONSENT_SCRIPT = '<script type="module" src="/login-consent.js"></script>';
const CLEAN_STATIC_ASSET_PATHS = new Map([
  ["/team.min.js", "application/javascript; charset=utf-8"],
  ["/bot-support.js", "application/javascript; charset=utf-8"],
  ["/consent.min.js", "application/javascript; charset=utf-8"],
  ["/login-consent.js", "application/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/bot-support.css", "text/css; charset=utf-8"],
  ["/consent.css", "text/css; charset=utf-8"],
  ["/login-consent.css", "text/css; charset=utf-8"]
]);
const LOGIN_CONSENT_PAGE_PATHS = new Set(["/", "/index.html", "/team", "/team/", "/team.html"]);
const BOT_PAGE_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self' https://discord.com",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https://cdn.discordapp.com",
  "media-src 'self' data: blob:",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'"
].join("; ");
const HTML_REPORT_ONLY_CSP = BOT_PAGE_CSP;
const HOME_IMAGE_PRELOAD_PATTERN = /\s*<link\s+rel=(?:"preload"|'preload')\s+as=(?:"image"|'image')[^>]*>/gi;
const FAVORITE_INTERVAL_POLL_PATTERN = /(^|\n)\s*window\.setInterval\(sync,\s*\d+(?:_\d+)*\);/g;
const FAVORITE_VISIBLE_TAB_SYNC_LINE = "$1  window.setInterval(sync, 30_000);";

export default {
  async fetch(request, env, executionContext = {}) {
    try {
      return await handleWorkerEntryFetch(request, env, executionContext);
    } catch (error) {
      console.error("Worker-entry request failed.", error);
      return buildWorkerEntryErrorResponse(request);
    }
  },

  async scheduled(event, env, executionContext = {}) {
    const baseTask = baseWorker.scheduled?.(event, env, executionContext);
    const cleanupTask = Promise.all([cleanupBotIntegrationState(env), cleanupFavoriteState(env)]);
    if (typeof executionContext.waitUntil === "function") {
      if (baseTask) executionContext.waitUntil(Promise.resolve(baseTask));
      executionContext.waitUntil(cleanupTask.catch((error) => console.error("Scheduled cleanup failed.", error)));
      return;
    }
    await Promise.all([baseTask, cleanupTask]);
  }
};

async function handleWorkerEntryFetch(request, env, executionContext = {}) {
  const favoriteScript = await maybeServeLeanFavoritesAppScript(request, env);
  if (favoriteScript) return stripReportOnlyCsp(favoriteScript);
  const cleanAsset = await maybeServeCleanStaticAsset(request, env);
  if (cleanAsset) return cleanAsset;
  const favicon = await maybeServeFavicon(request, env);
  if (favicon) return favicon;
  const botPage = await maybeServeBotSupportPage(request, env);
  if (botPage) return setHtmlReportOnlyCsp(botPage);
  if (isFavoritesApiRequest(request)) {
    return stripReportOnlyCsp(await handleFavoritesApiRequest(request, env));
  }
  if (isBotFavoritesApiRequest(request)) {
    return stripReportOnlyCsp(await handleBotFavoritesApiRequest(request, env));
  }
  if (isBotApiRequest(request)) {
    return stripReportOnlyCsp(await handleBotApiRequest(request, env, baseWorker));
  }

  const baseResponse = await baseWorker.fetch(request, env, executionContext);
  const response = await safeInjectFavoritesIntoApiResponse(request, baseResponse, env);
  const auditedResponse = await safeEnrichWebsiteAuditResponse(request, response, env);
  const strippedResponse = await safeStripHomeImagePreload(request, auditedResponse);
  const loginAwareResponse = await safeInjectLoginConsentAssets(request, strippedResponse);
  return setHtmlReportOnlyCsp(loginAwareResponse);
}

async function maybeServeLeanFavoritesAppScript(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname !== APP_SOURCE_PATH && url.pathname !== APP_MIN_PATH) return null;

  const sourceRequest = new Request(new URL(APP_SOURCE_PATH, request.url).toString(), {
    method: request.method,
    headers: request.headers
  });
  const assetResponse = await env.ASSETS.fetch(sourceRequest);
  if (!assetResponse.ok || request.method === "HEAD") return cleanStaticAssetResponse(assetResponse, "application/javascript; charset=utf-8");

  const source = await assetResponse.text();
  let patched = source;
  try {
    patched = keepLowFrequencyFavoriteSync(patchAppScript(source));
  } catch (error) {
    console.error("App script favorite patch failed; serving the original asset instead.", error);
  }
  const headers = cleanHeaders(assetResponse.headers);
  headers.set("content-type", "application/javascript; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(patched, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
}

async function maybeServeCleanStaticAsset(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const contentType = CLEAN_STATIC_ASSET_PATHS.get(url.pathname);
  if (!contentType) return null;

  const assetResponse = await env.ASSETS.fetch(new Request(url.toString(), {
    method: request.method,
    headers: request.headers
  }));
  return cleanStaticAssetResponse(assetResponse, contentType);
}

async function maybeServeFavicon(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname !== FAVICON_PATH) return null;
  const assetResponse = await env.ASSETS.fetch(new Request(new URL(FAVICON_ASSET_PATH, request.url).toString(), {
    method: request.method,
    headers: request.headers
  }));
  const headers = cleanHeaders(assetResponse.headers);
  headers.set("content-type", "image/png");
  headers.set("cache-control", "public, max-age=86400");
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: assetResponse.ok ? 200 : assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
}

function cleanStaticAssetResponse(response, contentType) {
  const headers = cleanHeaders(response.headers);
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function maybeServeBotSupportPage(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!BOT_PAGE_PATHS.has(url.pathname)) return null;

  const assetRequest = new Request(new URL(BOT_PAGE_ASSET_PATH, request.url).toString(), {
    method: "GET",
    headers: request.headers
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const headers = cleanHeaders(assetResponse.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "private, no-cache, max-age=0, must-revalidate");
  headers.set("content-security-policy", BOT_PAGE_CSP);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("strict-transport-security", "max-age=31536000");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
}

export function keepLowFrequencyFavoriteSync(source) {
  return String(source || "").replace(FAVORITE_INTERVAL_POLL_PATTERN, FAVORITE_VISIBLE_TAB_SYNC_LINE);
}

export function stripFavoriteIntervalPolling(source) {
  return String(source || "").replace(FAVORITE_INTERVAL_POLL_PATTERN, "$1");
}

async function safeInjectFavoritesIntoApiResponse(request, response, env) {
  try {
    return await maybeInjectFavoritesIntoApiResponse(request, response, env);
  } catch (error) {
    console.error("Favorite API response enrichment failed; returning the base response.", error);
    return response;
  }
}

async function safeEnrichWebsiteAuditResponse(request, response, env) {
  try {
    return await enrichWebsiteAuditResponse(request, response, env);
  } catch (error) {
    console.error("Website audit response enrichment failed; returning the base response.", error);
    return response;
  }
}

async function safeStripHomeImagePreload(request, response) {
  try {
    return await maybeStripHomeImagePreload(request, response);
  } catch (error) {
    console.error("Home image preload cleanup failed; returning the unmodified response.", error);
    return response;
  }
}

async function safeInjectLoginConsentAssets(request, response) {
  try {
    return await maybeInjectLoginConsentAssets(request, response);
  } catch (error) {
    console.error("Login consent asset injection failed; returning the unmodified response.", error);
    return response;
  }
}

export async function maybeStripHomeImagePreload(request, response) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/") return response;
  if (!String(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) return stripReportOnlyCsp(response);

  const html = await response.text();
  const nextHtml = html.replace(HOME_IMAGE_PRELOAD_PATTERN, "");
  const headers = cleanHeaders(response.headers);
  return new Response(nextHtml, { status: response.status, statusText: response.statusText, headers });
}

async function maybeInjectLoginConsentAssets(request, response) {
  const url = new URL(request.url);
  if (request.method !== "GET" || !LOGIN_CONSENT_PAGE_PATHS.has(url.pathname)) return response;
  if (!String(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) return response;
  const html = await response.text();
  let nextHtml = html;
  if (!nextHtml.includes('/login-consent.css')) {
    nextHtml = /<\/head>/i.test(nextHtml) ? nextHtml.replace(/<\/head>/i, `  ${LOGIN_CONSENT_STYLE}\n</head>`) : `${LOGIN_CONSENT_STYLE}${nextHtml}`;
  }
  if (!nextHtml.includes('/login-consent.js')) {
    nextHtml = /<\/body>/i.test(nextHtml) ? nextHtml.replace(/<\/body>/i, `  ${LOGIN_CONSENT_SCRIPT}\n</body>`) : `${nextHtml}${LOGIN_CONSENT_SCRIPT}`;
  }
  const headers = cleanHeaders(response.headers);
  return new Response(nextHtml, { status: response.status, statusText: response.statusText, headers });
}

export function stripReportOnlyCsp(response) {
  const changed = hasHeadersToClean(response.headers);
  const headers = cleanHeaders(response.headers);
  if (!changed) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function setHtmlReportOnlyCsp(response) {
  const isHtml = String(response.headers.get("content-type") || "").toLowerCase().includes("text/html");
  const hasDirtyHeaders = hasHeadersToClean(response.headers);
  if (!isHtml && !hasDirtyHeaders) return response;
  const headers = cleanHeaders(response.headers);
  if (isHtml) {
    headers.set("content-security-policy-report-only", HTML_REPORT_ONLY_CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function buildWorkerEntryErrorResponse(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const headers = new Headers({
    "cache-control": "no-store",
    "x-bbtsl-worker-error": "1",
    "x-content-type-options": "nosniff"
  });

  if (pathname.startsWith("/api/") || String(request.headers.get("accept") || "").includes("application/json")) {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ error: "Internal server error." }), { status: 500, headers });
  }

  if (/\.(?:js|mjs)$/i.test(pathname)) {
    headers.set("content-type", "application/javascript; charset=utf-8");
    return new Response("console.error('BBTSL script request failed.');\n", { status: 500, headers });
  }

  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy-report-only", HTML_REPORT_ONLY_CSP);
  return new Response("<!doctype html><title>BBTSL</title><h1>Temporary website error</h1><p>Try again in a moment.</p>", { status: 500, headers });
}

function hasHeadersToClean(headers) {
  return headers.has("content-security-policy-report-only") || headers.has("content-length");
}

function cleanHeaders(sourceHeaders) {
  const headers = new Headers(sourceHeaders);
  headers.delete("content-security-policy-report-only");
  headers.delete("content-length");
  return headers;
}

async function cleanupBotIntegrationState(env) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const consumedCutoff = new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await Promise.all([
    env.DB.prepare(`DELETE FROM bot_request_nonces WHERE expires_at <= ?`).bind(now).run(),
    env.DB.prepare(`
      DELETE FROM bot_reauth_challenges
      WHERE expires_at <= ? OR (status = 'consumed' AND consumed_at <= ?)
    `).bind(now, consumedCutoff).run()
  ]);
}
