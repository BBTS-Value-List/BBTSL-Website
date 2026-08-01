import { consumeAtomicRateLimit } from "../security/rate-limit.js";
import {
  buildCanonicalRequest,
  canonicalizeSignedHeaders,
  deriveDailyKey,
  deriveSigningKey,
  hmacHex,
  sha256Hex,
  timingSafeEqual
} from "./crypto.js";

const DEFAULT_CLIENT_ID = "bbtsl-discord-bot";
const JSON_BODY_LIMIT = 256 * 1024;
const MEDIA_BODY_LIMIT = 25 * 1024 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const NONCE_TTL_SECONDS = 5 * 60;

export class BotApiError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "BotApiError";
    this.status = status;
    this.headers = headers;
  }
}

export async function authenticateBotRequest(request, env, options = {}) {
  const nowSeconds = normalizeNowSeconds(options.nowSeconds);
  const clientId = requireClientId(request, env);
  const date = requireCurrentDate(request, nowSeconds);
  const secret = getClientSecret(env, clientId);
  await verifyBearer(request, secret, clientId, date);

  const actorDiscordId = requireActorDiscordId(request.headers.get("x-bbtsl-actor-discord-id"), clientId, options.allowServiceActor);
  const timestamp = requireTimestamp(request.headers.get("x-bbtsl-request-timestamp"), nowSeconds);
  const nonce = requireNonce(request.headers.get("x-bbtsl-request-nonce"));
  const rateLimiter = options.consumeRateLimit || defaultConsumeRateLimit;
  await enforceRateLimit(rateLimiter, env, request, clientId, actorDiscordId, nowSeconds);

  const bodyLimit = Number(options.maxBodyBytes ?? getBodyLimit(request));
  const bodyBytes = await readBoundedRequestBody(request.clone(), bodyLimit);
  const bodyHash = await sha256Hex(bodyBytes);
  const providedBodyHash = String(request.headers.get("x-bbtsl-content-sha256") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedBodyHash) || !timingSafeEqual(providedBodyHash, bodyHash)) {
    throw new BotApiError(401, "Request body digest is invalid.");
  }

  const headerHash = await sha256Hex(canonicalizeSignedHeaders(request.headers));
  const canonical = buildCanonicalRequest({
    clientId,
    date,
    method: request.method,
    path: new URL(request.url),
    actorDiscordId,
    timestamp,
    nonce,
    headerHash,
    bodyHash
  });
  const signingKey = await deriveSigningKey(secret, clientId, date);
  const expectedSignature = await hmacHex(signingKey, canonical);
  const providedSignature = String(request.headers.get("x-bbtsl-request-signature") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedSignature) || !timingSafeEqual(providedSignature, expectedSignature)) {
    throw new BotApiError(401, "Request signature is invalid.");
  }

  const consumeNonce = options.consumeNonce || defaultConsumeNonce;
  await consumeNonce({
    env,
    clientId,
    nonce,
    actorDiscordId,
    createdAt: new Date(nowSeconds * 1000).toISOString(),
    expiresAt: new Date((nowSeconds + NONCE_TTL_SECONDS) * 1000).toISOString()
  });

  const requestId = `botreq:${await sha256Hex(`${clientId}:${nonce}`)}`;
  return {
    actorDiscordId,
    bodyBytes,
    bodyHash,
    clientId,
    date,
    nonce,
    requestId,
    timestamp
  };
}

async function verifyBearer(request, secret, clientId, date) {
  const authorization = String(request.headers.get("authorization") || "").trim();
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
  const expected = await deriveDailyKey(secret, clientId, date);
  if (!timingSafeEqual(token, expected)) {
    throw new BotApiError(401, "Private API credential is invalid.", {
      "www-authenticate": 'Bearer realm="bbtsl-bot-v1"'
    });
  }
}

function requireClientId(request, env) {
  const clientId = String(request.headers.get("x-bbtsl-api-client") || "").trim();
  const expected = String(env.BBTSL_BOT_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(clientId) || clientId !== expected) {
    throw new BotApiError(403, "Private API client is not authorized.");
  }
  return clientId;
}

function requireCurrentDate(request, nowSeconds) {
  const date = String(request.headers.get("x-bbtsl-api-date") || "").trim();
  const current = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
  if (date !== current) throw new BotApiError(401, "Private API credential date is invalid.");
  return date;
}

function getClientSecret(env, clientId) {
  let parsed;
  try {
    parsed = JSON.parse(String(env.V1_API_CLIENT_SECRETS || ""));
  } catch {
    throw new BotApiError(500, "Private API secrets are not configured correctly.");
  }
  const secret = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? String(parsed[clientId] || "").trim()
    : "";
  if (!secret) throw new BotApiError(403, "Private API client is not authorized.");
  return secret;
}

function requireActorDiscordId(value, clientId, allowServiceActor = false) {
  const id = String(value || "").trim();
  if (!id && allowServiceActor) return `service:${clientId}`;
  if (!/^\d{8,32}$/.test(id)) throw new BotApiError(400, "Discord user ID is invalid.");
  return id;
}

function requireTimestamp(value, nowSeconds) {
  const raw = String(value || "").trim();
  if (!/^\d{10}$/.test(raw)) throw new BotApiError(401, "Request timestamp is invalid.");
  const timestamp = Number(raw);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > CLOCK_SKEW_SECONDS) {
    throw new BotApiError(401, "Request signature has expired.");
  }
  return String(timestamp);
}

