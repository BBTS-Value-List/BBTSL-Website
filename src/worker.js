import { addScriptNonces, buildContentSecurityPolicy as buildSecureContentSecurityPolicy, serializeJsonForHtml } from "./security/html.js";
import { handlePublicMediaRequest, invalidatePublicMediaRegistry } from "./media/public-delivery.js";
import { handleStagedMediaUpload, StagedMediaUploadError } from "./media/staged-upload.js";
import { loadStagedMediaForCommit, markStagedMediaCommitted, StagedMediaStoreError } from "./media/staged-media-store.js";
import { createRequestContext, createRuntimeEnvironment } from "./runtime/request-context.js";
import { applyAnalyticsConsentMarkup } from "./security/analytics-consent.js";
import {
  AuditRetentionError,
  authorizeAuditRevertRequest,
  enrichAuditResponse,
  migrateAuditLifecycle
} from "./security/audit-retention.js";
import {
  AuditAlreadyRevertedError,
  assertAuditNotAlreadyReverted,
  markAuditReverted
} from "./security/audit-revert-finalization.js";
import { markHistoryOnlyAuditEntries } from "./security/audit-ui-boundary.js";
import {
  AuthRateLimitBoundaryError,
  prepareOAuthRateLimitBoundary
} from "./security/auth-rate-limit-boundary.js";
import {
  applyCrawlerResponsePolicy,
  handleCrawlerPolicyRequest
} from "./security/crawler-policy.js";
import { normalizeDirectMediaForQuarantine } from "./security/direct-media-normalization.js";
import {
  MediaUploadBoundaryError,
  prepareBoundedMediaUploadRequest
} from "./security/media-upload-boundary.js";
import {
  reconcileDetachedMedia,
  restoreSnapshotMedia
} from "./security/media-quarantine.js";
import { recoverIncompleteQuarantineTransitions } from "./security/media-transition-recovery.js";
import {
  MutationAdmissionError,
  applyAdmissionRateLimitIdentity,
  authorizeExpensiveRead,
  authorizeSiteStateMutation,
  isExpensiveAuthenticatedReadRequest
} from "./security/mutation-admission.js";
import { handleProbePathRequest } from "./security/probe-path-policy.js";
import { handlePublicConfigRequest } from "./security/public-config.js";
import {
  clearPublicMediaRegistry,
  collectLivePhysicalMediaKeys,
  PublicMediaRegistryStateError,
  replacePublicMediaRegistry,
  updatePublicMediaRegistryDelta
} from "./security/public-media-registry.js";
import { R2UsageQuotaError } from "./security/r2-usage-boundary.js";
import { consumeAtomicRateLimit } from "./security/rate-limit.js";
import { runSecurityMaintenance } from "./security/security-maintenance.js";
import { prepareSessionBoundary } from "./security/session-boundary.js";
import {
  SiteStateLockError,
  SiteStateQuotaError,
  createStateMutationBucket,
  getPrivateApiClientBoundaryDecision,
  isSiteStateMutationRequest,
  withSiteStateMutationLock
} from "./security/state-coordinator.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const BF_CACHE_SAFE_HTML_CACHE_CONTROL = "private, no-cache, max-age=0, must-revalidate";
const BF_CACHE_SAFE_JSON_CACHE_CONTROL = "private, no-cache, max-age=0, must-revalidate";

const HTML_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self' https://discord.com",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https://cdn.discordapp.com",
    "media-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'"
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

const SESSION_COOKIE = "bbtsl_session";
const OAUTH_STATE_COOKIE = "bbtsl_oauth_state";
const APP_REQUEST_HEADER = "x-bbts-request";
const PRIVATE_API_CLIENT_HEADER = "x-bbtsl-api-client";
const PRIVATE_API_DATE_HEADER = "x-bbtsl-api-date";
const AUTH_VERIFY_BUCKET = "auth_verify";
const ADMIN_MUTATION_BUCKET = "admin_mutation";
const PRIVATE_API_BUCKET = "private_api";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 12;
const REAUTH_WINDOW_SECONDS = 60 * 10;
const OAUTH_STATE_LIFETIME_SECONDS = 60 * 10;
const PUBLIC_API_LIMIT = 100;
const PUBLIC_API_DEFAULT_LIMIT = 50;
const PUBLIC_API_MAX_OFFSET = 10_000;
const PRIVATE_API_KEY_HEX_LENGTH = 32;
const OAUTH_RATE_LIMIT = 20;
const MAX_EDIT_VALUE = 10_000_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_SFX_BYTES = 1 * 1024 * 1024;
const MAX_VISUAL_PREVIEW_BYTES = 10 * 1024 * 1024;
const R2_CLASS_A_LIMIT = 1_000_000;
const R2_CLASS_B_LIMIT = 10_000_000;
const R2_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const SITE_STATE_KEY = "__system/site-state.json";
const SYSTEM_DISCORD_USER_ID = "386438401563557888";
const SYSTEM_ACCOUNT_DISPLAY_NAME = "BBTSL";
const SYSTEM_ACCOUNT_HANDLE = "@root";
const SYSTEM_ACCOUNT_ROLE_LABEL = "System";
const SYSTEM_ACCOUNT_AVATAR_URL = "/og-image.png";
const CARD_ID_PREFIX = "#";
const CARD_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CARD_ID_LENGTH = 6;
const CATEGORY_COLOR_MAP = {
  LTM: "#a389f4",
  Ranked: "#e8b94f",
  "Top Spenders": "#4fd1a5",
  "Other Swords": "#5fc2ff",
  Explosions: "#ff6a6a",
  Emotes: "#ff89cf"
};
const VALUE_BAR_STOPS = ["#4a5a78", "#5573c9", "#7d5fd9", "#a34fd0", "#d94f9e", "#e8636b", "#e88a4f", "#efab4a", "#f4cf5c"];
const MEDIA_KEY_LIMIT = 512;
const USER_ROLE_VALUES = ["Viewer", "Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"];
const PUBLIC_TEAM_ROLES = new Set(["Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"]);
const CATEGORIES = new Set(["LTM", "Ranked", "Top Spenders", "Other Swords", "Explosions", "Emotes"]);
const DEMANDS = new Set(["Very High", "High", "Medium", "Low", "N/A"]);
const TRENDS = new Set(["Rising", "Falling", "Stable", "Manipulated", "N/A"]);
const DEMAND_SORT_RANK = {
  "Very High": 4,
  High: 3,
  Medium: 2,
  Low: 1,
  "N/A": 0
};
const TREND_SORT_RANK = {
  Rising: 4,
  Stable: 3,
  Falling: 2,
  Manipulated: 1,
  "N/A": 0
};
const MEDIA_VARIANTS = new Set(["card-image", "detail", "slash", "slash-audio", "finisher"]);
const MEDIA_MIME_MAP = new Map([
  ["image/webp", { ext: "webp", kind: "image" }],
  ["image/png", { ext: "png", kind: "image" }],
  ["image/jpeg", { ext: "jpg", kind: "image" }],
  ["image/gif", { ext: "gif", kind: "image" }],
  ["video/mp4", { ext: "mp4", kind: "video" }],
  ["audio/mpeg", { ext: "mp3", kind: "audio" }],
  ["audio/x-mpeg", { ext: "mpeg", kind: "audio" }],
  ["audio/mpeg3", { ext: "mp3", kind: "audio" }],
  ["audio/mp3", { ext: "mp3", kind: "audio" }],
  ["audio/ogg", { ext: "ogg", kind: "audio" }],
  ["audio/wav", { ext: "wav", kind: "audio" }],
  ["audio/x-wav", { ext: "wav", kind: "audio" }]
]);

const ROLE_PERMISSIONS = {
  Viewer: [],
  Contributor: ["team:view:self"],
  Editor: ["team:view:self", "sword:update", "media:update"],
  Maintainer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete"],
  Administrator: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export"],
  Developer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "data:reset", "audit:revert", "team:manage", "session:revoke", "backup:manage"],
  Owner: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "data:reset", "audit:revert", "team:manage", "session:revoke", "backup:manage", "owner:all"]
};

let coreSchemaReadyPromise = null;
let siteStateCache = null;

export async function handleApplicationRequest(request, env, requestOptions = {}) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/images/") || url.pathname.startsWith("/media/")) {
        await ensureCoreSchema(env);
      }

      if ((url.pathname === "/team" || url.pathname === "/team/" || url.pathname === "/team.html") && (request.method === "GET" || request.method === "HEAD")) {
        return withSecurityHeaders(await handleStaticPageRequest(request, env, "/team.html"));
      }

      if ((url.pathname === "/privacy" || url.pathname === "/privacy/" || url.pathname === "/privacy.html") && (request.method === "GET" || request.method === "HEAD")) {
        return withSecurityHeaders(await handleStaticPageRequest(request, env, "/privacy.html"));
      }

      if ((url.pathname === "/terms" || url.pathname === "/terms/" || url.pathname === "/terms.html") && (request.method === "GET" || request.method === "HEAD")) {
        return withSecurityHeaders(await handleStaticPageRequest(request, env, "/terms.html"));
      }

      if (url.pathname.startsWith("/meta/item/") && (request.method === "GET" || request.method === "HEAD")) {
        return withSecurityHeaders(await handleItemMetaImage(request, env, url));
      }

      if (parseDeepLinkCardId(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
        const legacyCardId = parseDeepLinkCardId(url.pathname);
        const redirectUrl = new URL("/", request.url);
        redirectUrl.searchParams.set("item", String(legacyCardId).replace(/^#/, ""));
        return Response.redirect(redirectUrl.toString(), 302);
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        enforceInternalReadRequest(request);
        return withSecurityHeaders(await handleAuthStatus(request, env));
      }

      if (url.pathname === "/api/auth/start" && request.method === "GET") {
        return withSecurityHeaders(await handleAuthStart(request, env, url));
      }

      if (url.pathname === "/api/auth/callback" && request.method === "GET") {
        return withSecurityHeaders(await handleAuthCallback(request, env, url));
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return withSecurityHeaders(await handleAuthLogout(request));
      }

      if (url.pathname === "/api/auth/system-session" && request.method === "POST") {
        return withSecurityHeaders(await handleAuthSystemSession(request, env));
      }

      if (url.pathname === "/api/v1/health" && request.method === "GET") {
        return withSecurityHeaders(handlePublicApiHealth());
      }

      if (url.pathname === "/api/v1/swords" && request.method === "GET") {
        return withSecurityHeaders(await handlePublicApiListSwords(request, env, url));
      }

      if (url.pathname.startsWith("/api/v1/swords/") && request.method === "GET") {
        return withSecurityHeaders(await handlePublicApiGetSword(request, env, url));
      }

      if (url.pathname === "/api/v1/team" && request.method === "GET") {
        return withSecurityHeaders(await handlePublicApiTeam(request, env));
      }

      if (url.pathname === "/api/internal/media-reconcile" && request.method === "POST") {
        return withSecurityHeaders(await handleInternalMediaReconcile(request, env));
      }

      if (url.pathname === "/api/v1/health" || url.pathname === "/api/v1/swords" || url.pathname === "/api/v1/team" || url.pathname.startsWith("/api/v1/swords/")) {
        return withSecurityHeaders(methodNotAllowed(["GET"]));
      }

      if (url.pathname === "/api/swords" && request.method === "GET") {
        enforceInternalReadRequest(request);
        return withSecurityHeaders(await handleListSwords(request, env, url));
      }

      if (url.pathname === "/api/media/stage" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "media:update", ({ actor }) => handleStageMedia(request, env, actor), { bucket: "media_stage", limit: 300, windowSeconds: 300 }));
      }

      if (url.pathname === "/api/swords/commit" && request.method === "POST") {
        return withSecurityHeaders(await requireAdmittedCapability(requestOptions.admission, "sword:create", ({ actor }) => handleEditorCardCommit(request, env, null, actor)));
      }

      if (url.pathname.startsWith("/api/swords/commit/") && request.method === "PUT") {
        const id = parseNumericPath(url.pathname, "/api/swords/commit/");
        if (id === null) return withSecurityHeaders(json({ error: "Invalid sword id." }, 400));
        return withSecurityHeaders(await requireAdmittedCapability(requestOptions.admission, "sword:update", ({ actor }) => handleEditorCardCommit(request, env, id, actor)));
      }

      if (url.pathname === "/api/swords" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "sword:create", ({ actor }) => handleCreateSword(request, env, actor)));
      }

      if (url.pathname === "/api/media" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "media:update", () => handleUploadMedia(request, env)));
      }

      if (url.pathname === "/api/swords") {
        return withSecurityHeaders(methodNotAllowed(["GET", "POST"]));
      }

      if (url.pathname.startsWith("/api/swords/")) {
        const id = parseNumericPath(url.pathname, "/api/swords/");
        if (id === null) {
          return withSecurityHeaders(json({ error: "Invalid sword id." }, 400));
        }

        if (request.method === "PUT") {
          return withSecurityHeaders(await requireCapability(request, env, "sword:update", ({ actor }) => handleUpdateSword(request, env, id, actor)));
        }

        if (request.method === "DELETE") {
          return withSecurityHeaders(await requireCapability(request, env, "sword:delete", ({ actor }) => handleDeleteSword(request, env, id, actor)));
        }

        return withSecurityHeaders(methodNotAllowed(["PUT", "DELETE"]));
      }

      if (url.pathname === "/api/reset" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "data:reset", ({ actor, session }) => handleReset(request, env, actor, session)));
      }

      if (url.pathname === "/api/export" && request.method === "GET") {
        enforceInternalReadRequest(request);
        return withSecurityHeaders(await requireCapability(request, env, "data:export", ({ actor }) => handleExport(env, actor)));
      }

      if (url.pathname === "/api/team" && request.method === "GET") {
        enforceInternalReadRequest(request);
        return withSecurityHeaders(await handleListTeam(request, env));
      }

      if (url.pathname === "/api/team/users" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "team:manage", ({ actor }) => handleCreateTeamUser(request, env, actor)));
      }

      if (url.pathname.startsWith("/api/team/users/") && request.method === "PATCH") {
        const id = parseNumericPath(url.pathname, "/api/team/users/");
        if (id === null) {
          return withSecurityHeaders(json({ error: "Invalid team user id." }, 400));
        }
        return withSecurityHeaders(await requireCapability(request, env, "team:manage", ({ actor }) => handleUpdateTeamUser(request, env, id, actor)));
      }

      if (url.pathname === "/api/audit" && request.method === "GET") {
        enforceInternalReadRequest(request);
        return withSecurityHeaders(await requireCapability(request, env, "audit:view", () => handleListAudit(url, env)));
      }

      if (url.pathname === "/api/audit/revert" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "audit:revert", ({ actor, session }) => handleAuditRevert(request, env, actor, session)));
      }

      if ((url.pathname.startsWith("/images/") || url.pathname.startsWith("/media/")) && (request.method === "GET" || request.method === "HEAD")) {
        const prefix = url.pathname.startsWith("/images/") ? "/images/" : "/media/";
        const key = decodePathSegment(url.pathname.slice(prefix.length), "media key");
        return withSecurityHeaders(await handlePublicMediaRequest(request, env, key, { siteStateKey: SITE_STATE_KEY, unavailableAssetPath: "/images/unavailable.webp" }));
      }

      if (url.pathname.startsWith("/api/")) {
        return withSecurityHeaders(json({ error: "API endpoint not found." }, 404));
      }

      if (url.pathname === "/robots.txt" || url.pathname === "/bots.txt") {
        return withSecurityHeaders(text(buildRobotsText(request, env), "text/plain; charset=utf-8"));
      }

      if (url.pathname === "/llms.txt" || url.pathname === "/llm.txt") {
        return withSecurityHeaders(text(buildLlmsText(request, env), "text/markdown; charset=utf-8", "no-store"));
      }

      if (url.pathname === "/llms-full.txt") {
        return withSecurityHeaders(text(buildLlmsFullText(request, env), "text/markdown; charset=utf-8", "no-store"));
      }

      if (url.pathname === "/sitemap.xml") {
        return withSecurityHeaders(text(buildSitemapXml(request, env), "application/xml; charset=utf-8"));
      }

      return withSecurityHeaders(await handleAssetRequest(request, env));
    } catch (error) {
      if (error instanceof HttpError) {
        return withSecurityHeaders(json({ error: error.message }, error.status, error.headers));
      }

      console.error(error);
      return withSecurityHeaders(json({ error: "Internal server error." }, 500));
    }
}


