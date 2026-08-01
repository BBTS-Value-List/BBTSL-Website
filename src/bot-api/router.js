import { BotApiError, authenticateBotRequest } from "./auth.js";
import { enrichAuditJsonResponse } from "./audit-source.js";
import { hasBotCapability, serializeBotActor } from "./permissions.js";
import {
  ReauthError,
  consumeReauthChallenge,
  createReauthChallenge,
  getReauthChallenge,
  handleReauthCallback
} from "./reauth.js";
import { delegateAsActor } from "./session-bridge.js";

const BOT_PREFIX = "/api/bot/v1";
const SITE_STATE_KEY = "__system/site-state.json";
const SYSTEM_DISCORD_USER_ID = "386438401563557888";
const TEAM_PROFILE_SYNC_LIMIT = 100;
const TEAM_PROFILE_SYNC_ROLES = ["Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"];
const LOGIN_REFRESH_MESSAGE = "To perform this staff action, refresh your website login by signing in on bbtsl.lol again. Staff actions unlock for 7 days after login.";

export function isBotApiRequest(request) {
  return new URL(request.url).pathname.startsWith(`${BOT_PREFIX}/`) || new URL(request.url).pathname === BOT_PREFIX;
}

export async function handleBotApiRequest(request, env, baseWorker, overrides = {}) {
  const dependencies = {
    authenticate: authenticateBotRequest,
    loadActor,
    delegate: delegateAsActor,
    resolveSword,
    resolveTeamUser,
    createReauth: createReauthChallenge,
    getReauth: getReauthChallenge,
    consumeReauth: consumeReauthChallenge,
    callback: handleReauthCallback,
    ...overrides
  };
  const url = new URL(request.url);
  try {
    if (url.pathname === `${BOT_PREFIX}/reauth/callback` && request.method === "GET") {
      return await dependencies.callback(request, env);
    }

    const isTeamSyncRequest = url.pathname === `${BOT_PREFIX}/team/sync` && (request.method === "GET" || request.method === "POST");
    const auth = await dependencies.authenticate(request, env, { allowServiceActor: isTeamSyncRequest });
    const actor = auth.actorDiscordId.startsWith("service:") ? null : await dependencies.loadActor(env, auth.actorDiscordId);
    if (!actor && !isTeamSyncRequest) throw new BotApiError(404, "Team member was not found.");
    const delegate = (options) => dependencies.delegate(request, env, baseWorker, actor, { ...options, auditRequestId: auth.requestId });

    const actorMatch = url.pathname.match(new RegExp(`^${BOT_PREFIX}/actor/(\\d{8,32})$`));
    if (actorMatch && request.method === "GET") {
      if (actorMatch[1] !== auth.actorDiscordId) throw new BotApiError(403, "Actor identity does not match this request.");
      return apiJson({ data: actor, meta: responseMeta(auth) });
    }

    if (url.pathname === `${BOT_PREFIX}/team/sync` && request.method === "GET") {
      return listTeamProfileSyncTargets(env, auth);
    }

    if (url.pathname === `${BOT_PREFIX}/team/sync` && request.method === "POST") {
      return syncTeamProfiles(env, auth);
    }

    assertFreshWebsiteLogin(actor);

    if (url.pathname === `${BOT_PREFIX}/reauth/challenges` && request.method === "POST") {
      requireCapability(actor, "audit:revert");
      const challenge = await dependencies.createReauth(env, actor, auth);
      return apiJson({ data: challenge, meta: responseMeta(auth) }, 201);
    }

    const challengeMatch = url.pathname.match(new RegExp(`^${BOT_PREFIX}/reauth/challenges/([A-Za-z0-9-]{8,80})$`));
    if (challengeMatch && request.method === "GET") {
      requireCapability(actor, "audit:revert");
      const challenge = await dependencies.getReauth(env, challengeMatch[1], actor, auth);
      return apiJson({ data: challenge, meta: responseMeta(auth) });
    }

    if (url.pathname === `${BOT_PREFIX}/swords` && request.method === "POST") {
      requireCapability(actor, "sword:create");
      return delegate({ targetPath: "/api/swords/commit", bodyBytes: auth.bodyBytes });
    }

    const swordMatch = url.pathname.match(new RegExp(`^${BOT_PREFIX}/swords/(.+)$`));
    if (swordMatch) {
      const sword = await dependencies.resolveSword(env, decodePathSegment(swordMatch[1]));
      if (!sword) throw new BotApiError(404, "Sword was not found.");
      if (request.method === "GET") return readBotSword(request, env, baseWorker, sword, actor, auth);
      if (request.method === "PUT") {
        requireCapability(actor, "sword:update");
        return delegate({ targetPath: `/api/swords/commit/${sword.id}`, bodyBytes: auth.bodyBytes });
      }
      if (request.method === "DELETE") {
        requireCapability(actor, "sword:delete");
        return delegate({ targetPath: `/api/swords/${sword.id}`, bodyBytes: auth.bodyBytes });
      }
    }

    if (url.pathname === `${BOT_PREFIX}/media/stage` && request.method === "POST") {
      requireCapability(actor, "media:update");
      return delegate({ targetPath: "/api/media/stage", bodyBytes: auth.bodyBytes });
    }

    if (url.pathname === `${BOT_PREFIX}/export` && request.method === "GET") {
      requireCapability(actor, "data:export");
      return delegate({ targetPath: "/api/export" });
    }

    if (url.pathname === `${BOT_PREFIX}/audit` && request.method === "GET") {
      requireCapability(actor, "audit:view");
      return readBotAudit(url, env, auth);
    }

    if (url.pathname === `${BOT_PREFIX}/audit/revert` && request.method === "POST") {
      requireCapability(actor, "audit:revert");
      const challengeId = String(request.headers.get("x-bbtsl-reauth-challenge") || "").trim();
      await dependencies.consumeReauth(env, challengeId, actor, auth);
      return delegate({ targetPath: "/api/audit/revert", freshReauth: true, bodyBytes: auth.bodyBytes });
    }

    if (url.pathname === `${BOT_PREFIX}/team/manage` && request.method === "GET") {
      requireCapability(actor, "team:manage");
      return delegate({ targetPath: "/api/team" });
    }

    if (url.pathname === `${BOT_PREFIX}/team/users` && request.method === "POST") {
      requireCapability(actor, "team:manage");
      return delegate({ targetPath: "/api/team/users", bodyBytes: auth.bodyBytes });
    }

    const teamUserMatch = url.pathname.match(new RegExp(`^${BOT_PREFIX}/team/users/(\\d{8,32})$`));
    if (teamUserMatch && request.method === "PATCH") {
      requireCapability(actor, "team:manage");
      if (teamUserMatch[1] === SYSTEM_DISCORD_USER_ID) throw new BotApiError(403, "The system account cannot be changed through the bot.");
      const user = await dependencies.resolveTeamUser(env, teamUserMatch[1]);
      if (!user) throw new BotApiError(404, "Team member was not found.");
      return delegate({ targetPath: `/api/team/users/${user.id}`, bodyBytes: auth.bodyBytes });
    }

    return apiJson({ error: "API endpoint not found." }, 404);
  } catch (error) {
    if (error instanceof BotApiError || error instanceof ReauthError) {
      return apiJson({ error: error.message }, error.status, error.headers || {});
    }
    console.error("BBTSL bot API request failed.", error);
    return apiJson({ error: "Internal server error." }, 500);
  }
}

