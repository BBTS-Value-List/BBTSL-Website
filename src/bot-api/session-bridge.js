import { createBotAuditDatabase } from "./audit-database.js";
import { createSession as registerSession, revokeSession as revokeRegisteredSession } from "../security/session-store.js";
import { base64UrlDecodeJson, base64UrlEncodeJson, hmacHex, timingSafeEqual } from "./crypto.js";

const SESSION_TTL_SECONDS = 120;
const STALE_REAUTH_OFFSET_SECONDS = 24 * 60 * 60;
const BOT_HEADERS = [
  "authorization",
  "x-bbtsl-api-client",
  "x-bbtsl-api-date",
  "x-bbtsl-actor-discord-id",
  "x-bbtsl-request-timestamp",
  "x-bbtsl-request-nonce",
  "x-bbtsl-content-sha256",
  "x-bbtsl-request-signature",
  "x-bbtsl-reauth-challenge"
];

export async function createSignedSessionToken(env, actor, options = {}) {
  const nowSeconds = normalizeNow(options.nowSeconds);
  const payload = {
    scope: "session",
    uid: normalizeUserId(actor?.id),
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    reauthAt: options.freshReauth ? nowSeconds : Math.max(1, nowSeconds - STALE_REAUTH_OFFSET_SECONDS),
    mode: "user"
  };
  const encoded = base64UrlEncodeJson(payload);
  const signature = await hmacHex(requireSecret(env), encoded);
  return `${encoded}.${signature}`;
}

export async function readSessionTokenClaims(env, token) {
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra !== undefined) throw new TypeError("Session token is invalid.");
  const expected = await hmacHex(requireSecret(env), encoded);
  if (!timingSafeEqual(signature, expected)) throw new TypeError("Session token signature is invalid.");
  return base64UrlDecodeJson(encoded);
}

export async function delegateAsActor(sourceRequest, env, baseWorker, actor, options = {}) {
  const nowSeconds = normalizeNow(options.nowSeconds);
  const token = await createSignedSessionToken(env, actor, { nowSeconds, freshReauth: Boolean(options.freshReauth) });
  const claims = await readSessionTokenClaims(env, token);
  const createSession = options.createSession || registerSession;
  const revokeSession = options.revokeSession || revokeRegisteredSession;
  await createSession(env, {
    sessionId: token,
    userId: claims.uid,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    reauthAt: new Date(claims.reauthAt * 1000).toISOString(),
    mode: "user"
  });

  try {
    const delegated = await buildDelegatedRequest(sourceRequest, token, actor.id, options.targetPath, options.targetMethod, options.bodyBytes);
    const delegatedEnv = options.auditRequestId
      ? { ...env, DB: createBotAuditDatabase(env.DB, options.auditRequestId) }
      : env;
    return await baseWorker.fetch(delegated, delegatedEnv, options.executionContext || {});
  } finally {
    await revokeSession(env, token, "bot_request_complete", new Date(nowSeconds * 1000).toISOString()).catch(() => {});
  }
}

async function buildDelegatedRequest(sourceRequest, token, actorId, targetPath, targetMethod, signedBodyBytes) {
  const sourceUrl = new URL(sourceRequest.url);
  const targetUrl = new URL(targetPath, sourceUrl.origin);
  const headers = new Headers(sourceRequest.headers);
  for (const header of BOT_HEADERS) headers.delete(header);
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  headers.set("cf-connecting-ip", `user:${normalizeUserId(actorId)}`);
  headers.set("origin", targetUrl.origin);
  headers.set("referer", `${targetUrl.origin}/`);
  headers.set("x-bbts-request", "1");
  headers.set("cookie", `bbtsl_session=${token}`);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const method = String(targetMethod || sourceRequest.method).toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method) && sourceRequest.body;
  const body = hasBody
    ? (signedBodyBytes instanceof Uint8Array ? signedBodyBytes : new Uint8Array(await sourceRequest.clone().arrayBuffer()))
    : undefined;
  return new Request(targetUrl.toString(), { method, headers, body, redirect: "manual" });
}

function requireSecret(env) {
  const value = String(env?.ADMIN_SESSION_SECRET || "");
  if (!value) throw new TypeError("ADMIN_SESSION_SECRET is not configured.");
  return value;
}

function normalizeNow(value) {
  const number = value === undefined ? Math.floor(Date.now() / 1000) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("Session timestamp is invalid.");
  return number;
}

function normalizeUserId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError("Actor user ID is invalid.");
  return number;
}