export default {
  async fetch(request, env, executionContext = {}) {
    try {
      return await handleRequest(request, env, executionContext);
    } catch (error) {
      if (error instanceof R2UsageQuotaError) {
        return applyCrawlerResponsePolicy(request, json({ error: error.message }, error.status));
      }
      throw error;
    }
  },

  async scheduled(_event, env, executionContext = {}) {
    const task = handleScheduledMaintenance(env, executionContext);
    if (typeof executionContext.waitUntil === "function") {
      executionContext.waitUntil(task);
      return;
    }
    return task;
  }
};

async function handleRequest(request, env, executionContext) {
  const requestContext = createRequestContext(env, executionContext);
  const runtimeEnv = createRuntimeEnvironment(requestContext);

  const probeResponse = await handleProbePathRequest(request);
  if (probeResponse) return applyCrawlerResponsePolicy(request, probeResponse);

  const policyResponse = await handleCrawlerPolicyRequest(request, runtimeEnv);
  if (policyResponse) return policyResponse;

  const publicConfigResponse = await handlePublicConfigRequest(request, runtimeEnv);
  if (publicConfigResponse) return publicConfigResponse;

  const sessionBoundary = await prepareSessionBoundary(request, runtimeEnv);
  request = sessionBoundary.request;

  let authBoundary;
  try {
    authBoundary = await prepareOAuthRateLimitBoundary(request, runtimeEnv);
    request = authBoundary.request;
  } catch (error) {
    if (error instanceof AuthRateLimitBoundaryError) {
      return applyCrawlerResponsePolicy(
        request,
        await sessionBoundary.finalize(json({ error: error.message }, error.status, error.headers))
      );
    }
    throw error;
  }

  const respond = async (response) => {
    const enriched = await enrichAuditResponse(request, response, runtimeEnv);
    const historyOnly = await markHistoryOnlyAuditEntries(enriched);
    const finalized = authBoundary.decorateResponse(await sessionBoundary.finalize(historyOnly));
    const cookieCleaned = appendLegacySessionCleanup(request, finalized);
    const analyticsAware = await applyAnalyticsConsentMarkup(request, cookieCleaned, runtimeEnv);
    return applyCrawlerResponsePolicy(request, analyticsAware);
  };

  if (getPrivateApiClientBoundaryDecision(request, runtimeEnv) === "deny") {
    return respond(json({ error: "Private API client is not authorized." }, 403, {
      "www-authenticate": 'Bearer realm="bbtsl-v1"'
    }));
  }

  if (isExpensiveAuthenticatedReadRequest(request)) {
    try {
      await authorizeExpensiveRead(request, runtimeEnv);
    } catch (error) {
      if (error instanceof MutationAdmissionError) {
        return respond(json({ error: error.message }, error.status, error.headers));
      }
      throw error;
    }
  }

  if (!isSiteStateMutationRequest(request)) {
    return respond(await handleApplicationRequest(request, runtimeEnv));
  }

  let admission;
  try {
    admission = await authorizeSiteStateMutation(request, runtimeEnv);
    request = applyAdmissionRateLimitIdentity(request, admission);
  } catch (error) {
    if (error instanceof MutationAdmissionError) {
      return respond(json({ error: error.message }, error.status, error.headers));
    }
    throw error;
  }

  let boundedRequest = request;
  try {
    boundedRequest = await prepareBoundedMediaUploadRequest(request);
  } catch (error) {
    if (error instanceof MediaUploadBoundaryError) {
      return respond(json({ error: error.message }, error.status));
    }
    throw error;
  }

  let auditRevertRow = null;
  if (isAuditRevertRequest(boundedRequest)) {
    try {
      await migrateAuditLifecycle(runtimeEnv, new Date().toISOString(), 500);
      auditRevertRow = await authorizeAuditRevertRequest(boundedRequest, runtimeEnv);
      assertAuditNotAlreadyReverted(auditRevertRow);
    } catch (error) {
      if (error instanceof AuditRetentionError || error instanceof AuditAlreadyRevertedError) {
        return respond(json({ error: error.message }, error.status));
      }
      throw error;
    }
  }

  try {
    let stateError = null;
    const optimizedCardCommit = isEditorCardCommitRequest(boundedRequest);
    const response = await withSiteStateMutationLock(runtimeEnv, async (lock) => {
      const stateBucket = createStateMutationBucket(runtimeEnv.MEDIA_BUCKET, {
        lock,
        onStateError(error) {
          stateError = error;
        }
      });
      const mutationEnv = { ...runtimeEnv, MEDIA_BUCKET: stateBucket };

      await lock.assertActive();
      if (!optimizedCardCommit) await clearPublicMediaRegistry(mutationEnv);
      if (auditRevertRow?.before_json) {
        await restoreSnapshotMedia(mutationEnv, auditRevertRow.before_json, { lock });
      }
      const result = await handleApplicationRequest(boundedRequest, mutationEnv, { admission });
      if (result.status >= 200 && result.status < 300) {
        if (auditRevertRow?.id) {
          await markAuditReverted(runtimeEnv, auditRevertRow.id);
        }
        if (!optimizedCardCommit) {
          await migrateAuditLifecycle(runtimeEnv, new Date().toISOString(), 500);
          await normalizeDirectMediaForQuarantine(mutationEnv, { lock, limit: 50 });
          await recoverIncompleteQuarantineTransitions(mutationEnv, { lock, limit: 2 });
        }
      }
      if (!optimizedCardCommit) {
        await synchronizePublicMediaRegistry(mutationEnv, lock);
        if (result.status >= 200 && result.status < 300) {
          try {
            await reconcileDetachedMedia(runtimeEnv, admission, { lock });
          } catch (error) {
            console.error("Could not quarantine detached media.", error);
          }
        }
      }
      invalidatePublicMediaRegistry(runtimeEnv);
      return result;
    });

    if (optimizedCardCommit && response.status >= 200 && response.status < 300) {
      await migrateAuditLifecycle(runtimeEnv, new Date().toISOString(), 500).catch((error) => {
        console.error("Could not finalize audit lifecycle after card commit.", error);
      });
    }
    if (stateError instanceof SiteStateQuotaError && response.status >= 500) {
      return respond(json({ error: stateError.message }, stateError.status));
    }
    if (stateError instanceof SiteStateLockError && response.status >= 500) {
      return respond(json({ error: stateError.message }, stateError.status, { "retry-after": "1" }));
    }
    return respond(response);
  } catch (error) {
    if (error instanceof SiteStateLockError) {
      return respond(json({ error: error.message }, error.status, { "retry-after": "1" }));
    }
    throw error;
  }
}

async function handleScheduledMaintenance(env, executionContext) {
  const requestContext = createRequestContext(env, executionContext);
  const runtimeEnv = createRuntimeEnvironment(requestContext);
  return withSiteStateMutationLock(runtimeEnv, async (lock) => {
    const stateBucket = createStateMutationBucket(runtimeEnv.MEDIA_BUCKET, { lock });
    const mutationEnv = { ...runtimeEnv, MEDIA_BUCKET: stateBucket };
    await normalizeDirectMediaForQuarantine(mutationEnv, { lock, limit: 500 });
    return runSecurityMaintenance(mutationEnv, { lock });
  });
}

async function synchronizePublicMediaRegistry(env, lock) {
  await lock.assertActive();
  const stateObject = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!stateObject) {
    throw new Error("Site state is unavailable while synchronizing public media.");
  }
  const state = JSON.parse(await stateObject.text());
  await lock.assertActive();
  await replacePublicMediaRegistry(env, state);
}

function isAuditRevertRequest(request) {
  return request.method === "POST" && new URL(request.url).pathname === "/api/audit/revert";
}

function isEditorCardCommitRequest(request) {
  const pathname = new URL(request.url).pathname;
  return (request.method === "POST" && pathname === "/api/swords/commit")
    || (request.method === "PUT" && /^\/api\/swords\/commit\/\d+$/.test(pathname));
}