export async function enrichWebsiteAuditResponse(request, response, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/audit" || request.method !== "GET") return response;
  return enrichAuditJsonResponse(response, env);
}

async function loadActor(env, discordUserId) {
  const row = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash, role, status, updated_at, last_login_at
    FROM users WHERE discord_user_id = ?
  `).bind(discordUserId).first();
  return serializeBotActor(row);
}

async function resolveTeamUser(env, discordUserId) {
  return env.DB.prepare("SELECT id, discord_user_id, role, status FROM users WHERE discord_user_id = ?")
    .bind(discordUserId).first();
}

async function resolveSword(env, rawCardId) {
  const cardId = normalizeCardId(rawCardId);
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) throw new BotApiError(503, "Site data is unavailable.");
  let state;
  try { state = JSON.parse(await object.text()); } catch { throw new BotApiError(503, "Site data is unavailable."); }
  const row = (state.swords || []).find((candidate) => String(candidate.card_id || "").toUpperCase() === cardId.toUpperCase());
  return row ? { id: Number(row.id), cardId: row.card_id, revision: Number(row.revision || 1) } : null;
}

async function listTeamProfileSyncTargets(env, auth) {
  const rolePlaceholders = TEAM_PROFILE_SYNC_ROLES.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(`
    SELECT discord_user_id, username, global_name, avatar_hash
    FROM users
    WHERE discord_user_id != ?
      AND status = 'active'
      AND role IN (${rolePlaceholders})
    ORDER BY role_sort DESC, updated_at DESC, id ASC
  `).bind(SYSTEM_DISCORD_USER_ID, ...TEAM_PROFILE_SYNC_ROLES).all();
  return apiJson({
    data: {
      users: (results || []).map((row) => ({
        discordUserId: String(row.discord_user_id || ""),
        username: String(row.username || ""),
        globalName: String(row.global_name || ""),
        avatarHash: String(row.avatar_hash || "")
      }))
    },
    meta: responseMeta(auth)
  });
}

async function syncTeamProfiles(env, auth) {
  const body = parseJsonBytes(auth.bodyBytes);
  if (!Array.isArray(body.users)) throw new BotApiError(400, "Team sync users must be an array.");
  if (body.users.length > TEAM_PROFILE_SYNC_LIMIT) throw new BotApiError(413, "Team sync user batch is too large.");

  const usersByDiscordId = new Map();
  for (const user of body.users) {
    const normalized = normalizeTeamSyncUser(user);
    if (normalized.discordUserId !== SYSTEM_DISCORD_USER_ID) {
      usersByDiscordId.set(normalized.discordUserId, normalized);
    }
  }
  const users = [...usersByDiscordId.values()];
  if (!users.length) {
    return apiJson({ data: { checked: 0, updated: 0, skipped: 0, users: [] }, meta: responseMeta(auth) });
  }

  const userPlaceholders = users.map(() => "?").join(", ");
  const rolePlaceholders = TEAM_PROFILE_SYNC_ROLES.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(`
    SELECT id, discord_user_id, username, global_name, avatar_hash
    FROM users
    WHERE discord_user_id IN (${userPlaceholders})
      AND discord_user_id != ?
      AND status = 'active'
      AND role IN (${rolePlaceholders})
  `).bind(...users.map((user) => user.discordUserId), SYSTEM_DISCORD_USER_ID, ...TEAM_PROFILE_SYNC_ROLES).all();

  const existingByDiscordId = new Map((results || []).map((row) => [String(row.discord_user_id), row]));
  const updatedUsers = [];
  let skipped = 0;
  const now = new Date().toISOString();
  for (const user of users) {
    const existing = existingByDiscordId.get(user.discordUserId);
    if (!existing) {
      skipped += 1;
      continue;
    }
    if (
      String(existing.username || "") === user.username
      && String(existing.global_name || "") === user.globalName
      && String(existing.avatar_hash || "") === user.avatarHash
    ) {
      skipped += 1;
      continue;
    }
    await env.DB.prepare(`
      UPDATE users
      SET username = ?, global_name = ?, avatar_hash = ?, updated_at = ?
      WHERE id = ?
    `).bind(user.username, user.globalName, user.avatarHash, now, existing.id).run();
    updatedUsers.push(user);
  }

  return apiJson({
    data: {
      checked: users.length,
      updated: updatedUsers.length,
      skipped,
      users: updatedUsers
    },
    meta: responseMeta(auth)
  });
}

async function readBotSword(request, env, baseWorker, sword, actor, auth) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`/api/v1/swords/${encodeURIComponent(sword.cardId)}`, sourceUrl.origin);
  const headers = new Headers(request.headers);
  for (const name of [
    "x-bbtsl-actor-discord-id", "x-bbtsl-request-timestamp", "x-bbtsl-request-nonce",
    "x-bbtsl-content-sha256", "x-bbtsl-request-signature", "x-bbtsl-reauth-challenge"
  ]) headers.delete(name);
  const response = await baseWorker.fetch(new Request(targetUrl, { method: "GET", headers }), env, {});
  if (!response.ok) return response;
  const body = await response.json();
  body.data = { ...body.data, internalId: sword.id, revision: sword.revision, allowedOperations: actor.permissions };
  body.meta = { ...(body.meta || {}), requestId: auth.requestId };
  return apiJson(body, response.status);
}

async function readBotAudit(url, env, auth) {
  const filters = [];
  const bindings = [];
  const cardId = sanitizeAuditText(url.searchParams.get("cardId"), 16);
  if (cardId) {
    filters.push("audit_logs.entity_public_id = ?");
    bindings.push(cardId);
  }
  const actionType = sanitizeAuditText(url.searchParams.get("actionType"), 80);
  if (actionType) {
    filters.push("audit_logs.action_type = ?");
    bindings.push(actionType);
  }
  const search = sanitizeAuditText(url.searchParams.get("search"), 120);
  if (search) {
    filters.push("(audit_logs.summary LIKE ? OR audit_logs.diff_json LIKE ?)");
    bindings.push(`%${search}%`, `%${search}%`);
  }
  const limit = clampAuditLimit(url.searchParams.get("limit"));
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
    LIMIT ?
  `;
  const { results } = await env.DB.prepare(sql).bind(...bindings, limit).all();
  const logs = (results || []).map(serializeAuditLog);
  const sourceMap = await loadAuditSourceMap(env, logs.map((log) => log.id));
  const requestedSource = sanitizeAuditText(url.searchParams.get("source"), 32);
  const enriched = logs.map((log) => {
    const source = sourceMap.get(Number(log.id));
    return { ...log, source: source?.source || "website", sourceRequestId: source?.source_request_id || null };
  });
  const filtered = requestedSource
    ? enriched.filter((log) => log.source === requestedSource)
    : enriched;
  return apiJson({ logs: filtered, meta: responseMeta(auth) });
}

