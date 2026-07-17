const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

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
const AUTH_VERIFY_BUCKET = "auth_verify";
const ADMIN_MUTATION_BUCKET = "admin_mutation";
const PUBLIC_API_BUCKET = "public_api";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 12;
const REAUTH_WINDOW_SECONDS = 60 * 10;
const OAUTH_STATE_LIFETIME_SECONDS = 60 * 10;
const PUBLIC_API_LIMIT = 100;
const PUBLIC_API_DEFAULT_LIMIT = 50;
const PUBLIC_API_MAX_OFFSET = 10_000;
const OAUTH_RATE_LIMIT = 20;
const MAX_EDIT_VALUE = 10_000_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_SFX_BYTES = 1 * 1024 * 1024;
const MAX_VISUAL_PREVIEW_BYTES = 10 * 1024 * 1024;
const DIRECT_MEDIA_READ_LIMIT = 512 * 1024;
const D1_MEDIA_CHUNK_BYTES = 1 * 1024 * 1024;
const CARD_ID_PREFIX = "#";
const CARD_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CARD_ID_LENGTH = 6;
const MEDIA_KEY_LIMIT = 512;
const USER_ROLE_VALUES = ["Viewer", "Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"];
const PUBLIC_TEAM_ROLES = new Set(["Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"]);
const CATEGORIES = new Set(["LTM", "Ranked", "Top Spenders", "Other Swords", "Explosions"]);
const DEMANDS = new Set(["Very High", "High", "Medium", "Low", "N/A"]);
const TRENDS = new Set(["Rising", "Falling", "Stable", "Manipulated", "N/A"]);
const MEDIA_VARIANTS = new Set(["card-image", "detail", "slash", "slash-audio"]);
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

export default {
  async fetch(request, env) {
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

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
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

      if (url.pathname === "/api/v1/health" || url.pathname === "/api/v1/swords" || url.pathname === "/api/v1/team" || url.pathname.startsWith("/api/v1/swords/")) {
        return withSecurityHeaders(methodNotAllowed(["GET"]));
      }

      if (url.pathname === "/api/swords" && request.method === "GET") {
        return withSecurityHeaders(await handleListSwords(request, env, url));
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
        return withSecurityHeaders(await requireCapability(request, env, "data:export", ({ actor }) => handleExport(env, actor)));
      }

      if (url.pathname === "/api/team" && request.method === "GET") {
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
        return withSecurityHeaders(await requireCapability(request, env, "audit:view", () => handleListAudit(url, env)));
      }

      if (url.pathname === "/api/audit/revert" && request.method === "POST") {
        return withSecurityHeaders(await requireCapability(request, env, "audit:revert", ({ actor, session }) => handleAuditRevert(request, env, actor, session)));
      }

      if ((url.pathname.startsWith("/images/") || url.pathname.startsWith("/media/")) && request.method === "GET") {
        const prefix = url.pathname.startsWith("/images/") ? "/images/" : "/media/";
        const key = decodePathSegment(url.pathname.slice(prefix.length), "media key");
        return withSecurityHeaders(await handleGetMedia(request, env, key));
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
};

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
    headers.set("cache-control", "no-store");
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
  headers.set("cache-control", "no-store");
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
  return json(buildAuthStatusResponse(actor));
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
  const cookie = await issueSessionCookie(request, env, {
    userId: user.id,
    purpose: state.purpose || "login",
    returnTo: state.returnTo || "/"
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

async function handleListSwords(request, env, url) {
  const actor = await getActorFromRequest(request, env);
  const category = url.searchParams.get("category");
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sort = url.searchParams.get("sort") || "value-desc";

  const sortSql = getSortSql(sort);
  const bindings = [];
  const where = [];

  if (category && category !== "All") {
    where.push("c = ?");
    bindings.push(category);
  }

  if (search) {
    where.push("LOWER(n) LIKE ?");
    bindings.push(`%${search}%`);
  }

  const sql = `
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ${sortSql}
  `;

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(results || []));
  return json({
    swords: (results || []).map((row) => serializeSword(row, mediaMap)),
    auth: buildAuthStatusResponse(actor)
  });
}

function handlePublicApiHealth() {
  return publicApiJson({
    ok: true,
    version: "v1"
  });
}

async function handlePublicApiListSwords(request, env, url) {
  await consumeRateLimit(env, PUBLIC_API_BUCKET, getClientIdentifier(request), 120, 60);
  const query = parsePublicSwordQuery(url);
  const { results } = await env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    ${query.where.length ? `WHERE ${query.where.join(" AND ")}` : ""}
    ${query.sortSql}
    LIMIT ? OFFSET ?
  `).bind(...query.bindings, query.limit, query.offset).all();
  const totalRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM swords
    ${query.where.length ? `WHERE ${query.where.join(" AND ")}` : ""}
  `).bind(...query.bindings).first();
  const rows = results || [];
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(rows));
  return publicApiJson({
    data: rows.map((row) => serializeSword(row, mediaMap)),
    meta: {
      total: Number(totalRow?.total || 0),
      limit: query.limit,
      offset: query.offset
    }
  });
}

async function handlePublicApiGetSword(request, env, url) {
  await consumeRateLimit(env, PUBLIC_API_BUCKET, getClientIdentifier(request), 120, 60);
  const cardId = parseCardIdPath(url.pathname, "/api/v1/swords/");
  const row = await getSwordByCardId(env, cardId);
  if (!row) {
    throw new HttpError(404, "Sword not found.");
  }
  const mediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([row]));
  return publicApiJson({ data: serializeSword(row, mediaMap) });
}