function appendLegacySessionCleanup(request, response) {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.append("set-cookie", buildLegacyCookieExpiry("bbtsl_session", "/", "bbtsl.lol"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function buildLegacyCookieExpiry(name, path, domain) {
  return [
    `${name}=`,
    `Path=${path}`,
    `Domain=${domain}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Secure"
  ].join("; ");
}

async function handleAssetRequest(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", HTML_SECURITY_HEADERS["referrer-policy"]);
  headers.set("x-content-type-options", HTML_SECURITY_HEADERS["x-content-type-options"]);
  headers.set("x-frame-options", HTML_SECURITY_HEADERS["x-frame-options"]);
  headers.set("permissions-policy", HTML_SECURITY_HEADERS["permissions-policy"]);
  headers.set("cross-origin-opener-policy", HTML_SECURITY_HEADERS["cross-origin-opener-policy"]);
  headers.set("strict-transport-security", HTML_SECURITY_HEADERS["strict-transport-security"]);

  const contentType = headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const nonce = createCspNonce();
    headers.set("content-security-policy", buildContentSecurityPolicy(nonce));
    headers.set("cache-control", BF_CACHE_SAFE_HTML_CACHE_CONTROL);
    const html = await response.text();
    return new Response(await injectDynamicHeadMarkup(html, request, env, nonce), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  if (contentType.includes("font")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (contentType.includes("text/css") || contentType.includes("javascript")) {
    const url = new URL(request.url);
    const isFingerprint = /\.\d{8}(?:\.\d+)?\.(?:css|js)$/.test(url.pathname);
    headers.set("cache-control", url.searchParams.has("v") || isFingerprint ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleStaticPageRequest(request, env, assetPath) {
  const assetUrl = new URL(assetPath, request.url);
  const assetRequest = new Request(assetUrl.toString(), {
    method: "GET",
    headers: request.headers
  });
  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);
  const nonce = createCspNonce();
  headers.set("content-security-policy", buildContentSecurityPolicy(nonce));
  headers.set("cross-origin-opener-policy", HTML_SECURITY_HEADERS["cross-origin-opener-policy"]);
  headers.set("strict-transport-security", HTML_SECURITY_HEADERS["strict-transport-security"]);
  headers.set("cache-control", BF_CACHE_SAFE_HTML_CACHE_CONTROL);
  const html = await response.text();
  if (request.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  return new Response(await injectDynamicHeadMarkup(html, request, env, nonce), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleAuthStatus(request, env) {
  const actor = await getActorFromRequest(request, env);
  return json(buildAuthStatusResponse(actor), 200, { "cache-control": BF_CACHE_SAFE_JSON_CACHE_CONTROL });
}

async function handleAuthStart(request, env, url) {
  await consumeRateLimit(env, AUTH_VERIFY_BUCKET, getClientIdentifier(request), OAUTH_RATE_LIMIT, 300);
  const purpose = sanitizeOptionalString(url.searchParams.get("purpose"), 32) || "login";
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const state = await buildDiscordAuthorizeUrl(request, env, purpose, returnTo);
  return new Response(null, {
    status: 302,
    headers: {
      location: state.authorizeUrl,
      "set-cookie": buildOAuthStateCookie(request, state.nonce, OAUTH_STATE_LIFETIME_SECONDS)
    }
  });
}

async function handleAuthCallback(request, env, url) {
  await consumeRateLimit(env, AUTH_VERIFY_BUCKET, getClientIdentifier(request), OAUTH_RATE_LIMIT, 300);
  const error = url.searchParams.get("error");
  if (error) {
    return Response.redirect(new URL("/?login=cancelled", request.url), 302);
  }

  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) {
    throw new HttpError(400, "Missing Discord login state.");
  }

  const state = await verifySignedToken(env, stateToken, "oauth");
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (!state || !state.nonce || !timingSafeEqual(cookies[OAUTH_STATE_COOKIE] || "", state.nonce)) {
    throw new HttpError(400, "Discord login state is invalid or expired.");
  }
  const tokenResponse = await exchangeDiscordCode(env, code);
  const discordUser = await fetchDiscordIdentity(tokenResponse.access_token);
  const user = await upsertDiscordUser(env, discordUser);
  const existingSession = await readSession(request, env);
  const cookie = await issueSessionCookie(request, env, {
    userId: user.id,
    purpose: state.purpose || "login",
    returnTo: state.returnTo || "/",
    systemMode: Boolean(existingSession?.systemMode && canUseSystemAccount(user))
  });

  const redirectUrl = new URL(state.returnTo || "/", request.url);
  redirectUrl.searchParams.set("login", state.purpose === "login" ? "success" : "reauth-success");
  const headers = new Headers({ location: redirectUrl.toString() });
  headers.append("set-cookie", cookie);
  headers.append("set-cookie", buildOAuthStateCookie(request, "", 0));
  return new Response(null, {
    status: 302,
    headers
  });
}

async function handleAuthLogout(request) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  return new Response(JSON.stringify({ authenticated: false }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "set-cookie": buildSessionCookie(request, "", 0)
    }
  });
}

async function handleAuthSystemSession(request, env) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const actor = await getActorFromRequest(request, env);
  const baseUser = actor?.baseUser || actor?.user || null;
  if (!baseUser) {
    throw new HttpError(401, "Sign in with Discord to continue.");
  }
  if (!canUseSystemAccount(baseUser)) {
    throw new HttpError(403, "You do not have permission to use the BBTSL System account.");
  }

  const cookie = await issueSessionCookie(request, env, {
    userId: baseUser.id,
    purpose: "login",
    existingReauthAt: actor?.session?.reauthAt || actor?.session?.iat || 0,
    systemMode: true
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "set-cookie": cookie
    }
  });
}

async function handleListSwords(request, env, url) {
  const actor = await getActorFromRequest(request, env);
  const category = url.searchParams.get("category");
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sort = url.searchParams.get("sort") || "value-desc";
  const state = await loadSiteState(env);
  const sortFn = getSwordSorter(sort);
  const results = (state.swords || [])
    .filter((row) => !category || category === "All" || row.c === category)
    .filter((row) => matchesSwordSearch(row, search))
    .sort(sortFn);
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(results));
  return json({
    swords: results.map((row) => serializeSword(row, mediaMap)),
    auth: buildAuthStatusResponse(actor)
  }, 200, { "cache-control": BF_CACHE_SAFE_JSON_CACHE_CONTROL });
}

function handlePublicApiHealth() {
  return privateApiJson({
    data: {
      ok: true,
      service: "bbtsl-private-api",
      version: "v1",
      keyWindowStartsAt: `${currentUtcDateString()}T00:00:00Z`,
      keyWindowEndsAt: `${getNextUtcDateString(currentUtcDateString())}T00:00:00Z`
    }
  });
}

async function handlePublicApiListSwords(request, env, url) {
  const authContext = await requirePrivateApiAccess(request, env);
  await consumeRateLimit(env, PRIVATE_API_BUCKET, `${authContext.clientId}:${getClientIdentifier(request)}`, 180, 60);
  const query = parsePrivateSwordQuery(url);
  const state = await loadSiteState(env);
  const filteredRows = filterPrivateSwordRows(state.swords || [], query);
  const rows = filteredRows.slice(query.offset, query.offset + query.limit);
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(rows));
  return privateApiJson({
    data: rows.map((row) => serializePrivateApiSword(row, mediaMap)),
    meta: {
      version: "v1",
      generatedAt: currentIsoString(),
      clientId: authContext.clientId,
      total: filteredRows.length,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + rows.length < filteredRows.length,
      filters: {
        category: query.category || null,
        demand: query.demand || null,
        trend: query.trend || null,
        cardId: query.cardId || null,
        search: query.search || null,
        sort: query.sort
      }
    }
  });
}

async function handlePublicApiGetSword(request, env, url) {
  const authContext = await requirePrivateApiAccess(request, env);
  await consumeRateLimit(env, PRIVATE_API_BUCKET, `${authContext.clientId}:${getClientIdentifier(request)}`, 180, 60);
  const cardId = parseCardIdPath(url.pathname, "/api/v1/swords/");
  const row = await getSwordByCardId(env, cardId);
  if (!row) {
    throw new HttpError(404, "Sword not found.");
  }
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([row]));
  return privateApiJson({
    data: serializePrivateApiSword(row, mediaMap),
    meta: {
      version: "v1",
      generatedAt: currentIsoString(),
      clientId: authContext.clientId
    }
  });
}

async function handleItemMetaImage(request, env, url) {
  const cardId = parseMetaItemCardIdPath(url.pathname);
  const state = await loadSiteState(env);
  const row = getSiteSwordByCardId(state, cardId);
  if (!row) {
    throw new HttpError(404, "Sword not found.");
  }
  const mediaMap = buildSiteMediaDescriptorMap(state, collectSwordMediaKeys([row]));
  const sword = serializeSword(row, mediaMap);
  const svg = buildItemMetaSvg(sword);
  const headers = {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=300"
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(svg, { status: 200, headers });
}

async function handlePublicApiTeam(request, env) {
  const authContext = await requirePrivateApiAccess(request, env);
  await consumeRateLimit(env, PRIVATE_API_BUCKET, `${authContext.clientId}:${getClientIdentifier(request)}`, 180, 60);
  const { placeholders, values } = getPublicTeamRoleFilter();
  const { results } = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at
    FROM users
    WHERE status = 'active' AND role IN (${placeholders})
    ORDER BY role_sort DESC, updated_at DESC, id ASC
  `).bind(...values).all();
  return privateApiJson({
    data: (results || []).map((row) => serializePrivateApiTeamUser(row)),
    meta: {
      version: "v1",
      generatedAt: currentIsoString(),
      clientId: authContext.clientId,
      total: Number((results || []).length)
    }
  });
}

async function handleStageMedia(request, env, actor) {
  try {
    const result = await handleStagedMediaUpload(request, env, actor);
    return json(result, result.reused ? 200 : 201);
  } catch (error) {
    if (error instanceof StagedMediaUploadError || error instanceof StagedMediaStoreError) {
      throw new HttpError(error.status || 500, error.message);
    }
    throw error;
  }
}

export async function handleEditorCardCommit(request, env, id, actor, options = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Card commit body must be valid JSON.");
  }
  const idempotencyKey = requireCommitId(body?.idempotencyKey);
  const expectedRevision = normalizeExpectedRevision(body?.expectedRevision, id === null);
  const actorUserId = Number(actor?.user?.id ?? actor?.id);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) throw new HttpError(401, "An authenticated editor is required.");
  const payload = normalizeSwordPayload(body || {});
  const state = await (options.loadSiteState || loadSiteState)(env, { fresh: true });
  const existing = id === null ? null : getSiteSwordById(state, id);
  if (id !== null && !existing) throw new HttpError(404, "Sword not found.");

  const replay = (state.swords || []).find((row) => row.last_commit_id === idempotencyKey
    && Number(row.last_commit_actor_user_id) === actorUserId
    && (id === null || Number(row.id) === Number(id)));
  if (replay) {
    const replayMap = buildSiteMediaDescriptorMap(state, collectSwordMediaKeys([replay]));
    const afterSnapshot = serializeSword(replay, replayMap);
    const beforeSnapshot = replay.last_commit_before && typeof replay.last_commit_before === "object"
      ? cloneJson(replay.last_commit_before)
      : null;
    await applyEditorRegistryDelta(options.updatePublicMediaRegistryDelta || updatePublicMediaRegistryDelta, env, { addKeys: physicalKeysForSword(state, replay) });
    await (options.writeAuditLog || writeAuditLog)(env, {
      actor,
      commitId: idempotencyKey,
      actionType: replay.last_commit_action_type || (beforeSnapshot ? "sword.update" : "sword.create"),
      entityType: "sword",
      entityId: replay.id,
      entityPublicId: replay.card_id,
      summary: `${beforeSnapshot ? "Updated" : "Created"} ${replay.n}`,
      beforeSnapshot,
      afterSnapshot
    });
    await (options.markStagedMediaCommitted || markStagedMediaCommitted)(env, collectStagedMediaIds(payload), actorUserId, idempotencyKey).catch(() => {});
    return json({ sword: afterSnapshot, replayed: true }, id === null ? 201 : 200);
  }

  if (id === null) {
    if (expectedRevision !== 0) throw new HttpError(409, "The new card revision is stale. Reload and try again.");
  } else if (Number(existing.revision || 1) !== expectedRevision) {
    throw new HttpError(409, "This card changed while you were editing it. Reload the card and apply your changes again.");
  }

  const references = collectStagedMediaReferences(payload);
  let stagedRows;
  try {
    stagedRows = await (options.loadStagedMediaForCommit || loadStagedMediaForCommit)(env, references, actorUserId, options.now);
  } catch (error) {
    if (error instanceof StagedMediaStoreError) throw new HttpError(error.status, error.message);
    throw error;
  }
  const stagedByVariant = new Map(stagedRows.map((row) => [row.variant, row]));
  const beforeState = cloneJson(state);
  const beforeSnapshot = existing
    ? serializeSword(existing, buildSiteMediaDescriptorMap(beforeState, collectSwordMediaKeys([existing])))
    : null;
  const now = currentUtcDateString();
  const mediaKeys = resolveCommittedMediaKeys(payload, existing, state, stagedByVariant);
  const record = normalizeSiteSwordRecord({
    ...(existing || {}),
    id: existing?.id || getNextSwordId(state),
    card_id: existing?.card_id || await (options.generateUniqueCardId || generateUniqueCardId)(env, state),
    n: payload.n,
    c: payload.c,
    v: payload.v,
    d: payload.d,
    t: payload.t,
    ct: payload.ct,
    u: options.date || now,
    descr: payload.descr,
    image_key: mediaKeys.img,
    detail_image_key: mediaKeys.detailMedia,
    slash_media_key: mediaKeys.slashMedia,
    slash_audio_key: mediaKeys.slashAudio,
    finisher_media_key: mediaKeys.finisherMedia,
    owners_choice: payload.ownersChoice ? 1 : 0,
    edited: 1,
    revision: existing ? Number(existing.revision || 1) + 1 : 1,
    last_commit_id: idempotencyKey,
    last_commit_actor_user_id: actorUserId,
    last_commit_action_type: existing ? "sword.update" : "sword.create",
    last_commit_before: beforeSnapshot
  });

  const nextState = cloneJson(state);
  nextState.mediaVariants = { ...(nextState.mediaVariants || {}) };
  nextState.mediaObjects = { ...(nextState.mediaObjects || {}) };
  nextState.usage = { monthly: nextState.usage?.monthly || {}, totalStorageBytes: Number(nextState.usage?.totalStorageBytes || 0) };
  let addedBytes = 0;
  for (const row of stagedRows) {
    nextState.mediaVariants[row.baseKey] = cloneJson(row.descriptor);
    for (const object of row.objects) {
      if (!nextState.mediaObjects[object.mediaKey]) addedBytes += Number(object.sizeBytes || 0);
      nextState.mediaObjects[object.mediaKey] = cloneJson(object);
    }
  }
  nextState.usage.totalStorageBytes += addedBytes;
  if (nextState.usage.totalStorageBytes > R2_STORAGE_LIMIT_BYTES) throw new HttpError(507, "R2 storage limit reached.");
  nextState.swords = upsertSiteSwordRecord(nextState.swords, record);

  const beforeKeys = collectLivePhysicalMediaKeys(beforeState);
  const afterKeys = collectLivePhysicalMediaKeys(nextState);
  const removeKeys = [...beforeKeys].filter((key) => !afterKeys.has(key));
  const addKeys = [...afterKeys].filter((key) => !beforeKeys.has(key));
  const applyRegistryDelta = options.updatePublicMediaRegistryDelta || updatePublicMediaRegistryDelta;
  await applyEditorRegistryDelta(applyRegistryDelta, env, { removeKeys });
  try {
    await (options.writeSiteStateObject || writeSiteStateObject)(env, nextState);
  } catch (error) {
    try {
      await applyEditorRegistryDelta(applyRegistryDelta, env, { addKeys: removeKeys });
    } catch (rollbackError) {
      console.error("Could not restore public media registry after a failed card state write.", rollbackError);
    }
    throw error;
  }
  await applyEditorRegistryDelta(applyRegistryDelta, env, { addKeys });

  const afterSnapshot = serializeSword(record, buildSiteMediaDescriptorMap(nextState, collectSwordMediaKeys([record])));
  await (options.writeAuditLog || writeAuditLog)(env, {
    actor,
    commitId: idempotencyKey,
    actionType: existing ? "sword.update" : "sword.create",
    entityType: "sword",
    entityId: record.id,
    entityPublicId: record.card_id,
    summary: `${existing ? "Updated" : "Created"} ${record.n}`,
    beforeSnapshot,
    afterSnapshot
  });
  await (options.markStagedMediaCommitted || markStagedMediaCommitted)(env, stagedRows.map((row) => row.id), actorUserId, idempotencyKey, options.now);
  return json({ sword: afterSnapshot, replayed: false }, existing ? 200 : 201);
}

async function applyEditorRegistryDelta(updateDelta, env, changes) {
  try {
    return await updateDelta(env, changes);
  } catch (error) {
    if (error instanceof PublicMediaRegistryStateError || error?.name === "PublicMediaRegistryStateError") {
      throw new HttpError(Number(error.status || 503), error.message || "Public media registry is unavailable.", {
        "retry-after": "1"
      });
    }
    throw error;
  }
}

async function handleCreateSword(request, env, actor) {
  const payload = normalizeSwordPayload(await request.json());
  const { image, detailMedia, slashMedia, slashAudio, finisherMedia } = await persistSwordMedia(env, payload, payload.n);
  const state = await loadSiteState(env);
  const cardId = await generateUniqueCardId(env, state);
  const now = currentUtcDateString();
  const created = normalizeSiteSwordRecord({
    id: getNextSwordId(state),
    card_id: cardId,
    n: payload.n,
    c: payload.c,
    v: payload.v,
    d: payload.d,
    t: payload.t,
    ct: payload.ct,
    u: now,
    descr: payload.descr,
    image_key: image.mediaKey,
    detail_image_key: detailMedia.mediaKey,
    slash_media_key: slashMedia.mediaKey,
    slash_audio_key: slashAudio.mediaKey,
    finisher_media_key: finisherMedia.mediaKey,
    owners_choice: payload.ownersChoice ? 1 : 0,
    edited: 1
  });
  await updateSiteState(env, (currentState) => ({
    ...currentState,
    swords: upsertSiteSwordRecord(currentState.swords, created)
  }));
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([created]));
  await writeAuditLog(env, {
    actor,
    actionType: "sword.create",
    entityType: "sword",
    entityId: created.id,
    entityPublicId: created.card_id,
    summary: `Created ${created.n}`,
    beforeSnapshot: null,
    afterSnapshot: serializeSword(created, mediaMap)
  });

  return json({ sword: serializeSword(created, mediaMap) }, 201);
}

async function handleUpdateSword(request, env, id, actor) {
  const existing = await getSwordById(env, id);
  if (!existing) {
    throw new HttpError(404, "Sword not found.");
  }

  const payload = normalizeSwordPayload(await request.json());
  const { image, detailMedia, slashMedia, slashAudio, finisherMedia } = await persistSwordMedia(env, payload, payload.n, existing);
  const beforeMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([existing]));
  const beforeSnapshot = serializeSword(existing, beforeMediaMap);

  const updated = normalizeSiteSwordRecord({
    ...existing,
    n: payload.n,
    c: payload.c,
    v: payload.v,
    d: payload.d,
    t: payload.t,
    ct: payload.ct,
    u: currentUtcDateString(),
    descr: payload.descr,
    image_key: image.mediaKey,
    detail_image_key: detailMedia.mediaKey,
    slash_media_key: slashMedia.mediaKey,
    slash_audio_key: slashAudio.mediaKey,
    finisher_media_key: finisherMedia.mediaKey,
    owners_choice: payload.ownersChoice ? 1 : 0,
    edited: 1
  });
  await updateSiteState(env, (currentState) => ({
    ...currentState,
    swords: upsertSiteSwordRecord(currentState.swords, updated)
  }));
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([updated]));
  await writeAuditLog(env, {
    actor,
    actionType: "sword.update",
    entityType: "sword",
    entityId: updated.id,
    entityPublicId: updated.card_id,
    summary: `Updated ${updated.n}`,
    beforeSnapshot,
    afterSnapshot: serializeSword(updated, mediaMap)
  });

  return json({ sword: serializeSword(updated, mediaMap) });
}

async function handleUploadMedia(request, env) {
  const body = await request.json();
  const swordName = requireString(body.n, "Name");
  const variant = requireEnum(body.variant, MEDIA_VARIANTS, "Media type");
  const stored = await persistMedia(env, body.media, swordName, variant);
  return json({ mediaKey: stored.mediaKey }, 201);
}

async function handleDeleteSword(request, env, id, actor) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const existing = await getSwordById(env, id);
  if (!existing) {
    throw new HttpError(404, "Sword not found.");
  }
  const beforeMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([existing]));

  await updateSiteState(env, (currentState) => ({
    ...currentState,
    swords: removeSiteSwordRecord(currentState.swords, id)
  }));
  await writeAuditLog(env, {
    actor,
    actionType: "sword.delete",
    entityType: "sword",
    entityId: existing.id,
    entityPublicId: existing.card_id,
    summary: `Deleted ${existing.n}`,
    beforeSnapshot: serializeSword(existing, beforeMediaMap),
    afterSnapshot: null
  });

  return json({ ok: true });
}

async function handleReset(request, env, actor, session) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const body = await request.json().catch(() => ({}));
  if (String(body.confirmation || "").trim() !== "I confirm the Reset") {
    throw new HttpError(400, "Reset confirmation phrase is invalid.");
  }
  requireFreshReauth(session);

  const state = await loadSiteState(env);
  const beforeResults = (state.swords || []).map((row) => normalizeSiteSwordRecord(row));
  const beforeMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(beforeResults));
  const afterResults = (state.baseline || []).map((row) => normalizeSiteSwordRecord(row));
  await updateSiteState(env, (currentState) => ({
    ...currentState,
    swords: afterResults.map((row) => normalizeSiteSwordRecord(row))
  }));
  const afterMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(afterResults));

  await writeAuditLog(env, {
    actor,
    actionType: "data.reset",
    entityType: "collection",
    entityId: null,
    entityPublicId: null,
    summary: "Reset swords to baseline",
    beforeSnapshot: beforeResults.map((row) => serializeSword(row, beforeMediaMap)),
    afterSnapshot: afterResults.map((row) => serializeSword(row, afterMediaMap))
  });

  return json({
    ok: true,
    swords: afterResults.map((row) => serializeSword(row, afterMediaMap))
  });
}

async function handleExport(env, actor) {
  const state = await loadSiteState(env);
  const results = [...(state.swords || [])].sort(getSwordSorter("value-desc"));
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(results));
  await writeAuditLog(env, {
    actor,
    actionType: "data.export",
    entityType: "collection",
    entityId: null,
    entityPublicId: null,
    summary: "Exported sword data",
    beforeSnapshot: null,
    afterSnapshot: { count: Number(results.length) }
  });
  return json({ swords: results.map((row) => serializeSword(row, mediaMap)) });
}

async function handleListTeam(request, env) {
  const actor = await getActorFromRequest(request, env);
  const includeAll = hasCapability(actor?.user?.role, "team:manage");
  const { placeholders, values } = getPublicTeamRoleFilter();
  const sql = includeAll
    ? "SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE role != ? AND discord_user_id != ? ORDER BY role_sort DESC, updated_at DESC, id ASC"
    : `SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE status = 'active' AND role IN (${placeholders}) ORDER BY role_sort DESC, updated_at DESC, id ASC`;
  const bindings = includeAll ? ["Viewer", SYSTEM_DISCORD_USER_ID] : values;
  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return json({
    team: (results || []).map((row) => includeAll ? serializeTeamUser(row) : serializePublicTeamUser(row)),
    auth: buildAuthStatusResponse(actor)
  }, 200, { "cache-control": BF_CACHE_SAFE_JSON_CACHE_CONTROL });
}