async function loadAuditSourceMap(env, auditLogIds) {
  const ids = [...new Set((auditLogIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  try {
    const { results } = await env.DB.prepare(`
      SELECT audit_log_id, source, source_request_id
      FROM audit_sources
      WHERE audit_log_id IN (${placeholders})
    `).bind(...ids).all();
    return new Map((results || []).map((row) => [Number(row.audit_log_id), row]));
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/audit_sources|no such table|no such column/i.test(message)) return new Map();
    throw error;
  }
}

function serializeAuditLog(row) {
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    actorRole: row.actor_role || "",
    actionType: row.action_type || "",
    entityType: row.entity_type || "",
    entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    entityPublicId: row.entity_public_id || "",
    summary: row.summary || "",
    diff: parseAuditJson(row.diff_json),
    before: parseAuditJson(row.before_json),
    after: parseAuditJson(row.after_json),
    createdAt: row.created_at || "",
    actor: {
      username: row.actor_username || "",
      globalName: row.actor_global_name || "",
      displayName: row.actor_global_name || row.actor_username || row.actor_role || "Unknown"
    }
  };
}

function parseAuditJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeAuditText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function parseJsonBytes(bytes) {
  try {
    const text = new TextDecoder().decode(bytes || new Uint8Array());
    return text ? JSON.parse(text) : {};
  } catch {
    throw new BotApiError(400, "Request body must be valid JSON.");
  }
}

function normalizeTeamSyncUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new BotApiError(400, "Team sync user is invalid.");
  return {
    discordUserId: requireDiscordId(user.discordUserId),
    username: sanitizeTeamProfileText(user.username, 100),
    globalName: sanitizeTeamProfileText(user.globalName, 100),
    avatarHash: sanitizeTeamProfileText(user.avatarHash, 128)
  };
}