async function handlePublicApiTeam(request, env) {
  await consumeRateLimit(env, PUBLIC_API_BUCKET, getClientIdentifier(request), 120, 60);
  const { placeholders, values } = getPublicTeamRoleFilter();
  const { results } = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at
    FROM users
    WHERE status = 'active' AND role IN (${placeholders})
    ORDER BY role_sort DESC, updated_at DESC, id ASC
  `).bind(...values).all();
  return publicApiJson({ data: (results || []).map((row) => serializePublicTeamUser(row)) });
}

async function handleCreateSword(request, env, actor) {
  const payload = normalizeSwordPayload(await request.json());
  const { image, detailMedia, slashMedia, slashAudio } = await persistSwordMedia(env, payload, payload.n);
  const cardId = await generateUniqueCardId(env);
  const now = currentDateString();

  const result = await env.DB.prepare(`
    INSERT INTO swords (card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    cardId,
    payload.n,
    payload.c,
    payload.v,
    payload.d,
    payload.t,
    payload.ct,
    now,
    payload.descr,
    image.mediaKey,
    detailMedia.mediaKey,
    slashMedia.mediaKey,
    slashAudio.mediaKey
  ).run();

  const created = await getSwordById(env, Number(result.meta.last_row_id));
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
  const { image, detailMedia, slashMedia, slashAudio } = await persistSwordMedia(env, payload, payload.n, existing);
  const beforeMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys([existing]));
  const beforeSnapshot = serializeSword(existing, beforeMediaMap);

  await env.DB.prepare(`
    UPDATE swords
    SET n = ?, c = ?, v = ?, d = ?, t = ?, ct = ?, u = ?, descr = ?, image_key = ?, detail_image_key = ?, slash_media_key = ?, slash_audio_key = ?, edited = 1
    WHERE id = ?
  `).bind(
    payload.n,
    payload.c,
    payload.v,
    payload.d,
    payload.t,
    payload.ct,
    currentDateString(),
    payload.descr,
    image.mediaKey,
    detailMedia.mediaKey,
    slashMedia.mediaKey,
    slashAudio.mediaKey,
    id
  ).run();

  const updated = await getSwordById(env, id);
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

  await env.DB.prepare("DELETE FROM swords WHERE id = ?").bind(id).run();
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

  const beforeRows = await env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    ORDER BY id ASC
  `).all();
  const beforeResults = beforeRows.results || [];
  const beforeMediaMap = await loadMediaDescriptorMap(env, collectSwordMediaKeys(beforeResults));

  await env.DB.batch([
    env.DB.prepare("DELETE FROM swords"),
    env.DB.prepare(`
      INSERT INTO swords (id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited)
      SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
      FROM sword_baseline
      ORDER BY id ASC
    `)
  ]);

  const afterRows = await env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    ORDER BY id ASC
  `).all();
  const afterResults = afterRows.results || [];
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
  const { results } = await env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    ORDER BY v DESC, id ASC
  `).all();
  await writeAuditLog(env, {
    actor,
    actionType: "data.export",
    entityType: "collection",
    entityId: null,
    entityPublicId: null,
    summary: "Exported sword data",
    beforeSnapshot: null,
    afterSnapshot: { count: Number((results || []).length) }
  });
  return json({ swords: (results || []).map((row) => serializeSword(row)) });
}

async function handleListTeam(request, env) {
  const actor = await getActorFromRequest(request, env);
  const includeAll = hasCapability(actor?.user?.role, "team:manage");
  const { placeholders, values } = getPublicTeamRoleFilter();
  const sql = includeAll
    ? "SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE role != ? ORDER BY role_sort DESC, updated_at DESC, id ASC"
    : `SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, created_at, updated_at, last_login_at FROM users WHERE status = 'active' AND role IN (${placeholders}) ORDER BY role_sort DESC, updated_at DESC, id ASC`;
  const bindings = includeAll ? ["Viewer"] : values;
  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return json({
    team: (results || []).map((row) => includeAll ? serializeTeamUser(row) : serializePublicTeamUser(row)),
    auth: buildAuthStatusResponse(actor)
  });
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

  const existing = await env.DB.prepare("SELECT id FROM users WHERE discord_user_id = ?").bind(discordUserId).first();
  if (existing) {
    throw new HttpError(409, "A team member with that Discord user ID already exists.");
  }

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
    currentIsoString(),
    currentIsoString()
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
  await writeAuditLog(env, {
    actor,
    actionType: "audit.revert",
    entityType: "sword",
    entityId: updated?.id || Number(row.entity_id),
    entityPublicId: updated?.card_id || row.entity_public_id,
    summary: `Reverted audit log #${logId}`,
    beforeSnapshot: current ? serializeSword(current) : null,
    afterSnapshot: updated ? serializeSword(updated) : beforeSnapshot
  });

  return json({ ok: true, sword: updated ? serializeSword(updated) : null });
}