async function handleCreateTeamUser(request, env, actor) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const body = await request.json().catch(() => ({}));
  const discordUserId = sanitizeDiscordId(body.discordUserId);
  const role = requireRole(body.role);
  const username = sanitizeOptionalString(body.username, 100);
  const globalName = sanitizeOptionalString(body.globalName, 100);
  const avatarHash = sanitizeOptionalString(body.avatarHash, 128);
  if (discordUserId === SYSTEM_DISCORD_USER_ID) {
    throw new HttpError(403, "The system account cannot be changed.");
  }

  const existing = await env.DB.prepare("SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE discord_user_id = ?").bind(discordUserId).first();
  if (existing) {
    const beforeSnapshot = serializeTeamUser(existing);
    const now = currentIsoString();
    await env.DB.prepare(`
      UPDATE users
      SET username = ?, global_name = ?, avatar_hash = ?, role = ?, role_sort = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `).bind(
      username || existing.username || "",
      globalName || existing.global_name || "",
      avatarHash || existing.avatar_hash || "",
      role,
      getRoleSort(role),
      now,
      existing.id
    ).run();

    const updated = await env.DB.prepare("SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE id = ?").bind(existing.id).first();
    await writeAuditLog(env, {
      actor,
      actionType: "team.user.update",
      entityType: "user",
      entityId: updated.id,
      entityPublicId: updated.discord_user_id,
      summary: `Updated team user ${updated.username || updated.global_name || updated.discord_user_id}`,
      beforeSnapshot,
      afterSnapshot: serializeTeamUser(updated)
    });

    return json({ user: serializeTeamUser(updated), reused: true });
  }

  const now = currentIsoString();
  await env.DB.prepare(`
    INSERT INTO users (discord_user_id, username, global_name, avatar_hash, role, role_sort, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    discordUserId,
    username,
    globalName,
    avatarHash,
    role,
    getRoleSort(role),
    now,
    now
  ).run();

  const created = await env.DB.prepare("SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE discord_user_id = ?").bind(discordUserId).first();
  await writeAuditLog(env, {
    actor,
    actionType: "team.user.create",
    entityType: "user",
    entityId: created.id,
    entityPublicId: created.discord_user_id,
    summary: `Created team user ${created.username || created.global_name || created.discord_user_id}`,
    beforeSnapshot: null,
    afterSnapshot: serializeTeamUser(created)
  });

  return json({ user: serializeTeamUser(created) }, 201);
}

async function handleUpdateTeamUser(request, env, id, actor) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const existing = await env.DB.prepare("SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE id = ?").bind(id).first();
  if (!existing) {
    throw new HttpError(404, "Team user not found.");
  }
  if (existing.discord_user_id === SYSTEM_DISCORD_USER_ID) {
    throw new HttpError(403, "The system account cannot be changed.");
  }

  const body = await request.json().catch(() => ({}));
  const role = body.role !== undefined ? requireRole(body.role) : existing.role;
  const username = body.username !== undefined ? sanitizeOptionalString(body.username, 100) : existing.username;
  const globalName = body.globalName !== undefined ? sanitizeOptionalString(body.globalName, 100) : existing.global_name;
  const avatarHash = body.avatarHash !== undefined ? sanitizeOptionalString(body.avatarHash, 128) : existing.avatar_hash;
  const status = body.status !== undefined ? requireStatus(body.status) : existing.status;
  const beforeSnapshot = serializeTeamUser(existing);

  await env.DB.prepare(`
    UPDATE users
    SET username = ?, global_name = ?, avatar_hash = ?, role = ?, role_sort = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    username,
    globalName,
    avatarHash,
    role,
    getRoleSort(role),
    status,
    currentIsoString(),
    id
  ).run();

  const updated = await env.DB.prepare("SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE id = ?").bind(id).first();
  await writeAuditLog(env, {
    actor,
    actionType: "team.user.update",
    entityType: "user",
    entityId: updated.id,
    entityPublicId: updated.discord_user_id,
    summary: `Updated team user ${updated.username || updated.global_name || updated.discord_user_id}`,
    beforeSnapshot,
    afterSnapshot: serializeTeamUser(updated)
  });

  return json({ user: serializeTeamUser(updated) });
}

async function handleListAudit(url, env) {
  const filters = [];
  const bindings = [];

  const entityPublicId = sanitizeOptionalString(url.searchParams.get("cardId"), 16);
  if (entityPublicId) {
    filters.push("entity_public_id = ?");
    bindings.push(entityPublicId);
  }

  const actorUserId = url.searchParams.get("actorUserId");
  if (actorUserId && /^\d+$/.test(actorUserId)) {
    filters.push("actor_user_id = ?");
    bindings.push(Number(actorUserId));
  }

  const actionType = sanitizeOptionalString(url.searchParams.get("actionType"), 80);
  if (actionType) {
    filters.push("action_type = ?");
    bindings.push(actionType);
  }

  const role = sanitizeOptionalString(url.searchParams.get("role"), 32);
  if (role) {
    filters.push("actor_role = ?");
    bindings.push(role);
  }

  const search = sanitizeOptionalString(url.searchParams.get("search"), 120);
  if (search) {
    filters.push("(summary LIKE ? OR diff_json LIKE ?)");
    bindings.push(`%${search}%`, `%${search}%`);
  }

  const sql = `
    SELECT
      audit_logs.id,
      audit_logs.actor_user_id,
      audit_logs.actor_role,
      audit_logs.action_type,
      audit_logs.entity_type,
      audit_logs.entity_id,
      audit_logs.entity_public_id,
      audit_logs.summary,
      audit_logs.diff_json,
      audit_logs.before_json,
      audit_logs.after_json,
      audit_logs.created_at,
      users.username AS actor_username,
      users.global_name AS actor_global_name
    FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.actor_user_id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
    LIMIT 250
  `;
  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return json({ logs: (results || []).map(serializeAuditLog) });
}

async function handleAuditRevert(request, env, actor, session) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  requireFreshReauth(session);

  const body = await request.json().catch(() => ({}));
  if (String(body.confirmation || "").trim() !== "I confirm the revert") {
    throw new HttpError(400, "Revert confirmation phrase is invalid.");
  }

  const logId = clampInteger(body.logId, 1, Number.MAX_SAFE_INTEGER, "Audit log");
  const mode = body.mode === "field" ? "field" : "snapshot";
  const fieldName = sanitizeOptionalString(body.fieldName, 64);
  const row = await env.DB.prepare(`
    SELECT id, action_type, entity_id, entity_public_id, before_json, after_json
    FROM audit_logs
    WHERE id = ?
  `).bind(logId).first();
  if (!row) {
    throw new HttpError(404, "Audit log not found.");
  }

  if (!String(row.action_type || "").startsWith("sword.")) {
    throw new HttpError(400, "Only sword-related audit entries can be reverted right now.");
  }

  const beforeSnapshot = parseJsonField(row.before_json);
  const current = row.entity_id ? await getSwordById(env, Number(row.entity_id)) : null;
  if (!current && !beforeSnapshot) {
    throw new HttpError(400, "This audit entry cannot be reverted.");
  }

  if (mode === "field") {
    if (!fieldName) {
      throw new HttpError(400, "A field name is required for field reverts.");
    }
    if (!beforeSnapshot || !Object.prototype.hasOwnProperty.call(beforeSnapshot, fieldName)) {
      throw new HttpError(400, "The selected field is not available in that audit entry.");
    }
    const payload = swordPayloadFromSnapshot(serializeSword(current || beforeSnapshot));
    payload[fieldName] = beforeSnapshot[fieldName];
    await applySwordSnapshotUpdate(env, current?.id || beforeSnapshot.id, payload);
  } else {
    if (!beforeSnapshot) {
      throw new HttpError(400, "This audit entry does not contain a snapshot to restore.");
    }
    await restoreSwordSnapshot(env, beforeSnapshot);
  }

  const updated = await getSwordById(env, Number(row.entity_id));
  const currentMediaMap = current ? await loadMediaDescriptorMap(env, collectSwordMediaKeys([current])) : new Map();
  const updatedMediaMap = updated ? await loadMediaDescriptorMap(env, collectSwordMediaKeys([updated])) : new Map();
  await writeAuditLog(env, {
    actor,
    actionType: "audit.revert",
    entityType: "sword",
    entityId: updated?.id || Number(row.entity_id),
    entityPublicId: updated?.card_id || row.entity_public_id,
    summary: `Reverted audit log #${logId}`,
    beforeSnapshot: current ? serializeSword(current, currentMediaMap) : null,
    afterSnapshot: updated ? serializeSword(updated, updatedMediaMap) : beforeSnapshot
  });

  return json({ ok: true, sword: updated ? serializeSword(updated, updatedMediaMap) : null });
}

async function assertInternalMaintenanceAccess(request, env) {
  const expectedSecret = String(env.MEDIA_MIGRATION_SECRET || "");
  const providedSecret = request.headers.get("x-bbtsl-maintenance-key") || "";
  if (!expectedSecret || providedSecret !== expectedSecret) {
    throw new HttpError(404, "Not found.");
  }
}

function getPrivateApiClientSecrets(env) {
  const raw = String(env.V1_API_CLIENT_SECRETS || "").trim();
  if (!raw) {
    throw new HttpError(500, "V1_API_CLIENT_SECRETS is not configured.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(500, "V1_API_CLIENT_SECRETS is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(500, "V1_API_CLIENT_SECRETS must be an object.");
  }
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([clientId, secret]) => [String(clientId).trim(), String(secret || "").trim()])
      .filter(([clientId, secret]) => clientId && secret)
  );
}