function requireDiscordId(value) {
  const id = String(value || "").trim();
  if (!/^\d{8,32}$/.test(id)) throw new BotApiError(400, "Discord user ID is invalid.");
  return id;
}

function sanitizeTeamProfileText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function clampAuditLimit(value) {
  const number = Number(value || 10);
  if (!Number.isSafeInteger(number) || number < 1) return 10;
  return Math.min(number, 25);
}

function requireCapability(actor, capability) {
  if (!hasBotCapability(actor.role, capability)) throw new BotApiError(403, "You do not have permission to perform this action.");
}

function assertFreshWebsiteLogin(actor) {
  if (actor?.staffLoginFresh !== true) {
    throw new BotApiError(403, LOGIN_REFRESH_MESSAGE);
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BotApiError(400, "Card ID is invalid.");
  }
}

function normalizeCardId(value) {
  const raw = String(value || "").trim();
  const cardId = raw.startsWith("#") ? raw : `#${raw}`;
  if (!/^#[A-Za-z0-9]{6}$/.test(cardId)) throw new BotApiError(400, "Card ID is invalid.");
  return cardId;
}

function responseMeta(auth) {
  return { version: "bot-v1", generatedAt: new Date().toISOString(), clientId: auth.clientId, requestId: auth.requestId };
}

function apiJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}