async function handleGetMedia(request, env, key) {
  if (!key) {
    throw new HttpError(400, "Missing media key.");
  }

  if (key === "unavailable.webp") {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const row = await env.DB.prepare(`
    SELECT content_type, COALESCE(media_size, length(image_data)) AS media_size
    FROM sword_images
    WHERE image_key = ?
  `).bind(key).first();

  if (!row) {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const mediaSize = Number(row.media_size || 0);
  let mediaBody = null;
  if (mediaSize > 0 && mediaSize <= DIRECT_MEDIA_READ_LIMIT) {
    const bodyRow = await env.DB.prepare(`
      SELECT image_data
      FROM sword_images
      WHERE image_key = ?
    `).bind(key).first();
    mediaBody = await readMediaBody(bodyRow?.image_data);
  }

  if (!mediaBody?.byteLength) {
    mediaBody = await readMediaBodyFromChunks(env, key, mediaSize);
  }

  if (!mediaBody?.byteLength) {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const headers = new Headers();
  const contentType = String(row.content_type || "").toLowerCase();
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", HTML_SECURITY_HEADERS["x-content-type-options"]);
  if (contentType === "image/svg+xml" || key.toLowerCase().endsWith(".svg")) {
    headers.set("content-disposition", `attachment; filename="${key.split("/").pop() || "media.svg"}"`);
    headers.set("content-security-policy", "default-src 'none'; sandbox");
  }
  const response = new Response(mediaBody, { headers });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function requireCapability(request, env, capability, fn) {
  if (request.method !== "GET") {
    enforceTrustedOrigin(request);
    enforceAppRequest(request);
    await consumeRateLimit(env, ADMIN_MUTATION_BUCKET, getClientIdentifier(request), 60, 300);
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

  return { session, user: normalizeUserRow(user) };
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
    reauthAt: payload.reauthAt || payload.iat || 0
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
    reauthAt
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
      reauthFresh: false
    };
  }

  return {
    authenticated: true,
    user: serializeTeamUser(actor.user),
    permissions: [...getPermissionsForRole(actor.user.role)],
    reauthFresh: Boolean(actor.session?.reauthAt && ((Math.floor(Date.now() / 1000) - Number(actor.session.reauthAt)) <= REAUTH_WINDOW_SECONDS))
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

function serializePublicTeamUser(row) {
  const user = normalizeUserRow(row);
  return {
    displayName: user.global_name || user.username || "BBTSL Team",
    handle: user.username ? `@${user.username}` : "",
    avatarUrl: buildDiscordAvatarUrl(user.discord_user_id, user.avatar_hash),
    role: user.role
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

async function getSwordById(env, id) {
  return env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    WHERE id = ?
  `).bind(id).first();
}

async function getSwordByCardId(env, cardId) {
  return env.DB.prepare(`
    SELECT id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited
    FROM swords
    WHERE card_id = ?
  `).bind(cardId).first();
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
    edited: Boolean(row.edited)
  };
}

function collectSwordMediaKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    [row.image_key, row.detail_image_key, row.slash_media_key, row.slash_audio_key].forEach((key) => {
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

function normalizeSwordPayload(body) {
  return {
    n: requireString(body.n, "Name"),
    c: requireEnum(body.c, CATEGORIES, "Category"),
    v: clampInteger(body.v, 0, MAX_EDIT_VALUE, "Value"),
    d: requireEnum(body.d, DEMANDS, "Demand"),
    t: requireEnum(body.t, TRENDS, "Trend"),
    ct: body.ct === null || body.ct === undefined || body.ct === "" ? null : clampInteger(body.ct, 0, 1_000_000, "Count"),
    descr: sanitizeOptionalString(body.descr, MAX_TEXT_LENGTH),
    img: body.img,
    detailMedia: body.detailMedia,
    slashMedia: body.slashMedia,
    slashAudio: body.slashAudio
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
    slashAudio: snapshot.slashAudio ?? null
  };
}

async function applySwordSnapshotUpdate(env, id, payload) {
  const current = await getSwordById(env, id);
  if (!current) {
    throw new HttpError(404, "Sword not found.");
  }
  const normalized = normalizeSwordPayload(payload);
  const { image, detailMedia, slashMedia, slashAudio } = await persistSwordMedia(env, normalized, normalized.n, current);

  await env.DB.prepare(`
    UPDATE swords
    SET n = ?, c = ?, v = ?, d = ?, t = ?, ct = ?, u = ?, descr = ?, image_key = ?, detail_image_key = ?, slash_media_key = ?, slash_audio_key = ?, edited = 1
    WHERE id = ?
  `).bind(
    normalized.n,
    normalized.c,
    normalized.v,
    normalized.d,
    normalized.t,
    normalized.ct,
    currentDateString(),
    normalized.descr,
    image.mediaKey,
    detailMedia.mediaKey,
    slashMedia.mediaKey,
    slashAudio.mediaKey,
    id
  ).run();
}

async function restoreSwordSnapshot(env, snapshot) {
  const existing = await getSwordById(env, Number(snapshot.id));
  if (!existing) {
    const { image, detailMedia, slashMedia, slashAudio } = await persistSwordMedia(env, swordPayloadFromSnapshot(snapshot), snapshot.n);
    await env.DB.prepare(`
      INSERT INTO swords (id, card_id, n, c, v, d, t, ct, u, descr, image_key, detail_image_key, slash_media_key, slash_audio_key, edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      snapshot.id,
      snapshot.cardId,
      snapshot.n,
      snapshot.c,
      snapshot.v,
      snapshot.d,
      snapshot.t,
      snapshot.ct,
      currentDateString(),
      snapshot.descr || "",
      image.mediaKey,
      detailMedia.mediaKey,
      slashMedia.mediaKey,
      slashAudio.mediaKey
    ).run();
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
  return { image, detailMedia, slashMedia, slashAudio };
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
  const variantKeys = buildVariantKeys(baseKey, parsed.extension);
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
  const variantKeys = buildVariantKeys(baseKey, parsedOriginal.extension);
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
  if (variant === "detail" || variant === "slash") {
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

function buildVariantKeys(baseKey, extension) {
  return {
    low: `${baseKey}--low.${extension}`,
    medium: `${baseKey}--medium.${extension}`,
    original: `${baseKey}--original.${extension}`
  };
}

async function upsertMediaRecord(env, mediaKey, contentType, bytes) {
  const usesChunks = bytes.byteLength > D1_MEDIA_CHUNK_BYTES;
  const statements = [env.DB.prepare(`
    INSERT INTO sword_images (image_key, content_type, image_data, media_size, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(image_key) DO UPDATE SET
      content_type = excluded.content_type,
      image_data = excluded.image_data,
      media_size = excluded.media_size,
      updated_at = excluded.updated_at
  `).bind(
    mediaKey,
    contentType,
    usesChunks ? new Uint8Array() : bytes,
    bytes.byteLength,
    currentIsoString()
  ), env.DB.prepare("DELETE FROM media_chunks WHERE image_key = ?").bind(mediaKey)];

  if (usesChunks) {
    for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += D1_MEDIA_CHUNK_BYTES, chunkIndex += 1) {
      const chunk = bytes.slice(offset, offset + D1_MEDIA_CHUNK_BYTES);
      statements.push(env.DB.prepare(`
        INSERT INTO media_chunks (image_key, chunk_index, chunk_data)
        VALUES (?, ?, ?)
      `).bind(mediaKey, chunkIndex, chunk));
    }
  }

  await env.DB.batch(statements);
}

async function upsertMediaVariantSet(env, record) {
  await env.DB.prepare(`
    INSERT INTO media_variant_sets (base_key, media_kind, content_type, low_key, medium_key, original_key, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(base_key) DO UPDATE SET
      media_kind = excluded.media_kind,
      content_type = excluded.content_type,
      low_key = excluded.low_key,
      medium_key = excluded.medium_key,
      original_key = excluded.original_key,
      updated_at = excluded.updated_at
  `).bind(
    record.baseKey,
    record.mediaKind,
    record.contentType,
    record.lowKey,
    record.mediumKey,
    record.originalKey,
    currentIsoString()
  ).run();
}

async function loadMediaDescriptorMap(env, baseKeys) {
  const keyList = [...new Set((baseKeys || []).filter(Boolean))];
  if (!keyList.length) {
    return new Map();
  }

  const mediaMap = new Map();
  const manifests = await selectByInClause(
    env,
    "SELECT base_key, media_kind, content_type, low_key, medium_key, original_key FROM media_variant_sets WHERE base_key IN",
    keyList
  );
  for (const row of manifests) {
    mediaMap.set(row.base_key, {
      key: row.base_key,
      kind: row.media_kind || inferMediaKindFromKey(row.original_key || row.base_key),
      low: buildMediaUrl(row.low_key || row.original_key || row.base_key),
      medium: buildMediaUrl(row.medium_key || row.original_key || row.base_key),
      original: buildMediaUrl(row.original_key || row.base_key)
    });
  }

  const missingKeys = keyList.filter((key) => !mediaMap.has(key));
  if (!missingKeys.length) {
    return mediaMap;
  }

  const originalRows = await selectByInClause(
    env,
    "SELECT image_key, content_type FROM sword_images WHERE image_key IN",
    missingKeys
  );
  const contentTypeMap = new Map(originalRows.map((row) => [row.image_key, row.content_type]));
  for (const key of missingKeys) {
    const contentType = contentTypeMap.get(key) || "";
    mediaMap.set(key, {
      key,
      kind: inferMediaKindFromContentType(contentType) || inferMediaKindFromKey(key),
      low: buildMediaUrl(key),
      medium: buildMediaUrl(key),
      original: buildMediaUrl(key)
    });
  }

  return mediaMap;
}

async function selectByInClause(env, sqlPrefix, values) {
  if (!values.length) {
    return [];
  }
  const results = [];
  const chunkSize = 64;
  for (let start = 0; start < values.length; start += chunkSize) {
    const slice = values.slice(start, start + chunkSize);
    const placeholders = slice.map(() => "?").join(", ");
    const sql = `${sqlPrefix} (${placeholders})`;
    const rows = await env.DB.prepare(sql).bind(...slice).all();
    for (const row of rows.results || []) {
      results.push(row);
    }
  }
  return results;
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

function getMediaFieldLabel(variant) {
  const labels = {
    "card-image": "Card Media",
    detail: "VFX Preview",
    slash: "Slash Preview",
    "slash-audio": "Slash Audio"
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

function normalizeBlobBody(value) {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }

  if (value?.buffer instanceof ArrayBuffer) {
    const byteOffset = Number(value.byteOffset || 0);
    const byteLength = Number(value.byteLength || value.buffer.byteLength || 0);
    return new Uint8Array(value.buffer, byteOffset, byteLength);
  }

  if (value && typeof value === "object") {
    const numericKeys = Object.keys(value)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right));
    if (numericKeys.length > 0) {
      return Uint8Array.from(numericKeys.map((key) => Number(value[key]) || 0));
    }
  }

  return value;
}

async function readMediaBody(value) {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }

  const normalized = normalizeBlobBody(value);
  if (normalized instanceof Uint8Array) {
    return normalized;
  }

  if (normalized instanceof ArrayBuffer) {
    return new Uint8Array(normalized);
  }

  return null;
}

async function readMediaBodyFromChunks(env, key, mediaSize) {
  if (!Number.isFinite(mediaSize) || mediaSize <= 0) {
    return null;
  }

  const chunked = new Uint8Array(mediaSize);
  let chunkOffset = 0;
  const chunkRowsResult = await env.DB.prepare(`
    SELECT chunk_index, chunk_data
    FROM media_chunks
    WHERE image_key = ?
    ORDER BY chunk_index ASC
  `).bind(key).all();
  const chunkRows = Array.isArray(chunkRowsResult?.results) ? chunkRowsResult.results : [];
  for (let rowIndex = 0; rowIndex < chunkRows.length && chunkOffset < mediaSize; rowIndex += 1) {
    const row = chunkRows[rowIndex];
    if (Number(row?.chunk_index) !== rowIndex) {
      break;
    }
    const chunk = await readMediaBody(row?.chunk_data);
    const expectedLength = Math.min(D1_MEDIA_CHUNK_BYTES, mediaSize - chunkOffset);
    if (!chunk || chunk.byteLength !== expectedLength) {
      break;
    }
    chunked.set(chunk, chunkOffset);
    chunkOffset += chunk.byteLength;
  }
  if (chunkOffset === mediaSize) {
    return chunked;
  }

  const chunkSize = 262144;
  const bytes = new Uint8Array(mediaSize);
  for (let offset = 0; offset < mediaSize; offset += chunkSize) {
    const length = Math.min(chunkSize, mediaSize - offset);
    const row = await env.DB.prepare(`
      SELECT hex(substr(image_data, ?, ?)) AS media_hex
      FROM sword_images
      WHERE image_key = ?
    `).bind(offset + 1, length, key).first();
    const chunk = hexToBytes(row?.media_hex);
    if (chunk.byteLength !== length) {
      return null;
    }
    bytes.set(chunk, offset);
  }
  return bytes;
}

function hexToBytes(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0) {
    return new Uint8Array();
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function writeAuditLog(env, entry) {
  const beforeSnapshot = entry.beforeSnapshot === undefined ? null : entry.beforeSnapshot;
  const afterSnapshot = entry.afterSnapshot === undefined ? null : entry.afterSnapshot;
  const diff = buildDiff(beforeSnapshot, afterSnapshot);
  await env.DB.prepare(`
    INSERT INTO audit_logs (actor_user_id, actor_role, action_type, entity_type, entity_id, entity_public_id, summary, diff_json, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.actor?.id || entry.actor?.user?.id || null,
    entry.actor?.role || entry.actor?.user?.role || null,
    entry.actionType,
    entry.entityType,
    entry.entityId,
    entry.entityPublicId,
    entry.summary,
    JSON.stringify(diff),
    beforeSnapshot === null ? null : JSON.stringify(beforeSnapshot),
    afterSnapshot === null ? null : JSON.stringify(afterSnapshot),
    currentIsoString()
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
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    actorRole: row.actor_role || "",
    actorUsername: row.actor_username || "",
    actorGlobalName: row.actor_global_name || "",
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    entityPublicId: row.entity_public_id || null,
    summary: row.summary || "",
    diff: parseJsonField(row.diff_json) || [],
    before: parseJsonField(row.before_json),
    after: parseJsonField(row.after_json),
    createdAt: row.created_at
  };
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

async function generateUniqueCardId(env) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = `${CARD_ID_PREFIX}${generateRandomCardIdBody()}`;
    const existing = await env.DB.prepare("SELECT id FROM swords WHERE card_id = ?").bind(next).first();
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
        `CREATE TABLE IF NOT EXISTS swords (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          n TEXT NOT NULL,
          c TEXT NOT NULL,
          v INTEGER NOT NULL,
          d TEXT NOT NULL,
          t TEXT NOT NULL,
          ct INTEGER,
          u TEXT NOT NULL,
          descr TEXT NOT NULL DEFAULT '',
          image_key TEXT,
          edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1))
        )`,
        `CREATE TABLE IF NOT EXISTS sword_baseline (
          id INTEGER PRIMARY KEY,
          n TEXT NOT NULL,
          c TEXT NOT NULL,
          v INTEGER NOT NULL,
          d TEXT NOT NULL,
          t TEXT NOT NULL,
          ct INTEGER,
          u TEXT NOT NULL,
          descr TEXT NOT NULL DEFAULT '',
          image_key TEXT,
          edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1))
        )`,
        `CREATE TABLE IF NOT EXISTS sword_images (
          image_key TEXT PRIMARY KEY,
          content_type TEXT NOT NULL,
          image_data BLOB NOT NULL,
          media_size INTEGER,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS media_chunks (
          image_key TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          chunk_data BLOB NOT NULL,
          PRIMARY KEY (image_key, chunk_index)
        )`,
        `CREATE TABLE IF NOT EXISTS media_variant_sets (
          base_key TEXT PRIMARY KEY,
          media_kind TEXT NOT NULL,
          content_type TEXT NOT NULL,
          low_key TEXT NOT NULL,
          medium_key TEXT NOT NULL,
          original_key TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS admin_config (
          config_key TEXT PRIMARY KEY,
          secret TEXT NOT NULL,
          issuer TEXT NOT NULL,
          account_label TEXT NOT NULL,
          digits INTEGER NOT NULL,
          period INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS rate_limits (
          bucket TEXT NOT NULL,
          limiter_key TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          window_start INTEGER NOT NULL,
          PRIMARY KEY (bucket, limiter_key)
        )`,
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
        "CREATE INDEX IF NOT EXISTS idx_swords_category ON swords (c)",
        "CREATE INDEX IF NOT EXISTS idx_swords_value ON swords (v DESC)",
        "CREATE INDEX IF NOT EXISTS idx_sword_baseline_category ON sword_baseline (c)",
        "CREATE INDEX IF NOT EXISTS idx_sword_images_updated_at ON sword_images (updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_media_variant_sets_updated_at ON media_variant_sets (updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start)",
        "CREATE INDEX IF NOT EXISTS idx_users_role_sort ON users (role_sort DESC, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_public_id ON audit_logs (entity_public_id)"
      ];

      for (const statement of createStatements) {
        await env.DB.prepare(statement).run();
      }

      await ensureColumn(env, "swords", "card_id", "TEXT");
      await ensureColumn(env, "swords", "detail_image_key", "TEXT");
      await ensureColumn(env, "swords", "slash_media_key", "TEXT");
      await ensureColumn(env, "swords", "slash_audio_key", "TEXT");
      await ensureColumn(env, "sword_images", "media_size", "INTEGER");
      await ensureColumn(env, "sword_baseline", "card_id", "TEXT");
      await ensureColumn(env, "sword_baseline", "detail_image_key", "TEXT");
      await ensureColumn(env, "sword_baseline", "slash_media_key", "TEXT");
      await ensureColumn(env, "sword_baseline", "slash_audio_key", "TEXT");

      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_swords_card_id ON swords (card_id)").run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sword_baseline_card_id ON sword_baseline (card_id)").run();

      await backfillCardIds(env);
      await backfillRoleSorts(env);
    })().catch((error) => {
      coreSchemaReadyPromise = null;
      throw error;
    });
  }

  await coreSchemaReadyPromise;
}

async function ensureColumn(env, tableName, columnName, columnSql) {
  const tableInfo = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = (tableInfo.results || []).some((row) => row.name === columnName);
  if (!exists) {
    await env.DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`).run();
  }
}

async function backfillCardIds(env) {
  const { results } = await env.DB.prepare(`
    SELECT s.id, s.card_id, b.card_id AS baseline_card_id
    FROM swords s
    LEFT JOIN sword_baseline b ON b.id = s.id
    WHERE s.card_id IS NULL OR s.card_id = '' OR b.card_id IS NULL OR b.card_id = ''
    ORDER BY s.id ASC
  `).all();

  const rowsToUpdate = [];
  for (const row of results || []) {
    const nextCardId = row.card_id || row.baseline_card_id || await generateUniqueCardId(env);
    rowsToUpdate.push({ id: row.id, nextCardId });
  }

  const statements = rowsToUpdate.flatMap(({ id, nextCardId }) => ([
    env.DB.prepare("UPDATE swords SET card_id = ? WHERE id = ?").bind(nextCardId, id),
    env.DB.prepare("UPDATE sword_baseline SET card_id = ? WHERE id = ?").bind(nextCardId, id)
  ]));
  if (statements.length) {
    await env.DB.batch(statements);
  }
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

function parsePublicSwordQuery(url) {
  const category = url.searchParams.get("category") || "";
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sort = url.searchParams.get("sort") || "value-desc";
  const limit = parseBoundedQueryInteger(url.searchParams.get("limit"), PUBLIC_API_DEFAULT_LIMIT, 1, PUBLIC_API_LIMIT, "limit");
  const offset = parseBoundedQueryInteger(url.searchParams.get("offset"), 0, 0, PUBLIC_API_MAX_OFFSET, "offset");
  if (category && category !== "All" && !CATEGORIES.has(category)) {
    throw new HttpError(400, "Category is invalid.");
  }
  if (search.length > 100) {
    throw new HttpError(400, "Search is too long.");
  }
  if (!["value-desc", "value-asc", "name-asc", "updated-desc"].includes(sort)) {
    throw new HttpError(400, "Sort is invalid.");
  }

  const bindings = [];
  const where = [];
  if (category && category !== "All") {
    where.push("c = ?");
    bindings.push(category);
  }
  if (search) {
    where.push("LOWER(n) LIKE ?");
    bindings.push(`%${search}%`);
  }
  return { bindings, limit, offset, sortSql: getSortSql(sort), where };
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

function getSortSql(sort) {
  switch (sort) {
    case "value-asc":
      return "ORDER BY v ASC, id ASC";
    case "name-asc":
      return "ORDER BY n COLLATE NOCASE ASC, id ASC";
    case "updated-desc":
      return "ORDER BY u DESC, id ASC";
    case "value-desc":
    default:
      return "ORDER BY v DESC, id ASC";
  }
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

function publicApiJson(body, status = 200) {
  return json(body, status, { "cache-control": "public, max-age=60" });
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
  const siteName = env.SITE_NAME || "BBTSL Blade Ball Value List";
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
    `- [Public API](${siteUrl}/api/v1/swords)`,
    `- [Sitemap](${siteUrl}/sitemap.xml)`,
    `- [Full site guide](${siteUrl}/llms-full.txt)`
  ].join("\n");
}

function buildLlmsFullText(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const siteName = env.SITE_NAME || "BBTSL Blade Ball Value List";
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
    `- [Bot API health](${siteUrl}/api/v1/health)`,
    `- [Bot API sword list](${siteUrl}/api/v1/swords)`,
    `- [Bot API team](${siteUrl}/api/v1/team)`,
    `- [Robots](${siteUrl}/robots.txt)`,
    `- [Sitemap](${siteUrl}/sitemap.xml)`,
    `- [LLM summary](${siteUrl}/llms.txt)`,
    "",
    "## Notes",
    "- Public data is readable without authentication.",
    "- Discord OAuth is used for website sign-in.",
    "- Staff actions are permission-gated and audit logged."
  ].join("\n");
}

async function injectDynamicHeadMarkup(html, request, env, nonce) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const pageUrl = `${siteUrl}${getCanonicalPagePath(request)}`;
  const imageUrl = `${siteUrl}/og-image.png`;

  const markup = [
    `<link rel="canonical" href="${pageUrl}">`,
    `<meta property="og:url" content="${pageUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:alt" content="BBTSL Blade Ball Value List preview image">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<meta name="twitter:image:alt" content="BBTSL Blade Ball Value List preview image">`,
    await buildLcpPreloadMarkup(request, env)
  ].join("");

  return addScriptNonces(html.replace('<meta name="bbtsl-dynamic-meta" content="">', markup), nonce);
}

function createCspNonce() {
  return crypto.randomUUID().replace(/-/g, "");
}

function buildContentSecurityPolicy(nonce) {
  return HTML_SECURITY_HEADERS["content-security-policy"].replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}

function addScriptNonces(html, nonce) {
  return html.replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
}

async function buildLcpPreloadMarkup(request, env) {
  if (new URL(request.url).pathname !== "/") {
    return "";
  }
  try {
    const row = await env.DB.prepare(`
      SELECT COALESCE(media_variant_sets.low_key, swords.image_key) AS media_key
      FROM swords
      LEFT JOIN media_variant_sets ON media_variant_sets.base_key = swords.image_key
      WHERE swords.image_key IS NOT NULL AND swords.image_key != ''
      ORDER BY swords.v DESC, swords.id ASC
      LIMIT 1
    `).first();
    if (!row?.media_key) {
      return "";
    }
    return `<link rel="preload" as="image" href="${buildMediaUrl(row.media_key)}" fetchpriority="high">`;
  } catch (error) {
    console.error("Could not build the homepage image preload.", error);
    return "";
  }
}

function getCanonicalPagePath(request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
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
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT request_count, window_start
    FROM rate_limits
    WHERE bucket = ? AND limiter_key = ?
  `).bind(bucket, key).first();

  if (!row) {
    await env.DB.prepare(`
      INSERT INTO rate_limits (bucket, limiter_key, request_count, window_start)
      VALUES (?, ?, 1, ?)
    `).bind(bucket, key, now).run();
    await maybePruneRateLimits(env, now, windowSeconds);
    return;
  }

  const windowStart = Number(row.window_start);
  const requestCount = Number(row.request_count);
  if (now - windowStart >= windowSeconds) {
    await env.DB.prepare(`
      UPDATE rate_limits
      SET request_count = 1, window_start = ?
      WHERE bucket = ? AND limiter_key = ?
    `).bind(now, bucket, key).run();
    await maybePruneRateLimits(env, now, windowSeconds);
    return;
  }

  if (requestCount >= limit) {
    const retryAfter = Math.max(1, windowSeconds - (now - windowStart));
    throw new HttpError(429, "Too many requests. Try again shortly.", { "retry-after": String(retryAfter) });
  }

  await env.DB.prepare(`
    UPDATE rate_limits
    SET request_count = request_count + 1
    WHERE bucket = ? AND limiter_key = ?
  `).bind(bucket, key).run();
}

async function maybePruneRateLimits(env, now, windowSeconds) {
  if (Math.random() > 0.05) {
    return;
  }
  await env.DB.prepare(`
    DELETE FROM rate_limits
    WHERE window_start < ?
  `).bind(now - (windowSeconds * 4)).run();
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

async function hmacHex(secret, value) {
  if (!secret) {
    throw new HttpError(500, "ADMIN_SESSION_SECRET is not configured.");
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

function currentDateString() {
  return new Date().toISOString().slice(0, 10);
}

function currentIsoString() {
  return new Date().toISOString();
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