function getPrivateApiBearerToken(request) {
  const authorization = String(request.headers.get("authorization") || "").trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

async function derivePrivateApiDailyKey(secret, clientId, dateString) {
  const digest = await hmacHex(secret, `bbtsl-v1:${clientId}:${dateString}`, "V1_API_CLIENT_SECRETS");
  return digest.slice(0, PRIVATE_API_KEY_HEX_LENGTH);
}

async function requirePrivateApiAccess(request, env) {
  const clientId = String(request.headers.get(PRIVATE_API_CLIENT_HEADER) || "").trim();
  const dateString = String(request.headers.get(PRIVATE_API_DATE_HEADER) || "").trim();
  const providedKey = getPrivateApiBearerToken(request);
  if (!clientId || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(clientId)) {
    throw new HttpError(401, "Private API client header is missing or invalid.", { "www-authenticate": 'Bearer realm="bbtsl-v1"' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString) || dateString !== currentUtcDateString()) {
    throw new HttpError(401, "Private API date header is missing or invalid.", { "www-authenticate": 'Bearer realm="bbtsl-v1"' });
  }
  if (!/^[a-f0-9]{32}$/i.test(providedKey)) {
    throw new HttpError(401, "Private API key is missing or invalid.", { "www-authenticate": 'Bearer realm="bbtsl-v1"' });
  }
  const secrets = getPrivateApiClientSecrets(env);
  const secret = secrets[clientId];
  if (!secret) {
    throw new HttpError(403, "Private API client is not authorized.");
  }
  const expectedKey = await derivePrivateApiDailyKey(secret, clientId, dateString);
  if (!timingSafeEqual(providedKey.toLowerCase(), expectedKey.toLowerCase())) {
    throw new HttpError(403, "Private API credentials are invalid.");
  }
  return { clientId, dateString };
}

async function handleInternalMediaReconcile(request, env) {
  await assertInternalMaintenanceAccess(request, env);
  const state = await loadSiteState(env, { fresh: true });
  let normalized = 0;
  const nextMediaVariants = {};
  const nextMediaObjects = {};
  const rewriteKey = (mediaKey) => {
    const normalizedKey = normalizeStoredMediaKey(mediaKey);
    if (normalizedKey !== mediaKey) {
      normalized += 1;
    }
    return normalizedKey;
  };

  for (const [baseKey, variant] of Object.entries(state.mediaVariants || {})) {
    const normalizedBaseKey = normalizeStoredMediaKey(baseKey);
    nextMediaVariants[normalizedBaseKey] = {
      ...variant,
      baseKey: normalizedBaseKey,
      lowKey: rewriteKey(variant.lowKey),
      mediumKey: rewriteKey(variant.mediumKey),
      originalKey: rewriteKey(variant.originalKey)
    };
  }

  for (const [mediaKey, mediaObject] of Object.entries(state.mediaObjects || {})) {
    const normalizedKey = rewriteKey(mediaKey);
    nextMediaObjects[normalizedKey] = {
      ...mediaObject,
      mediaKey: normalizedKey
    };
  }

  await updateSiteState(env, (currentState) => ({
    ...currentState,
    swords: (currentState.swords || []).map((row) => ({
      ...row,
      image_key: row.image_key ? rewriteKey(row.image_key) : null,
      detail_image_key: row.detail_image_key ? rewriteKey(row.detail_image_key) : null,
      slash_media_key: row.slash_media_key ? rewriteKey(row.slash_media_key) : null,
      slash_audio_key: row.slash_audio_key ? rewriteKey(row.slash_audio_key) : null
    })),
    baseline: (currentState.baseline || []).map((row) => ({
      ...row,
      image_key: row.image_key ? rewriteKey(row.image_key) : null,
      detail_image_key: row.detail_image_key ? rewriteKey(row.detail_image_key) : null,
      slash_media_key: row.slash_media_key ? rewriteKey(row.slash_media_key) : null,
      slash_audio_key: row.slash_audio_key ? rewriteKey(row.slash_audio_key) : null
    })),
    mediaVariants: nextMediaVariants,
    mediaObjects: nextMediaObjects
  }));
  invalidatePublicMediaRegistry(env);

  return json({ ok: true, normalized });
}

async function requireCapability(request, env, capability, fn, rateOptions = {}) {
  if (request.method !== "GET") {
    enforceTrustedOrigin(request);
    enforceAppRequest(request);
    await consumeRateLimit(
      env,
      rateOptions.bucket || ADMIN_MUTATION_BUCKET,
      getClientIdentifier(request),
      Number(rateOptions.limit || 60),
      Number(rateOptions.windowSeconds || 300)
    );
  }

  const actor = await getActorFromRequest(request, env);
  if (!actor?.user) {
    throw new HttpError(401, "Sign in with Discord to continue.");
  }
  if (!hasCapability(actor.user.role, capability)) {
    throw new HttpError(403, "You do not have permission to perform this action.");
  }

  return fn({ actor, session: actor.session, user: actor.user });
}

function requireAdmittedCapability(admission, capability, fn) {
  if (!admission?.actor?.user || admission.capability !== capability) {
    throw new HttpError(403, "The card mutation was not admitted.");
  }
  return fn({ actor: admission.actor, session: admission.actor.session, user: admission.actor.user });
}

async function getActorFromRequest(request, env) {
  const session = await readSession(request, env);
  if (!session) {
    return null;
  }

  const user = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at
    FROM users
    WHERE id = ?
  `).bind(session.userId).first();

  if (!user || user.status === "disabled") {
    return null;
  }

  const baseUser = normalizeUserRow(user);
  if (session.systemMode && canUseSystemAccount(baseUser)) {
    return buildSystemActor(baseUser, session);
  }
  return { session, user: baseUser, baseUser, isSystem: false };
}

async function readSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const raw = cookies[SESSION_COOKIE];
  if (!raw) {
    return null;
  }

  const payload = await verifySignedToken(env, raw, "session");
  if (!payload || typeof payload.uid !== "number") {
    return null;
  }

  return {
    userId: payload.uid,
    exp: payload.exp,
    iat: payload.iat,
    reauthAt: payload.reauthAt || payload.iat || 0,
    systemMode: payload.mode === "system"
  };
}

async function issueSessionCookie(request, env, options) {
  const now = Math.floor(Date.now() / 1000);
  const reauthAt = options.purpose === "reauth" ? now : (options.existingReauthAt || now);
  const token = await signToken(env, {
    scope: "session",
    uid: Number(options.userId),
    iat: now,
    exp: now + SESSION_LIFETIME_SECONDS,
    reauthAt,
    mode: options.systemMode ? "system" : "user"
  });
  return buildSessionCookie(request, token, SESSION_LIFETIME_SECONDS);
}

function requireFreshReauth(session) {
  const now = Math.floor(Date.now() / 1000);
  if (!session?.reauthAt || (now - Number(session.reauthAt)) > REAUTH_WINDOW_SECONDS) {
    throw new HttpError(403, "Discord re-authentication is required before continuing.");
  }
}

function buildAuthStatusResponse(actor) {
  if (!actor?.user) {
    return {
      authenticated: false,
      user: null,
      permissions: [],
      reauthFresh: false,
      canUseSystemAccount: false,
      systemMode: false
    };
  }

  return {
    authenticated: true,
    user: serializeAuthUser(actor),
    permissions: [...getPermissionsForRole(actor.user.role)],
    reauthFresh: Boolean(actor.session?.reauthAt && ((Math.floor(Date.now() / 1000) - Number(actor.session.reauthAt)) <= REAUTH_WINDOW_SECONDS)),
    canUseSystemAccount: canUseSystemAccount(actor.baseUser || actor.user),
    systemMode: Boolean(actor.isSystem)
  };
}

async function buildDiscordAuthorizeUrl(request, env, purpose, returnTo) {
  const clientId = requireEnv(env, "DISCORD_CLIENT_ID");
  const redirectUri = getDiscordRedirectUri(env);
  const base = new URL("https://discord.com/oauth2/authorize");
  const nonce = createRandomToken();
  const stateToken = await signToken(env, {
    scope: "oauth",
    purpose,
    returnTo,
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_LIFETIME_SECONDS
  });
  base.searchParams.set("client_id", clientId);
  base.searchParams.set("response_type", "code");
  base.searchParams.set("redirect_uri", redirectUri);
  base.searchParams.set("scope", "identify");
  base.searchParams.set("prompt", "consent");
  base.searchParams.set("state", stateToken);
  return {
    authorizeUrl: base.toString(),
    nonce
  };
}

async function exchangeDiscordCode(env, code) {
  const redirectUri = getDiscordRedirectUri(env);
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv(env, "DISCORD_CLIENT_ID"),
      client_secret: requireEnv(env, "DISCORD_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new HttpError(502, "Discord OAuth exchange failed.");
  }
  return body;
}

async function fetchDiscordIdentity(accessToken) {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) {
    throw new HttpError(502, "Could not load Discord identity.");
  }
  return body;
}

async function upsertDiscordUser(env, discordUser) {
  const now = currentIsoString();
  const existing = await env.DB.prepare(`
    SELECT id, role
    FROM users
    WHERE discord_user_id = ?
  `).bind(String(discordUser.id)).first();

  if (!existing) {
    const role = "Viewer";
    await env.DB.prepare(`
      INSERT INTO users (discord_user_id, username, global_name, avatar_hash, role, role_sort, status, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).bind(
      String(discordUser.id),
      sanitizeOptionalString(discordUser.username, 100),
      sanitizeOptionalString(discordUser.global_name || discordUser.display_name, 100),
      sanitizeOptionalString(discordUser.avatar, 128),
      role,
      getRoleSort(role),
      now,
      now,
      now
    ).run();
  } else {
    await env.DB.prepare(`
      UPDATE users
      SET username = ?, global_name = ?, avatar_hash = ?, updated_at = ?, last_login_at = ?
      WHERE discord_user_id = ?
    `).bind(
      sanitizeOptionalString(discordUser.username, 100),
      sanitizeOptionalString(discordUser.global_name || discordUser.display_name, 100),
      sanitizeOptionalString(discordUser.avatar, 128),
      now,
      now,
      String(discordUser.id)
    ).run();
  }

  const user = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at
    FROM users
    WHERE discord_user_id = ?
  `).bind(String(discordUser.id)).first();
  return normalizeUserRow(user);
}

function getDiscordRedirectUri(env) {
  const redirectUri = requireEnv(env, "DISCORD_REDIRECT_URI");
  const url = new URL(redirectUri);
  if (url.protocol !== "https:") {
    throw new HttpError(500, "DISCORD_REDIRECT_URI must use HTTPS.");
  }
  return url.toString();
}

async function signToken(env, payload) {
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  return `${payloadBase64}.${signature}`;
}

async function verifySignedToken(env, token, expectedScope) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadBase64, signature] = parts;
  const expected = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  if (!expected || !timingSafeEqual(signature, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadBase64));
  } catch {
    return null;
  }
  if (!payload || payload.scope !== expectedScope || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function buildSessionCookie(request, value, maxAge) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function buildOAuthStateCookie(request, value, maxAge) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    "Path=/api/auth/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function createRandomToken() {
  return crypto.randomUUID().replaceAll("-", "");
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function hasCapability(role, capability) {
  if (!role) {
    return false;
  }
  const permissions = getPermissionsForRole(role);
  return permissions.includes(capability) || permissions.includes("owner:all");
}

function normalizeUserRow(row) {
  return {
    id: Number(row.id),
    discord_user_id: row.discord_user_id,
    username: row.username || "",
    global_name: row.global_name || "",
    avatar_hash: row.avatar_hash || "",
    role: row.role,
    status: row.status || "active",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    last_login_at: row.last_login_at || ""
  };
}

function serializeTeamUser(row) {
  const user = normalizeUserRow(row);
  return {
    id: user.id,
    discordUserId: user.discord_user_id,
    username: user.username,
    globalName: user.global_name,
    displayName: user.global_name || user.username || user.discord_user_id,
    handle: user.username ? `@${user.username}` : "",
    avatarUrl: buildDiscordAvatarUrl(user.discord_user_id, user.avatar_hash),
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at
  };
}

function serializeAuthUser(actor) {
  if (actor?.isSystem) {
    return {
      id: actor.baseUser?.id ?? actor.user?.id ?? null,
      discordUserId: SYSTEM_ACCOUNT_HANDLE,
      username: "root",
      globalName: SYSTEM_ACCOUNT_DISPLAY_NAME,
      displayName: SYSTEM_ACCOUNT_DISPLAY_NAME,
      handle: SYSTEM_ACCOUNT_HANDLE,
      avatarUrl: SYSTEM_ACCOUNT_AVATAR_URL,
      role: actor.user?.role || "Owner",
      displayRole: SYSTEM_ACCOUNT_ROLE_LABEL,
      status: "active",
      createdAt: actor.baseUser?.created_at || "",
      updatedAt: actor.baseUser?.updated_at || "",
      lastLoginAt: actor.baseUser?.last_login_at || "",
      isSystem: true
    };
  }

  return {
    ...serializeTeamUser(actor.user),
    displayRole: actor.user?.role || "",
    isSystem: false
  };
}

function serializePublicTeamUser(row) {
  const user = normalizeUserRow(row);
  return {
    displayName: user.global_name || user.username || "BBTSL Team",
    handle: user.username ? `@${user.username}` : "",
    avatarUrl: buildDiscordAvatarUrl(user.discord_user_id, user.avatar_hash),
    role: user.role
  };
}

function serializePrivateApiTeamUser(row) {
  const user = normalizeUserRow(row);
  return {
    displayName: user.global_name || user.username || "BBTSL Team",
    handle: user.username ? `@${user.username}` : "",
    role: user.role,
    avatarUrl: buildDiscordAvatarUrl(user.discord_user_id, user.avatar_hash),
    updatedAt: user.updated_at || null
  };
}

function canUseSystemAccount(user) {
  return String(user?.discord_user_id || "") === SYSTEM_DISCORD_USER_ID;
}

function buildSystemActor(baseUser, session) {
  return {
    session,
    baseUser,
    isSystem: true,
    user: {
      ...baseUser,
      role: "Owner",
      username: "root",
      global_name: SYSTEM_ACCOUNT_DISPLAY_NAME,
      avatar_hash: ""
    }
  };
}

function buildDiscordAvatarUrl(discordUserId, avatarHash) {
  if (!discordUserId) {
    return null;
  }
  if (avatarHash) {
    const extension = String(avatarHash).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.${extension}?size=256`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${getDiscordDefaultAvatarIndex(discordUserId)}.png`;
}

function getDiscordDefaultAvatarIndex(discordUserId) {
  try {
    return Number((BigInt(String(discordUserId)) >> 22n) % 6n);
  } catch {
    const value = String(discordUserId)
      .split("")
      .reduce((total, char) => total + char.charCodeAt(0), 0);
    return value % 6;
  }
}

function createEmptySiteState() {
  return {
    version: 1,
    swords: [],
    baseline: [],
    mediaVariants: {},
    mediaObjects: {},
    usage: {
      monthly: {},
      totalStorageBytes: 0
    }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSiteSwordRecord(row = {}) {
  return {
    id: Number(row.id),
    card_id: row.card_id || null,
    n: row.n || "",
    c: row.c || "",
    v: Number(row.v || 0),
    d: row.d || "",
    t: row.t || "",
    ct: row.ct === null || row.ct === undefined || row.ct === "" ? null : Number(row.ct),
    u: row.u || currentUtcDateString(),
    descr: row.descr || "",
    image_key: row.image_key || null,
    detail_image_key: row.detail_image_key || null,
    slash_media_key: row.slash_media_key || null,
    slash_audio_key: row.slash_audio_key || null,
    finisher_media_key: row.finisher_media_key || null,
    owners_choice: Number(row.owners_choice ? 1 : 0),
    edited: Number(row.edited ? 1 : 0),
    revision: Number.isSafeInteger(Number(row.revision)) && Number(row.revision) > 0 ? Number(row.revision) : 1,
    last_commit_id: typeof row.last_commit_id === "string" ? row.last_commit_id : null,
    last_commit_actor_user_id: Number.isSafeInteger(Number(row.last_commit_actor_user_id)) && Number(row.last_commit_actor_user_id) > 0
      ? Number(row.last_commit_actor_user_id)
      : null,
    last_commit_action_type: ["sword.create", "sword.update"].includes(row.last_commit_action_type)
      ? row.last_commit_action_type
      : null,
    last_commit_before: row.last_commit_before && typeof row.last_commit_before === "object"
      ? cloneJson(row.last_commit_before)
      : null
  };
}

async function readSiteStateObject(env) {
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) {
    return null;
  }
  return JSON.parse(await object.text());
}

async function writeSiteStateObject(env, state) {
  const normalizedState = {
    version: 1,
    swords: (state.swords || []).map((row) => normalizeSiteSwordRecord(row)).sort((left, right) => Number(left.id) - Number(right.id)),
    baseline: (state.baseline || []).map((row) => normalizeSiteSwordRecord(row)).sort((left, right) => Number(left.id) - Number(right.id)),
    mediaVariants: state.mediaVariants || {},
    mediaObjects: state.mediaObjects || {},
    usage: {
      monthly: state.usage?.monthly || {},
      totalStorageBytes: Number(state.usage?.totalStorageBytes || 0)
    }
  };
  siteStateCache = cloneJson(normalizedState);
  await env.MEDIA_BUCKET.put(SITE_STATE_KEY, JSON.stringify(normalizedState), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

async function loadSiteState(env, { fresh = false } = {}) {
  if (!fresh && siteStateCache) {
    return cloneJson(siteStateCache);
  }
  let state = await readSiteStateObject(env);
  if (!state) {
    state = createEmptySiteState();
    await writeSiteStateObject(env, state);
    return cloneJson(state);
  }
  siteStateCache = cloneJson(state);
  return cloneJson(state);
}

async function updateSiteState(env, mutator) {
  const currentState = await loadSiteState(env, { fresh: true });
  const nextState = await mutator(currentState) || currentState;
  await writeSiteStateObject(env, nextState);
  return cloneJson(nextState);
}

function getSiteSwordById(state, id) {
  return (state.swords || []).find((row) => Number(row.id) === Number(id)) || null;
}

function getSiteSwordByCardId(state, cardId) {
  const normalizedTarget = normalizeCardId(cardId);
  return (state.swords || []).find((row) => normalizeCardId(row.card_id) === normalizedTarget) || null;
}

function getNextSwordId(state) {
  return (state.swords || []).reduce((maxId, row) => Math.max(maxId, Number(row.id) || 0), 0) + 1;
}

function upsertSiteSwordRecord(rows, record) {
  const nextRows = [...(rows || [])];
  const rowIndex = nextRows.findIndex((row) => Number(row.id) === Number(record.id));
  if (rowIndex >= 0) {
    nextRows[rowIndex] = normalizeSiteSwordRecord(record);
  } else {
    nextRows.push(normalizeSiteSwordRecord(record));
  }
  return nextRows.sort((left, right) => Number(left.id) - Number(right.id));
}

function removeSiteSwordRecord(rows, id) {
  return (rows || [])
    .filter((row) => Number(row.id) !== Number(id))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function buildSiteMediaDescriptorMap(state, baseKeys) {
  const keyList = [...new Set((baseKeys || []).filter(Boolean))];
  const mediaMap = new Map();
  for (const key of keyList) {
    const variant = state.mediaVariants?.[key];
    if (variant) {
      mediaMap.set(key, {
        key,
        kind: variant.mediaKind || inferMediaKindFromKey(variant.originalKey || key),
        low: buildMediaUrl(variant.lowKey || variant.originalKey || key),
        medium: buildMediaUrl(variant.mediumKey || variant.originalKey || key),
        original: buildMediaUrl(variant.originalKey || key)
      });
      continue;
    }
    const mediaObject = state.mediaObjects?.[key];
    mediaMap.set(key, {
      key,
      kind: inferMediaKindFromContentType(mediaObject?.contentType || "") || inferMediaKindFromKey(key),
      low: buildMediaUrl(key),
      medium: buildMediaUrl(key),
      original: buildMediaUrl(key)
    });
  }
  return mediaMap;
}

async function getSwordById(env, id) {
  const state = await loadSiteState(env);
  return getSiteSwordById(state, id);
}

async function getSwordByCardId(env, cardId) {
  const state = await loadSiteState(env);
  return getSiteSwordByCardId(state, cardId);
}

function serializeSword(row, mediaMap = new Map()) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    cardId: row.card_id || null,
    n: row.n,
    c: row.c,
    v: Number(row.v),
    d: row.d,
    t: row.t,
    ct: row.ct === null || row.ct === undefined ? null : Number(row.ct),
    u: row.u,
    descr: row.descr || "",
    img: buildMediaDescriptor(row.image_key, mediaMap),
    detailMedia: buildMediaDescriptor(row.detail_image_key, mediaMap),
    slashMedia: buildMediaDescriptor(row.slash_media_key, mediaMap),
    slashAudio: buildMediaDescriptor(row.slash_audio_key, mediaMap),
    finisherMedia: buildMediaDescriptor(row.finisher_media_key, mediaMap),
    ownersChoice: Boolean(row.owners_choice),
    edited: Boolean(row.edited),
    revision: Number(row.revision || 1)
  };
}

function serializePrivateApiSword(row, mediaMap = new Map()) {
  const sword = serializeSword(row, mediaMap);
  if (!sword) {
    return null;
  }
  return {
    cardId: sword.cardId,
    name: sword.n,
    category: sword.c,
    value: sword.v,
    demand: sword.d,
    trend: sword.t,
    count: sword.ct,
    updatedAt: sword.u,
    description: sword.descr,
    media: {
      card: sword.img,
      detail: sword.detailMedia,
      slash: sword.slashMedia,
      audio: sword.slashAudio,
      finisher: sword.finisherMedia
    },
    flags: {
      ownersChoice: sword.ownersChoice,
      edited: sword.edited
    }
  };
}

function collectSwordMediaKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    [row.image_key, row.detail_image_key, row.slash_media_key, row.slash_audio_key, row.finisher_media_key].forEach((key) => {
      if (typeof key === "string" && key) {
        keys.add(key);
      }
    });
  }
  return [...keys];
}

function buildMediaDescriptor(key, mediaMap = new Map()) {
  if (typeof key !== "string" || !key) {
    return null;
  }
  const descriptor = mediaMap.get(key);
  if (descriptor) {
    return descriptor;
  }

  const fallbackKind = inferMediaKindFromKey(key);
  const url = buildMediaUrl(key);
  return {
    key,
    kind: fallbackKind,
    low: url,
    medium: url,
    original: url
  };
}

function buildMediaUrl(key) {
  return `/media/${encodeURIComponent(key)}`;
}

function normalizeOwnersChoiceFlag(flag, value, count) {
  const explicitFlag = flag === true || String(flag || "").trim().toLowerCase() === "true";
  const explicitValue = String(value || "").trim().toLowerCase();
  const ownersChoice = explicitFlag || explicitValue === "oc" || explicitValue === "o/c";
  if (!ownersChoice) {
    return false;
  }
  if (count === null || count === undefined || Number(count) >= 5) {
    throw new HttpError(400, "Owner's Choice can only be used when count is below 5.");
  }
  return true;
}

function inferMediaKindFromKey(key) {
  const lowerKey = String(key || "").toLowerCase();
  if (/\.(mpeg|mp3|ogg|wav)$/i.test(lowerKey)) {
    return "audio";
  }
  if (/\.mp4$/i.test(lowerKey)) {
    return "video";
  }
  return "image";
}

const EDITOR_MEDIA_FIELDS = [
  ["img", "card-image", "image_key"],
  ["detailMedia", "detail", "detail_image_key"],
  ["slashMedia", "slash", "slash_media_key"],
  ["slashAudio", "slash-audio", "slash_audio_key"],
  ["finisherMedia", "finisher", "finisher_media_key"]
];

function requireCommitId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,96}$/.test(id)) throw new HttpError(400, "Card commit idempotency key is invalid.");
  return id;
}

function normalizeExpectedRevision(value, isCreate) {
  const revision = Number(value ?? (isCreate ? 0 : NaN));
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, "Card revision is invalid.");
  return revision;
}

function collectStagedMediaReferences(payload) {
  const references = [];
  for (const [field, variant] of EDITOR_MEDIA_FIELDS) {
    const value = payload[field];
    if (value && typeof value === "object" && typeof value.stagedMediaId === "string") {
      references.push({ id: value.stagedMediaId, variant });
    }
  }
  return references;
}

function collectStagedMediaIds(payload) {
  return collectStagedMediaReferences(payload).map((reference) => reference.id);
}

function resolveCommittedMediaKeys(payload, existing, state, stagedByVariant) {
  const result = {};
  for (const [field, variant, stateField] of EDITOR_MEDIA_FIELDS) {
    const value = payload[field];
    if (value === undefined) {
      result[field] = existing?.[stateField] || null;
      continue;
    }
    if (value === null) {
      result[field] = null;
      continue;
    }
    if (value && typeof value === "object" && typeof value.stagedMediaId === "string") {
      const staged = stagedByVariant.get(variant);
      if (!staged || staged.id !== value.stagedMediaId) throw new HttpError(400, "Staged media reference is invalid.");
      result[field] = staged.baseKey;
      continue;
    }
    const key = typeof value === "object" ? String(value.key || "") : parseMediaKeyFromInput(value);
    if (!key) throw new HttpError(400, "Media reference is invalid.");
    assertMediaKeyInSiteState(state, key, variant);
    result[field] = key;
  }
  return result;
}

function assertMediaKeyInSiteState(state, key, variant) {
  const descriptor = state.mediaVariants?.[key];
  const object = state.mediaObjects?.[key];
  if (!descriptor && !object) throw new HttpError(404, "Media was not found.");
  const kind = descriptor?.mediaKind || inferMediaKindFromContentType(object?.contentType || "") || inferMediaKindFromKey(key);
  assertMediaKindForField(variant, kind, descriptor?.contentType || object?.contentType || "");
}

function physicalKeysForSword(state, sword) {
  const keys = new Set();
  for (const baseKey of collectSwordMediaKeys([sword])) {
    const descriptor = state.mediaVariants?.[baseKey];
    if (descriptor) {
      for (const key of [descriptor.lowKey, descriptor.mediumKey, descriptor.originalKey]) if (key) keys.add(key);
    } else if (state.mediaObjects?.[baseKey]) {
      keys.add(baseKey);
    }
  }
  return keys;
}

function normalizeSwordPayload(body) {
  const count = body.ct === null || body.ct === undefined || body.ct === "" ? null : clampInteger(body.ct, 0, 1_000_000, "Count");
  const ownersChoice = normalizeOwnersChoiceFlag(body.oc, body.v, count);
  return {
    n: requireString(body.n, "Name"),
    c: requireEnum(body.c, CATEGORIES, "Category"),
    v: ownersChoice ? clampInteger(body.v ?? 0, 0, MAX_EDIT_VALUE, "Value") : clampInteger(body.v, 0, MAX_EDIT_VALUE, "Value"),
    d: requireEnum(body.d, DEMANDS, "Demand"),
    t: requireEnum(body.t, TRENDS, "Trend"),
    ct: count,
    descr: sanitizeOptionalString(body.descr, MAX_TEXT_LENGTH),
    img: body.img,
    detailMedia: body.detailMedia,
    slashMedia: body.slashMedia,
    slashAudio: body.slashAudio,
    finisherMedia: body.finisherMedia,
    ownersChoice
  };
}

function swordPayloadFromSnapshot(snapshot) {
  return {
    n: snapshot.n,
    c: snapshot.c,
    v: snapshot.v,
    d: snapshot.d,
    t: snapshot.t,
    ct: snapshot.ct,
    descr: snapshot.descr,
    img: snapshot.img ?? null,
    detailMedia: snapshot.detailMedia ?? null,
    slashMedia: snapshot.slashMedia ?? null,
    slashAudio: snapshot.slashAudio ?? null,
    finisherMedia: snapshot.finisherMedia ?? null,
    oc: Boolean(snapshot.ownersChoice)
  };
}

async function applySwordSnapshotUpdate(env, id, payload) {
  const current = await getSwordById(env, id);
  if (!current) {
    throw new HttpError(404, "Sword not found.");
  }
  const normalized = normalizeSwordPayload(payload);
  const { image, detailMedia, slashMedia, slashAudio, finisherMedia } = await persistSwordMedia(env, normalized, normalized.n, current);
  const updated = normalizeSiteSwordRecord({
    ...current,
    n: normalized.n,
    c: normalized.c,
    v: normalized.v,
    d: normalized.d,
    t: normalized.t,
    ct: normalized.ct,
    u: currentUtcDateString(),
    descr: normalized.descr,
    image_key: image.mediaKey,
    detail_image_key: detailMedia.mediaKey,
    slash_media_key: slashMedia.mediaKey,
    slash_audio_key: slashAudio.mediaKey,
    finisher_media_key: finisherMedia.mediaKey,
    owners_choice: normalized.ownersChoice ? 1 : 0,
    edited: 1
  });
  await updateSiteState(env, (state) => ({
    ...state,
    swords: upsertSiteSwordRecord(state.swords, updated)
  }));
}

async function restoreSwordSnapshot(env, snapshot) {
  const existing = await getSwordById(env, Number(snapshot.id));
  if (!existing) {
    const { image, detailMedia, slashMedia, slashAudio, finisherMedia } = await persistSwordMedia(env, swordPayloadFromSnapshot(snapshot), snapshot.n);
    const created = normalizeSiteSwordRecord({
      id: snapshot.id,
      card_id: snapshot.cardId,
      n: snapshot.n,
      c: snapshot.c,
      v: snapshot.v,
      d: snapshot.d,
      t: snapshot.t,
      ct: snapshot.ct,
      u: currentUtcDateString(),
      descr: snapshot.descr || "",
      image_key: image.mediaKey,
      detail_image_key: detailMedia.mediaKey,
      slash_media_key: slashMedia.mediaKey,
      slash_audio_key: slashAudio.mediaKey,
      finisher_media_key: finisherMedia.mediaKey,
      owners_choice: snapshot.ownersChoice ? 1 : 0,
      edited: 1
    });
    await updateSiteState(env, (state) => ({
      ...state,
      swords: upsertSiteSwordRecord(state.swords, created)
    }));
    return;
  }

  await applySwordSnapshotUpdate(env, Number(snapshot.id), swordPayloadFromSnapshot(snapshot));
}

async function persistSwordMedia(env, payload, swordName, existing = {}) {
  const image = payload.img !== undefined
    ? await persistMedia(env, payload.img, swordName, "card-image")
    : { mediaKey: existing.image_key || null };
  const detailMedia = payload.detailMedia !== undefined
    ? await persistMedia(env, payload.detailMedia, swordName, "detail")
    : { mediaKey: existing.detail_image_key || null };
  const slashMedia = payload.slashMedia !== undefined
    ? await persistMedia(env, payload.slashMedia, swordName, "slash")
    : { mediaKey: existing.slash_media_key || null };
  const slashAudio = payload.slashAudio !== undefined
    ? await persistMedia(env, payload.slashAudio, swordName, "slash-audio")
    : { mediaKey: existing.slash_audio_key || null };
  const finisherMedia = payload.finisherMedia !== undefined
    ? await persistMedia(env, payload.finisherMedia, swordName, "finisher")
    : { mediaKey: existing.finisher_media_key || null };
  return { image, detailMedia, slashMedia, slashAudio, finisherMedia };
}

async function persistMedia(env, mediaInput, swordName, variant) {
  if (mediaInput === null) {
    return { mediaKey: null };
  }

  if (typeof mediaInput === "object" && !Array.isArray(mediaInput)) {
    if (typeof mediaInput.key === "string" && mediaInput.key) {
      await assertExistingMediaKind(env, mediaInput.key, variant);
      return { mediaKey: mediaInput.key };
    }
    return persistVariantMedia(env, mediaInput, swordName, variant);
  }

  if (typeof mediaInput !== "string") {
    throw new HttpError(400, "Media must be a data URL string, media descriptor, or null.");
  }

  const existingKey = parseMediaKeyFromInput(mediaInput);
  if (existingKey) {
    await assertExistingMediaKind(env, existingKey, variant);
    return { mediaKey: existingKey };
  }

  const parsed = parseDataUrl(mediaInput, getMediaFieldLabel(variant));
  assertMediaKindForField(variant, parsed.kind, parsed.contentType);
  const maxBytes = getMaxMediaBytes(variant, parsed.kind);
  if (parsed.bytes.byteLength > maxBytes) {
    throwMediaSizeError(variant, maxBytes);
  }

  const baseKey = buildMediaSetKey(swordName, variant);
  const variantKeys = buildVariantKeys(baseKey, parsed.extension, variant);
  const isVariantFriendlyImage = parsed.kind === "image" && parsed.contentType !== "image/gif" && parsed.contentType !== "image/svg+xml";

  if (isVariantFriendlyImage) {
    await Promise.all([
      upsertMediaRecord(env, variantKeys.low, parsed.contentType, parsed.bytes),
      upsertMediaRecord(env, variantKeys.medium, parsed.contentType, parsed.bytes),
      upsertMediaRecord(env, variantKeys.original, parsed.contentType, parsed.bytes)
    ]);
    await upsertMediaVariantSet(env, {
      baseKey,
      mediaKind: parsed.kind,
      contentType: parsed.contentType,
      lowKey: variantKeys.low,
      mediumKey: variantKeys.medium,
      originalKey: variantKeys.original
    });
    return { mediaKey: baseKey };
  }

  await upsertMediaRecord(env, variantKeys.original, parsed.contentType, parsed.bytes);
  await upsertMediaVariantSet(env, {
    baseKey,
    mediaKind: parsed.kind,
    contentType: parsed.contentType,
    lowKey: variantKeys.original,
    mediumKey: variantKeys.original,
    originalKey: variantKeys.original
  });
  return { mediaKey: baseKey };
}

async function persistVariantMedia(env, mediaInput, swordName, variant) {
  const normalized = normalizeVariantMediaInput(mediaInput);
  if (normalized.kind !== "image" || !normalized.low || !normalized.medium || !normalized.original) {
    throw new HttpError(400, "Variant media payload is incomplete.");
  }

  const parsedLow = parseDataUrl(normalized.low);
  const parsedMedium = parseDataUrl(normalized.medium);
  const parsedOriginal = parseDataUrl(normalized.original);
  const parsedList = [parsedLow, parsedMedium, parsedOriginal];
  assertMediaKindForField(variant, "image", parsedOriginal.contentType);
  for (const parsed of parsedList) {
    if (parsed.kind !== "image") {
      throw new HttpError(415, "Only image media can include generated quality variants.");
    }
    const maxBytes = getMaxMediaBytes(variant, parsed.kind);
    if (parsed.bytes.byteLength > maxBytes) {
      throwMediaSizeError(variant, maxBytes);
    }
  }

  const baseKey = buildMediaSetKey(swordName, variant);
  const variantKeys = buildVariantKeys(baseKey, parsedOriginal.extension, variant);
  await Promise.all([
    upsertMediaRecord(env, variantKeys.low, parsedLow.contentType, parsedLow.bytes),
    upsertMediaRecord(env, variantKeys.medium, parsedMedium.contentType, parsedMedium.bytes),
    upsertMediaRecord(env, variantKeys.original, parsedOriginal.contentType, parsedOriginal.bytes)
  ]);
  await upsertMediaVariantSet(env, {
    baseKey,
    mediaKind: "image",
    contentType: parsedOriginal.contentType,
    lowKey: variantKeys.low,
    mediumKey: variantKeys.medium,
    originalKey: variantKeys.original
  });
  return { mediaKey: baseKey };
}

function normalizeVariantMediaInput(mediaInput) {
  return {
    key: sanitizeOptionalString(mediaInput.key, MEDIA_KEY_LIMIT),
    kind: sanitizeOptionalString(mediaInput.kind, 16) || "image",
    low: mediaInput.low,
    medium: mediaInput.medium,
    original: mediaInput.original
  };
}

function parseMediaKeyFromInput(mediaInput) {
  if (typeof mediaInput !== "string") {
    return null;
  }
  if (mediaInput.startsWith("/media/")) {
    const path = mediaInput.split("?")[0];
    return decodeURIComponent(path.slice("/media/".length));
  }
  try {
    const parsedUrl = new URL(mediaInput);
    if (parsedUrl.pathname.startsWith("/media/")) {
      return decodeURIComponent(parsedUrl.pathname.slice("/media/".length));
    }
  } catch {
    return null;
  }
  return null;
}

async function assertExistingMediaKind(env, mediaKey, variant) {
  const mediaMap = await loadMediaDescriptorMap(env, [mediaKey]);
  const descriptor = mediaMap.get(mediaKey);
  if (!descriptor) {
    throw new HttpError(404, "Media was not found.");
  }
  assertMediaKindForField(variant, descriptor.kind, "");
}

function assertMediaKindForField(variant, kind, contentType) {
  const isAudioField = variant === "slash-audio";
  const isSupported = isAudioField ? kind === "audio" : kind === "image" || kind === "video";
  if (isSupported) {
    return;
  }
  const label = getMediaFieldLabel(variant);
  const format = getMediaFormatLabel(contentType || kind);
  const hint = isAudioField ? " Use MPEG, MP3, OGG, or WAV." : " Use an image or MP4 video.";
  throw new HttpError(415, `${label} does not support ${format} format.${hint}`);
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

function throwMediaSizeError(variant, maxBytes) {
  const megabytes = maxBytes / (1024 * 1024);
  throw new HttpError(413, `${getMediaFieldLabel(variant)} must be ${megabytes} MB or smaller.`);
}

function buildMediaSetKey(swordName, variant) {
  const slug = swordName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sword";
  return `media/${slug}-${variant}-${crypto.randomUUID()}`;
}

function getMediaFolderForVariant(variant) {
  const folderMap = {
    "card-image": "card",
    detail: "vfx",
    "slash-audio": "sfx",
    slash: "slash",
    finisher: "finisher"
  };
  return folderMap[variant] || "card";
}

function getMediaFolderForKey(mediaKey) {
  const lowerKey = String(mediaKey || "").toLowerCase();
  if (lowerKey.includes("-card-image-") || lowerKey.startsWith("swords/")) {
    return "card";
  }
  if (lowerKey.includes("-slash-audio-")) {
    return "sfx";
  }
  if (lowerKey.includes("-detail-")) {
    return "vfx";
  }
  if (lowerKey.includes("-finisher-")) {
    return "finisher";
  }
  if (lowerKey.includes("-slash-")) {
    return "slash";
  }
  return "card";
}

function inferMediaQualityFromKey(mediaKey) {
  const lowerKey = String(mediaKey || "").toLowerCase();
  if (lowerKey.includes("--low.")) {
    return "low";
  }
  if (lowerKey.includes("--medium.")) {
    return "medium";
  }
  return "full";
}

function stripManagedMediaPrefix(mediaKey) {
  return String(mediaKey || "").replace(/^(media|swords|card|vfx|sfx|slash|finisher)\//i, "");
}

function normalizeStoredMediaKey(mediaKey, variant = "", quality = "") {
  const key = String(mediaKey || "");
  if (!key) {
    return key;
  }
  const managedMatch = key.match(/^(card|vfx|sfx|slash|finisher)\/(low|medium|full)\/(.+)$/i);
  if (managedMatch) {
    const existingQuality = managedMatch[2].toLowerCase();
    const normalizedKey = stripManagedMediaPrefix(managedMatch[3]);
    const mediaType = variant ? getMediaFolderForVariant(variant) : getMediaFolderForKey(normalizedKey);
    const normalizedQuality = quality || existingQuality;
    return `${mediaType}/${normalizedQuality}/${normalizedKey}`;
  }
  const mediaType = variant ? getMediaFolderForVariant(variant) : getMediaFolderForKey(key);
  const normalizedKey = stripManagedMediaPrefix(key);
  const normalizedQuality = quality || inferMediaQualityFromKey(key);
  return `${mediaType}/${normalizedQuality}/${normalizedKey}`;
}

function buildVariantKeys(baseKey, extension, variant) {
  return {
    low: normalizeStoredMediaKey(`${baseKey}--low.${extension}`, variant, "low"),
    medium: normalizeStoredMediaKey(`${baseKey}--medium.${extension}`, variant, "medium"),
    original: normalizeStoredMediaKey(`${baseKey}--original.${extension}`, variant, "full")
  };
}

async function upsertMediaRecord(env, mediaKey, contentType, bytes) {
  const state = await loadSiteState(env);
  const previousSize = Number(state.mediaObjects?.[mediaKey]?.sizeBytes || 0);
  await reserveR2Usage(env, 1, 0, bytes.byteLength - previousSize);
  await env.MEDIA_BUCKET.put(mediaKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      contentType,
      mediaSize: String(bytes.byteLength)
    }
  });
  await updateSiteState(env, (currentState) => ({
    ...currentState,
    mediaObjects: {
      ...(currentState.mediaObjects || {}),
      [mediaKey]: {
        mediaKey,
        contentType,
        sizeBytes: bytes.byteLength,
        updatedAt: currentIsoString()
      }
    }
  }));
  invalidatePublicMediaRegistry(env);
}

async function upsertMediaVariantSet(env, record) {
  await updateSiteState(env, (currentState) => ({
    ...currentState,
    mediaVariants: {
      ...(currentState.mediaVariants || {}),
      [record.baseKey]: {
        baseKey: record.baseKey,
        mediaKind: record.mediaKind,
        contentType: record.contentType,
        lowKey: record.lowKey,
        mediumKey: record.mediumKey,
        originalKey: record.originalKey,
        updatedAt: currentIsoString()
      }
    }
  }));
}

async function loadMediaDescriptorMap(env, baseKeys) {
  const keyList = [...new Set((baseKeys || []).filter(Boolean))];
  if (!keyList.length) {
    return new Map();
  }
  const state = await loadSiteState(env);
  return buildSiteMediaDescriptorMap(state, keyList);
}

function inferMediaKindFromContentType(contentType) {
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerType.startsWith("audio/")) {
    return "audio";
  }
  if (lowerType.startsWith("video/")) {
    return "video";
  }
  if (lowerType.startsWith("image/")) {
    return "image";
  }
  return "";
}

function getCurrentUsagePeriodKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function reserveR2Usage(env, classADelta, classBDelta, storageDeltaBytes) {
  const periodKey = getCurrentUsagePeriodKey();
  const now = currentIsoString();
  await updateSiteState(env, (state) => {
    const monthlyRow = state.usage?.monthly?.[periodKey] || {};
    const nextClassA = Number(monthlyRow.classACount || 0) + Number(classADelta || 0);
    const nextClassB = Number(monthlyRow.classBCount || 0) + Number(classBDelta || 0);
    const nextStorage = Number(state.usage?.totalStorageBytes || 0) + Number(storageDeltaBytes || 0);

    if (nextClassA > R2_CLASS_A_LIMIT) {
      throw new HttpError(507, "R2 Class A limit reached for the current month.");
    }
    if (nextClassB > R2_CLASS_B_LIMIT) {
      throw new HttpError(507, "R2 Class B limit reached for the current month.");
    }
    if (nextStorage > R2_STORAGE_LIMIT_BYTES) {
      throw new HttpError(507, "R2 storage limit reached.");
    }

    return {
      ...state,
      usage: {
        monthly: {
          ...(state.usage?.monthly || {}),
          [periodKey]: {
            classACount: nextClassA,
            classBCount: nextClassB,
            updatedAt: now
          }
        },
        totalStorageBytes: nextStorage
      }
    };
  });
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

function getMediaFormatLabel(contentType) {
  return MEDIA_MIME_MAP.get(contentType)?.ext?.toUpperCase() || contentType || "this";
}

function parseDataUrl(input, fieldLabel = "Media") {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(input);
  if (!match) {
    throw new HttpError(400, "Media must be a base64 data URL.");
  }

  const contentType = match[1].toLowerCase();
  const mediaInfo = MEDIA_MIME_MAP.get(contentType);
  if (!mediaInfo) {
    const format = getMediaFormatLabel(contentType);
    const hint = fieldLabel === "Slash Audio" ? " Use MPEG, MP3, OGG, or WAV." : "";
    throw new HttpError(415, `${fieldLabel} does not support ${format} format.${hint}`);
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { contentType, extension: mediaInfo.ext, kind: mediaInfo.kind, bytes };
}

async function writeAuditLog(env, entry) {
  const beforeSnapshot = entry.beforeSnapshot === undefined ? null : entry.beforeSnapshot;
  const afterSnapshot = entry.afterSnapshot === undefined ? null : entry.afterSnapshot;
  const diff = buildDiff(beforeSnapshot, afterSnapshot);
  const commitId = entry.commitId ? requireCommitId(entry.commitId) : null;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO audit_logs (actor_user_id, actor_role, action_type, entity_type, entity_id, entity_public_id, summary, diff_json, before_json, after_json, created_at, commit_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.actor?.isSystem ? null : (entry.actor?.id || entry.actor?.user?.id || null),
    entry.actor?.isSystem ? SYSTEM_ACCOUNT_ROLE_LABEL : (entry.actor?.role || entry.actor?.user?.role || null),
    entry.actionType,
    entry.entityType,
    entry.entityId,
    entry.entityPublicId,
    entry.summary,
    JSON.stringify(diff),
    beforeSnapshot === null ? null : JSON.stringify(beforeSnapshot),
    afterSnapshot === null ? null : JSON.stringify(afterSnapshot),
    currentIsoString(),
    commitId
  ).run();
}

function buildDiff(beforeSnapshot, afterSnapshot) {
  if (beforeSnapshot === null && afterSnapshot !== null) {
    return [{ field: "*", from: null, to: summarizeValue(afterSnapshot) }];
  }
  if (beforeSnapshot !== null && afterSnapshot === null) {
    return [{ field: "*", from: summarizeValue(beforeSnapshot), to: null }];
  }
  if (Array.isArray(beforeSnapshot) || Array.isArray(afterSnapshot)) {
    return [{ field: "*", from: summarizeValue(beforeSnapshot), to: summarizeValue(afterSnapshot) }];
  }
  const diff = [];
  const keys = new Set([
    ...Object.keys(beforeSnapshot || {}),
    ...Object.keys(afterSnapshot || {})
  ]);
  for (const key of [...keys].sort()) {
    const beforeValue = beforeSnapshot?.[key] ?? null;
    const afterValue = afterSnapshot?.[key] ?? null;
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      diff.push({ field: key, from: summarizeValue(beforeValue), to: summarizeValue(afterValue) });
    }
  }
  return diff;
}

function summarizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return { type: "array", count: value.length };
  }
  if (typeof value === "object") {
    return value;
  }
  return value;
}

function serializeAuditLog(row) {
  const isSystem = row.actor_role === SYSTEM_ACCOUNT_ROLE_LABEL;
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    actorRole: row.actor_role || "",
    actorUsername: isSystem ? "root" : (row.actor_username || ""),
    actorGlobalName: isSystem ? SYSTEM_ACCOUNT_DISPLAY_NAME : (row.actor_global_name || ""),
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    entityPublicId: row.entity_public_id || null,
    summary: row.summary || "",
    diff: normalizeAuditDiff(parseJsonField(row.diff_json)),
    before: parseJsonField(row.before_json),
    after: parseJsonField(row.after_json),
    createdAt: row.created_at
  };
}

function normalizeAuditDiff(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([field, next]) => ({
      field,
      from: next?.from ?? null,
      to: next?.to ?? null
    }));
  }
  return [];
}

function parseJsonField(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function generateUniqueCardId(env, state = null) {
  const currentState = state || await loadSiteState(env);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = `${CARD_ID_PREFIX}${generateRandomCardIdBody()}`;
    const existing = getSiteSwordByCardId(currentState, next);
    if (!existing) {
      return next;
    }
  }
  throw new HttpError(500, "Could not generate a unique card ID.");
}

function generateRandomCardIdBody() {
  let out = "";
  const bytes = new Uint8Array(CARD_ID_LENGTH);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    out += CARD_ID_ALPHABET[byte % CARD_ID_ALPHABET.length];
  }
  return out;
}

async function ensureCoreSchema(env) {
  if (!coreSchemaReadyPromise) {
    coreSchemaReadyPromise = (async () => {
      const createStatements = [
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          discord_user_id TEXT NOT NULL UNIQUE,
          username TEXT,
          global_name TEXT,
          avatar_hash TEXT,
          role TEXT NOT NULL DEFAULT 'Viewer',
          role_sort INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id INTEGER,
          actor_role TEXT,
          action_type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          entity_public_id TEXT,
          summary TEXT NOT NULL DEFAULT '',
          diff_json TEXT,
          before_json TEXT,
          after_json TEXT,
          created_at TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS idx_users_role_sort ON users (role_sort DESC, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_public_id ON audit_logs (entity_public_id)"
      ];

      for (const statement of createStatements) {
        await env.DB.prepare(statement).run();
      }

      await backfillRoleSorts(env);
    })().catch((error) => {
      coreSchemaReadyPromise = null;
      throw error;
    });
  }

  await coreSchemaReadyPromise;
}

async function backfillRoleSorts(env) {
  const { results } = await env.DB.prepare("SELECT id, role FROM users").all();
  const statements = (results || []).map((row) => (
    env.DB.prepare("UPDATE users SET role_sort = ? WHERE id = ?").bind(getRoleSort(row.role), row.id)
  ));
  if (statements.length) {
    await env.DB.batch(statements);
  }
}

function getPublicTeamRoleFilter() {
  return {
    placeholders: Array.from({ length: PUBLIC_TEAM_ROLES.size }, () => "?").join(", "),
    values: [...PUBLIC_TEAM_ROLES]
  };
}

function getRoleSort(role) {
  return USER_ROLE_VALUES.indexOf(role);
}

function parseNumericPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function parseCardIdPath(pathname, prefix) {
  const cardId = decodePathSegment(pathname.slice(prefix.length), "card ID");
  if (!new RegExp(`^${escapeRegex(CARD_ID_PREFIX)}[${CARD_ID_ALPHABET}]{${CARD_ID_LENGTH}}$`).test(cardId)) {
    throw new HttpError(400, "Card ID is invalid.");
  }
  return cardId;
}

function parseDeepLinkCardId(pathname) {
  const match = pathname.match(new RegExp(`^/([${CARD_ID_ALPHABET}]{${CARD_ID_LENGTH}})/?$`));
  return match ? `${CARD_ID_PREFIX}${match[1]}` : null;
}

function parseMetaItemCardIdPath(pathname) {
  const match = pathname.match(new RegExp(`^/meta/item/([${CARD_ID_ALPHABET}]{${CARD_ID_LENGTH}})\\.svg$`));
  if (!match) {
    throw new HttpError(400, "Card ID is invalid.");
  }
  return `${CARD_ID_PREFIX}${match[1]}`;
}

function normalizeCardId(cardId) {
  return String(cardId || "").trim().toUpperCase();
}

function decodePathSegment(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, `${label} is invalid.`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrivateSwordQuery(url) {
  const category = sanitizeOptionalEnum(url.searchParams.get("category") || url.searchParams.get("badge") || "", CATEGORIES, "Category");
  const demand = sanitizeOptionalEnum(url.searchParams.get("demand") || "", DEMANDS, "Demand");
  const trend = sanitizeOptionalEnum(url.searchParams.get("trend") || "", TRENDS, "Trend");
  const cardId = normalizeCardIdSearchValue(url.searchParams.get("cardId") || url.searchParams.get("id") || "");
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sort = url.searchParams.get("sort") || "value-desc";
  const limit = parseBoundedQueryInteger(url.searchParams.get("limit"), PUBLIC_API_DEFAULT_LIMIT, 1, PUBLIC_API_LIMIT, "limit");
  const offset = parseBoundedQueryInteger(url.searchParams.get("offset"), 0, 0, PUBLIC_API_MAX_OFFSET, "offset");
  if (search.length > 100) {
    throw new HttpError(400, "Search is too long.");
  }
  if (cardId && !/^[a-z0-9]{6}$/i.test(cardId)) {
    throw new HttpError(400, "Card ID is invalid.");
  }
  if (!["value-desc", "value-asc", "name-asc", "updated-desc", "count-desc", "count-asc", "demand-desc", "demand-asc", "trend-rank"].includes(sort)) {
    throw new HttpError(400, "Sort is invalid.");
  }
  return { cardId, category, demand, limit, offset, search, sort, trend };
}

function filterPrivateSwordRows(rows, query) {
  return [...(rows || [])]
    .filter((row) => !query.category || query.category === "All" || row.c === query.category)
    .filter((row) => !query.cardId || normalizeCardIdSearchValue(row.card_id) === query.cardId)
    .filter((row) => !query.demand || String(row.d || "") === query.demand)
    .filter((row) => !query.trend || String(row.t || "") === query.trend)
    .filter((row) => matchesSwordSearch(row, query.search))
    .sort(getSwordSorter(query.sort));
}

function parseBoundedQueryInteger(value, defaultValue, min, max, label) {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return number;
}

function sanitizeDiscordId(value) {
  if (typeof value !== "string" || !/^\d{8,32}$/.test(value.trim())) {
    throw new HttpError(400, "Discord user ID is invalid.");
  }
  return value.trim();
}

function requireRole(value) {
  if (typeof value !== "string" || !USER_ROLE_VALUES.includes(value)) {
    throw new HttpError(400, "Role is invalid.");
  }
  return value;
}

function requireStatus(value) {
  if (value !== "active" && value !== "disabled") {
    throw new HttpError(400, "Status is invalid.");
  }
  return value;
}

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) {
    return "/";
  }
  try {
    const parsed = new URL(value, "https://bbtsl.invalid");
    if (parsed.origin !== "https://bbtsl.invalid") {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 200);
  } catch {
    return "/";
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${label} is required.`);
  }
  return value.trim().slice(0, 200);
}