function requireNonce(value) {
  const nonce = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(nonce)) throw new BotApiError(400, "Request nonce is invalid.");
  return nonce;
}

function normalizeNowSeconds(value) {
  const number = value === undefined ? Math.floor(Date.now() / 1000) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("Current timestamp is invalid.");
  return number;
}

function getBodyLimit(request) {
  return new URL(request.url).pathname === "/api/bot/v1/media/stage" ? MEDIA_BODY_LIMIT : JSON_BODY_LIMIT;
}

async function readBoundedRequestBody(request, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Request body limit is invalid.");
  const contentLength = String(request.headers.get("content-length") || "").trim();
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximum) {
    throw new BotApiError(413, "Request body is too large.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > maximum) {
      reader.cancel().catch(() => {});
      throw new BotApiError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function defaultConsumeRateLimit(env, bucket, key, limit, windowSeconds, nowSeconds) {
  return consumeAtomicRateLimit(env.DB, bucket, key, limit, windowSeconds, nowSeconds);
}

async function enforceRateLimit(rateLimiter, env, request, clientId, actorDiscordId, nowSeconds) {
  const client = await rateLimiter(env, "bot_api_client", clientId, 300, 60, nowSeconds);
  if (!client.allowed) throwRateLimit("Too many bot API requests.", client);
  const actor = await rateLimiter(env, "bot_api_actor", actorDiscordId, 120, 60, nowSeconds);
  if (!actor.allowed) throwRateLimit("Too many requests for this team member.", actor);
  const operation = getOperationRateLimit(request);
  if (!operation) return;
  if (operation.clientLimit) {
    const clientOperation = await rateLimiter(
      env,
      `${operation.bucket}_client`,
      `${clientId}:${operation.key}`,
      operation.clientLimit,
      operation.windowSeconds,
      nowSeconds
    );
    if (!clientOperation.allowed) throwRateLimit(operation.message, clientOperation);
  }
  const result = await rateLimiter(
    env,
    operation.bucket,
    `${actorDiscordId}:${operation.key}`,
    operation.limit,
    operation.windowSeconds,
    nowSeconds
  );
  if (!result.allowed) throwRateLimit(operation.message, result);
}

function getOperationRateLimit(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;
  if (method === "POST" && pathname === "/api/bot/v1/media/stage") {
    return { bucket: "bot_api_media", key: "stage", limit: 10, clientLimit: 30, windowSeconds: 600, message: "Too many media upload requests." };
  }
  if (method === "POST" && pathname === "/api/bot/v1/reauth/challenges") {
    return { bucket: "bot_api_reauth", key: "challenge", limit: 5, clientLimit: 20, windowSeconds: 600, message: "Too many verification requests." };
  }
  if (method === "POST" && pathname === "/api/bot/v1/audit/revert") {
    return { bucket: "bot_api_revert", key: "revert", limit: 5, clientLimit: 20, windowSeconds: 600, message: "Too many revert requests." };
  }
  if ((method === "GET" || method === "POST") && pathname === "/api/bot/v1/team/sync") {
    return { bucket: "bot_api_team_sync", key: "team", limit: 6, clientLimit: 20, windowSeconds: 3600, message: "Too many team sync requests." };
  }
  if (method === "GET" && pathname === "/api/bot/v1/export") {
    return { bucket: "bot_api_export", key: "export", limit: 6, clientLimit: 30, windowSeconds: 60, message: "Too many export requests." };
  }
  if (/^\/api\/bot\/v1\/team\/users(?:\/|$)/.test(pathname) && (method === "POST" || method === "PATCH")) {
    return { bucket: "bot_api_team_change", key: "team", limit: 10, clientLimit: 30, windowSeconds: 600, message: "Too many team changes." };
  }
  if (
    (method === "POST" && pathname === "/api/bot/v1/swords")
    || ((method === "PUT" || method === "DELETE") && pathname.startsWith("/api/bot/v1/swords/"))
  ) {
    return { bucket: "bot_api_mutation", key: "swords", limit: 10, clientLimit: 60, windowSeconds: 300, message: "Too many item changes." };
  }
  if (method === "GET" && pathname === "/api/bot/v1/audit") {
    return { bucket: "bot_api_audit_read", key: "audit", limit: 30, clientLimit: 180, windowSeconds: 60, message: "Too many audit requests." };
  }
  return null;
}

function throwRateLimit(message, result) {
  throw new BotApiError(429, message, { "retry-after": String(Math.max(1, Number(result?.retryAfter || 1))) });
}

async function defaultConsumeNonce(record) {
  const { env, clientId, nonce, actorDiscordId, createdAt, expiresAt } = record;
  const cleanupSelector = Number.parseInt((await sha256Hex(`${clientId}:${nonce}`)).slice(0, 2), 16);
  if (cleanupSelector < 16) {
    await env.DB.prepare(`
      DELETE FROM bot_request_nonces
      WHERE rowid IN (
        SELECT rowid FROM bot_request_nonces WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 500
      )
    `).bind(createdAt).run();
  }
  try {
    await env.DB.prepare(`
      INSERT INTO bot_request_nonces (client_id, nonce, actor_discord_user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(clientId, nonce, actorDiscordId, createdAt, expiresAt).run();
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String(error?.message || ""))) {
      throw new BotApiError(409, "Request has already been used.");
    }
    throw error;
  }
}