function sanitizeOptionalString(value, limit) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "Text field is invalid.");
  }
  return value.trim().slice(0, limit);
}

function sanitizeOptionalEnum(value, allowed, label) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return value;
}

function clampInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return number;
}

function getSwordSorter(sort) {
  switch (sort) {
    case "count-desc":
      return (left, right) => compareNullableNumbers(right.ct, left.ct) || Number(left.id) - Number(right.id);
    case "count-asc":
      return (left, right) => compareNullableNumbers(left.ct, right.ct) || Number(left.id) - Number(right.id);
    case "demand-desc":
      return (left, right) => getDemandRank(right.d) - getDemandRank(left.d) || Number(right.v) - Number(left.v) || Number(left.id) - Number(right.id);
    case "demand-asc":
      return (left, right) => getDemandRank(left.d) - getDemandRank(right.d) || Number(right.v) - Number(left.v) || Number(left.id) - Number(right.id);
    case "trend-rank":
      return (left, right) => getTrendRank(right.t) - getTrendRank(left.t) || Number(right.v) - Number(left.v) || Number(left.id) - Number(right.id);
    case "value-asc":
      return (left, right) => Number(left.v) - Number(right.v) || Number(left.id) - Number(right.id);
    case "name-asc":
      return (left, right) => String(left.n || "").localeCompare(String(right.n || ""), undefined, { sensitivity: "base" }) || Number(left.id) - Number(right.id);
    case "updated-desc":
      return (left, right) => String(right.u || "").localeCompare(String(left.u || "")) || Number(left.id) - Number(right.id);
    case "value-desc":
    default:
      return (left, right) => Number(right.v) - Number(left.v) || Number(left.id) - Number(right.id);
  }
}

function compareNullableNumbers(left, right) {
  const normalizedLeft = left === null || left === undefined ? Number.NEGATIVE_INFINITY : Number(left);
  const normalizedRight = right === null || right === undefined ? Number.NEGATIVE_INFINITY : Number(right);
  return normalizedLeft - normalizedRight;
}

function getDemandRank(value) {
  return DEMAND_SORT_RANK[String(value || "N/A")] ?? DEMAND_SORT_RANK["N/A"];
}

function getTrendRank(value) {
  return TREND_SORT_RANK[String(value || "N/A")] ?? TREND_SORT_RANK["N/A"];
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCardIdSearchValue(value) {
  return normalizeSearchText(value).replace(/^#+/, "");
}

function matchesSwordSearch(row, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const searchIndex = buildSwordSearchIndex(row);
  return tokens.every((token) => matchSwordSearchToken(searchIndex, token));
}

function buildSwordSearchIndex(row) {
  const cardId = normalizeCardIdSearchValue(row.card_id);
  const rarityValues = [
    row?.rarity,
    row?.r,
    row?.rar,
    row?.tier
  ].filter(Boolean).map(normalizeSearchText);
  const category = normalizeSearchText(row.c);
  const badgeValues = [category];
  if (category === "emotes" || category === "emote") {
    badgeValues.push("emote", "emotes");
  }
  const fieldMap = {
    id: [cardId, normalizeSearchText(row.card_id)],
    badge: badgeValues,
    category: badgeValues,
    trend: [normalizeSearchText(row.t)],
    demand: [normalizeSearchText(row.d)],
    rarity: rarityValues,
    count: [row.ct === null || row.ct === undefined ? "" : String(row.ct)],
    name: [normalizeSearchText(row.n)]
  };
  return {
    fieldMap,
    generalFields: [
      normalizeSearchText(row.n),
      normalizeSearchText(row.card_id),
      cardId,
      category,
      normalizeSearchText(row.d),
      normalizeSearchText(row.t),
      normalizeSearchText(row.descr),
      ...rarityValues,
      ...fieldMap.count.filter(Boolean)
    ]
  };
}

function matchSwordSearchToken(searchIndex, token) {
  const normalizedToken = normalizeSearchText(token);
  if (!normalizedToken) {
    return true;
  }
  const structuredMatch = normalizedToken.match(/^([a-z]+):(.*)$/);
  if (structuredMatch) {
    const [, rawField, rawValue] = structuredMatch;
    const field = rawField === "cat" ? "category" : rawField;
    const value = normalizeSearchText(rawValue);
    if (!value) {
      return true;
    }
    const fields = searchIndex.fieldMap[field];
    if (!fields) {
      return searchIndex.generalFields.some((entry) => entry.includes(normalizedToken));
    }
    return fields.some((entry) => normalizeSearchText(entry).includes(value));
  }
  const normalizedId = normalizeCardIdSearchValue(normalizedToken);
  if (/^[a-z0-9]{6}$/i.test(normalizedId)) {
    return searchIndex.fieldMap.id.some((entry) => normalizeCardIdSearchValue(entry) === normalizedId);
  }
  return searchIndex.generalFields.some((entry) => entry.includes(normalizedToken));
}

function requireEnv(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new HttpError(500, `${key} is not configured.`);
  }
  return value;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function privateApiJson(body, status = 200) {
  return json(body, status, { "cache-control": "no-store" });
}

function methodNotAllowed(methods) {
  return json({ error: "Method not allowed." }, 405, { allow: methods.join(", ") });
}

function text(body, contentType, cacheControl = "public, max-age=3600") {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl
    }
  });
}

function buildRobotsText(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`
  ].join("\n");
}

function buildLlmsText(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const siteName = env.SITE_NAME || "BBTSL Blade Ball Top Spender List";
  return [
    `# ${siteName}`,
    "",
    "This site publishes community-tracked Blade Ball values for rare items.",
    "Visitors can browse the list without signing in.",
    "Signed-in users can be assigned Viewer, Contributor, Editor, Maintainer, Administrator, Developer, or Owner roles.",
    "Cards expose public value data and richer media details when selected.",
    "",
    "## Important links",
    "",
    `- [Website](${siteUrl}/)`,
    `- [Team](${siteUrl}/team)`,
    `- [Sitemap](${siteUrl}/sitemap.xml)`,
    `- [Full site guide](${siteUrl}/llms-full.txt)`
  ].join("\n");
}

function buildLlmsFullText(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const siteName = env.SITE_NAME || "BBTSL Blade Ball Top Spender List";
  return [
    `# ${siteName}`,
    "",
    "## Purpose",
    "Track Blade Ball item values in a public dark-mode catalogue with role-aware editing.",
    "",
    "## Public page structure",
    "- Sticky top bar with site identity, login state, and last-updated text.",
    "- Search field to filter items by name.",
    "- Category chips for All, LTM, Ranked, Top Spenders, Other Swords, and Explosions.",
    "- Sort control for value and recency ordering.",
    "- Card grid where each card shows name, category, demand, trend, count, value, card ID, image, and description.",
    "- Detail modal with richer media such as item animation, slash media, and slash audio when available.",
    "",
    "## Machine-readable endpoints",
    `- [Robots](${siteUrl}/robots.txt)`,
    `- [Sitemap](${siteUrl}/sitemap.xml)`,
    `- [LLM summary](${siteUrl}/llms.txt)`,
    "",
    "## Notes",
    "- The website data view is public.",
    "- Discord OAuth is used for website sign-in.",
    "- Private integrations use a separate authenticated API surface.",
    "- Staff actions are permission-gated and audit logged."
  ].join("\n");
}

async function injectDynamicHeadMarkup(html, request, env, nonce) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const pageContext = await buildPageMetaContext(request, env, siteUrl);

  const markup = [
    `<link rel="canonical" href="${pageContext.url}">`,
    `<link rel="icon" type="image/png" href="${pageContext.iconUrl}">`,
    `<link rel="shortcut icon" href="${pageContext.iconUrl}">`,
    `<link rel="apple-touch-icon" href="${pageContext.iconUrl}">`,
    `<meta property="og:site_name" content="BBTSL">`,
    `<meta property="og:url" content="${pageContext.url}">`,
    `<meta property="og:image" content="${pageContext.imageUrl}">`,
    `<meta property="og:image:secure_url" content="${pageContext.imageUrl}">`,
    `<meta property="og:image:type" content="${pageContext.imageType}">`,
    `<meta property="og:image:width" content="${pageContext.imageWidth}">`,
    `<meta property="og:image:height" content="${pageContext.imageHeight}">`,
    `<meta property="og:image:alt" content="${escapeHtmlAttribute(pageContext.imageAlt)}">`,
    `<meta name="twitter:image" content="${pageContext.imageUrl}">`,
    `<meta name="twitter:image:alt" content="${escapeHtmlAttribute(pageContext.imageAlt)}">`,
    `<script type="application/ld+json">${serializeJsonForHtml(pageContext.structuredData)}</script>`,
    await buildLcpPreloadMarkup(request, env)
  ].join("");

  const withHeadTags = html
    .replace(/<title>.*?<\/title>/i, `<title>${escapeHtmlContent(pageContext.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${escapeHtmlAttribute(pageContext.description)}">`)
    .replace(/<meta name="theme-color" content="[^"]*">/i, `<meta name="theme-color" content="${escapeHtmlAttribute(pageContext.themeColor)}">`)
    .replace(/<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${escapeHtmlAttribute(pageContext.title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${escapeHtmlAttribute(pageContext.description)}">`)
    .replace(/<meta name="twitter:card" content="[^"]*">/i, `<meta name="twitter:card" content="${escapeHtmlAttribute(pageContext.twitterCard)}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${escapeHtmlAttribute(pageContext.title)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${escapeHtmlAttribute(pageContext.description)}">`);
  return addScriptNonces(withHeadTags.replace('<meta name="bbtsl-dynamic-meta" content="">', markup), nonce);
}

async function buildPageMetaContext(request, env, siteUrl) {
  const itemCardId = getRequestedItemCardId(request);
  const basePath = getCanonicalBasePath(request);
  const defaultContext = {
    title: "Blade Ball Top Spender List",
    description: "Track and search Blade Ball Top Spender Items in one place.",
    url: `${siteUrl}${basePath}`,
    iconUrl: `${siteUrl}/og-image.png`,
    imageUrl: `${siteUrl}/og-image.png`,
    imageType: "image/png",
    imageWidth: "1200",
    imageHeight: "630",
    imageAlt: "Blade Ball Top Spender List preview image",
    themeColor: "#12151a",
    twitterCard: "summary_large_image",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Blade Ball Top Spender List",
      description: "Track and search Blade Ball Top Spender Items in one place.",
      url: `${siteUrl}/`
    }
  };
  if (!itemCardId || basePath !== "/") {
    return defaultContext;
  }
  const state = await loadSiteState(env);
  const row = getSiteSwordByCardId(state, itemCardId);
  if (!row) {
    return defaultContext;
  }
  const mediaMap = buildSiteMediaDescriptorMap(state, collectSwordMediaKeys([row]));
  const sword = serializeSword(row, mediaMap);
  const valueLabel = sword.ownersChoice ? "Owner's Choice" : formatMetaValue(sword.v);
  const countLabel = sword.ct === null || sword.ct === undefined ? "-" : String(sword.ct);
  const themeColor = getMetaValueAccent(state, sword.v);
  const title = sword.n;
  const description = [
    sword.c,
    `Value: ${valueLabel} Tokens`,
    `Demand: ${sword.d}`,
    `Trend: ${sword.t}`,
    `Count: ${countLabel}`
  ].join("\n");
  const imageUrl = sword.img?.kind === "image"
    ? (sword.img.original || sword.img.medium || sword.img.low || defaultContext.imageUrl)
    : defaultContext.imageUrl;
  return {
    title,
    description,
    url: `${siteUrl}/?item=${encodeURIComponent(String(sword.cardId || "").replace(/^#/, ""))}`,
    iconUrl: defaultContext.iconUrl,
    imageUrl,
    imageType: detectMetaImageType(imageUrl),
    imageWidth: sword.img?.kind === "image" ? "512" : defaultContext.imageWidth,
    imageHeight: sword.img?.kind === "image" ? "512" : defaultContext.imageHeight,
    imageAlt: `${sword.n} sword preview`,
    themeColor,
    twitterCard: "summary_large_image",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Thing",
      name: sword.n,
      description,
      url: `${siteUrl}/?item=${encodeURIComponent(String(sword.cardId || "").replace(/^#/, ""))}`,
      image: imageUrl,
      identifier: sword.cardId,
      category: sword.c,
      additionalProperty: [
        { "@type": "PropertyValue", name: "Demand", value: sword.d },
        { "@type": "PropertyValue", name: "Trend", value: sword.t },
        { "@type": "PropertyValue", name: "Count", value: countLabel },
        { "@type": "PropertyValue", name: "Value", value: valueLabel }
      ]
    }
  };
}

function getRequestedItemCardId(request) {
  const url = new URL(request.url);
  const value = sanitizeOptionalString(url.searchParams.get("item"), CARD_ID_LENGTH);
  if (!value || !new RegExp(`^[${CARD_ID_ALPHABET}]{${CARD_ID_LENGTH}}$`).test(value)) {
    return null;
  }
  return `${CARD_ID_PREFIX}${value}`;
}

function formatMetaValue(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function detectMetaImageType(url) {
  const lowerUrl = String(url || "").split("?")[0].toLowerCase();
  if (lowerUrl.endsWith(".webp")) {
    return "image/webp";
  }
  if (lowerUrl.endsWith(".jpg") || lowerUrl.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerUrl.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/png";
}

function getMetaValueAccent(state, value) {
  const values = (state.swords || []).map((row) => Number(row.v || 0));
  if (!values.length) {
    return VALUE_BAR_STOPS[0];
  }
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;
  const position = range <= 0 ? 0 : (Number(value || 0) - minValue) / range;
  const index = Math.min(VALUE_BAR_STOPS.length - 1, Math.max(0, Math.floor(position * (VALUE_BAR_STOPS.length - 1))));
  return VALUE_BAR_STOPS[index];
}

function buildItemMetaSvg(sword) {
  const categoryColor = CATEGORY_COLOR_MAP[sword.c] || "#7d8aa3";
  const valueColor = sword.ownersChoice ? "#f4cf5c" : "#ff8a3d";
  const title = escapeSvgText(sword.n || "Unknown Item");
  const cardId = escapeSvgText(sword.cardId || "#------");
  const category = escapeSvgText(sword.c || "Item");
  const demand = escapeSvgText(sword.d || "N/A");
  const trend = escapeSvgText(sword.t || "N/A");
  const count = escapeSvgText(sword.ct === null || sword.ct === undefined ? "-" : String(sword.ct));
  const value = escapeSvgText(sword.ownersChoice ? "Owner's Choice" : formatMetaValue(sword.v));
  const imageUrl = sword.img?.kind === "image" ? escapeSvgAttribute(sword.img.original || sword.img.medium || sword.img.low || "") : "";
  const imageMarkup = imageUrl
    ? `<g><rect x="822" y="108" width="286" height="414" rx="32" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/><image href="${imageUrl}" x="840" y="126" width="250" height="378" preserveAspectRatio="xMidYMid meet"/></g>`
    : `<g><rect x="822" y="108" width="286" height="414" rx="32" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/><text x="965" y="322" fill="#9aa4b7" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="28" text-anchor="middle">No image</text></g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1d2330"/>
      <stop offset="100%" stop-color="#10141b"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${categoryColor}"/>
      <stop offset="100%" stop-color="${valueColor}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="18" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="12" fill="url(#accent)"/>
  <circle cx="145" cy="540" r="180" fill="${categoryColor}" opacity=".14" filter="url(#glow)"/>
  <circle cx="1055" cy="76" r="124" fill="${valueColor}" opacity=".1" filter="url(#glow)"/>
  <text x="78" y="88" fill="#d7deeb" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="4">BBTSL</text>
  <text x="78" y="158" fill="#f6f8fb" font-family="'Rajdhani', Arial, sans-serif" font-size="64" font-weight="700">${title}</text>
  <text x="78" y="202" fill="${categoryColor}" font-family="'JetBrains Mono', monospace" font-size="28" font-weight="700">${cardId}</text>
  <text x="78" y="268" fill="#d0d7e4" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="26">${category}</text>
  <text x="78" y="336" fill="${valueColor}" font-family="'JetBrains Mono', monospace" font-size="52" font-weight="700">${value}</text>
  <g transform="translate(78 398)">
    <rect width="188" height="86" rx="22" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/>
    <text x="24" y="30" fill="#8e99ad" font-family="'JetBrains Mono', monospace" font-size="18" letter-spacing="2">DEMAND</text>
    <text x="24" y="62" fill="#f6f8fb" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="28" font-weight="700">${demand}</text>
  </g>
  <g transform="translate(286 398)">
    <rect width="188" height="86" rx="22" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/>
    <text x="24" y="30" fill="#8e99ad" font-family="'JetBrains Mono', monospace" font-size="18" letter-spacing="2">TREND</text>
    <text x="24" y="62" fill="#f6f8fb" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="28" font-weight="700">${trend}</text>
  </g>
  <g transform="translate(494 398)">
    <rect width="188" height="86" rx="22" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/>
    <text x="24" y="30" fill="#8e99ad" font-family="'JetBrains Mono', monospace" font-size="18" letter-spacing="2">COUNT</text>
    <text x="24" y="62" fill="#f6f8fb" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="28" font-weight="700">${count}</text>
  </g>
  <text x="78" y="560" fill="#9ba6ba" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="24">Blade Ball Top Spender List</text>
  ${imageMarkup}
</svg>`;
}

function escapeSvgText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeSvgAttribute(value) {
  return escapeSvgText(value)
    .replaceAll('"', "&quot;");
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\n", "&#10;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlContent(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createCspNonce() {
  return crypto.randomUUID().replace(/-/g, "");
}

function buildContentSecurityPolicy(nonce) {
  return buildSecureContentSecurityPolicy(HTML_SECURITY_HEADERS["content-security-policy"], nonce);
}

async function buildLcpPreloadMarkup(request, env) {
  if (new URL(request.url).pathname !== "/") {
    return "";
  }
  try {
    const state = await loadSiteState(env);
    const topSword = [...(state.swords || [])]
      .filter((row) => row.image_key)
      .sort(getSwordSorter("value-desc"))[0];
    if (!topSword?.image_key) {
      return "";
    }
    const mediaMap = buildSiteMediaDescriptorMap(state, [topSword.image_key]);
    const descriptor = mediaMap.get(topSword.image_key);
    const preloadUrl = descriptor?.low || descriptor?.medium || descriptor?.original;
    return preloadUrl ? `<link rel="preload" as="image" href="${preloadUrl}" fetchpriority="high">` : "";
  } catch (error) {
    console.error("Could not build the homepage image preload.", error);
    return "";
  }
}

function getCanonicalBasePath(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const canonicalPaths = new Map([
    ["/team.html", "/team"],
    ["/privacy.html", "/privacy"],
    ["/terms.html", "/terms"]
  ]);
  return canonicalPaths.get(path) || path;
}

function buildSitemapXml(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/team</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${siteUrl}/privacy</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${siteUrl}/terms</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>`;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  const contentType = (headers.get("content-type") || "").toLowerCase();
  headers.set("referrer-policy", HTML_SECURITY_HEADERS["referrer-policy"]);
  headers.set("x-content-type-options", HTML_SECURITY_HEADERS["x-content-type-options"]);
  headers.set("x-frame-options", HTML_SECURITY_HEADERS["x-frame-options"]);
  headers.set("permissions-policy", HTML_SECURITY_HEADERS["permissions-policy"]);
  if (contentType.includes("text/html") && !headers.has("content-security-policy")) {
    headers.set("content-security-policy", buildContentSecurityPolicy(createCspNonce()));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function enforceTrustedOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) {
    const referer = request.headers.get("referer");
    if (!referer) {
      throw new HttpError(403, "Missing same-origin context.");
    }
    let refererUrl;
    try {
      refererUrl = new URL(referer);
    } catch {
      throw new HttpError(403, "Invalid same-origin context.");
    }
    if (refererUrl.origin !== url.origin) {
      throw new HttpError(403, "Cross-origin requests are not allowed.");
    }
    return;
  }
  if (origin !== url.origin) {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }
}

function enforceInternalReadRequest(request) {
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "same-origin") {
    return;
  }
  enforceTrustedOrigin(request);
}

function enforceAppRequest(request) {
  if (request.headers.get(APP_REQUEST_HEADER) !== "1") {
    throw new HttpError(403, "Invalid application request.");
  }
}

function getClientIdentifier(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || request.headers.get("x-real-ip");
  return (forwarded || "local").split(",")[0].trim().slice(0, 80) || "local";
}

async function consumeRateLimit(env, bucket, key, limit, windowSeconds) {
  const result = await consumeAtomicRateLimit(env.DB, bucket, key, limit, windowSeconds);
  if (!result.allowed) {
    throw new HttpError(429, "Too many requests. Try again shortly.", { "retry-after": String(result.retryAfter) });
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const pair of cookieHeader.split(/;\s*/)) {
    if (!pair) {
      continue;
    }
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    out[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return out;
}

async function hmacHex(secret, value, secretLabel = "ADMIN_SESSION_SECRET") {
  if (!secret) {
    throw new HttpError(500, `${secretLabel} is not configured.`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...signature].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function currentUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getNextUtcDateString(dateString) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function currentIsoString() {
  return new Date().toISOString();
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}
