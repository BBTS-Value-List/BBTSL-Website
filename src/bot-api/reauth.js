import {
  base64UrlDecodeJson,
  base64UrlEncodeJson,
  hmacHex,
  sha256Hex,
  timingSafeEqual
} from "./crypto.js";

const CHALLENGE_TTL_SECONDS = 10 * 60;

export class ReauthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ReauthError";
    this.status = status;
  }
}

export async function createReauthStateToken(env, fields) {
  const nowSeconds = normalizeNow(fields.nowSeconds);
  const payload = {
    scope: "bbtsl-bot-reauth",
    challengeId: normalizeChallengeId(fields.challengeId),
    actorDiscordId: normalizeDiscordId(fields.actorDiscordId),
    clientId: normalizeClientId(fields.clientId),
    iat: nowSeconds,
    exp: nowSeconds + CHALLENGE_TTL_SECONDS
  };
  const encoded = base64UrlEncodeJson(payload);
  const signature = await hmacHex(requireSecret(env), encoded);
  return `${encoded}.${signature}`;
}

export async function verifyReauthStateToken(env, token, options = {}) {
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra !== undefined) throw new ReauthError(400, "Verification state is invalid.");
  const expected = await hmacHex(requireSecret(env), encoded);
  if (!timingSafeEqual(signature, expected)) throw new ReauthError(400, "Verification state is invalid.");
  let payload;
  try {
    payload = base64UrlDecodeJson(encoded);
  } catch {
    throw new ReauthError(400, "Verification state is invalid.");
  }
  const nowSeconds = normalizeNow(options.nowSeconds);
  if (
    payload?.scope !== "bbtsl-bot-reauth"
    || !Number.isSafeInteger(Number(payload.iat))
    || !Number.isSafeInteger(Number(payload.exp))
    || Number(payload.exp) <= nowSeconds
    || Number(payload.iat) > nowSeconds + 60
  ) {
    throw new ReauthError(400, "Verification state has expired.");
  }
  payload.challengeId = normalizeChallengeId(payload.challengeId);
  payload.actorDiscordId = normalizeDiscordId(payload.actorDiscordId);
  payload.clientId = normalizeClientId(payload.clientId);
  return payload;
}

export function validateVerifiedIdentity(expectedDiscordId, identity) {
  const expected = normalizeDiscordId(expectedDiscordId);
  const actual = normalizeDiscordId(identity?.id);
  if (expected !== actual) throw new ReauthError(403, "The verified Discord account does not match this request.");
  return actual;
}

export async function createReauthChallenge(env, actor, auth, options = {}) {
  const nowSeconds = normalizeNow(options.nowSeconds);
  const challengeId = crypto.randomUUID();
  const state = await createReauthStateToken(env, {
    challengeId,
    actorDiscordId: actor.discordUserId,
    clientId: auth.clientId,
    nowSeconds
  });
  const stateHash = await sha256Hex(state);
  const createdAt = new Date(nowSeconds * 1000).toISOString();
  const expiresAt = new Date((nowSeconds + CHALLENGE_TTL_SECONDS) * 1000).toISOString();
  await cleanupChallenges(env, createdAt);
  await env.DB.prepare(`
    INSERT INTO bot_reauth_challenges (
      id, actor_discord_user_id, client_id, state_hash, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).bind(challengeId, actor.discordUserId, auth.clientId, stateHash, createdAt, expiresAt).run();

  const redirectUri = requireHttpsUrl(env.BOT_REAUTH_REDIRECT_URI, "BOT_REAUTH_REDIRECT_URI");
  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", requireConfigured(env.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID"));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("state", state);
  return { id: challengeId, status: "pending", expiresAt, authorizeUrl: authorizeUrl.toString() };
}

export async function getReauthChallenge(env, id, actor, auth, options = {}) {
  const nowIso = new Date(normalizeNow(options.nowSeconds) * 1000).toISOString();
  const row = await env.DB.prepare(`
    SELECT id, actor_discord_user_id, client_id, status, created_at, expires_at, verified_at, consumed_at
    FROM bot_reauth_challenges WHERE id = ?
  `).bind(normalizeChallengeId(id)).first();
  if (!row || row.actor_discord_user_id !== actor.discordUserId || row.client_id !== auth.clientId) {
    throw new ReauthError(404, "Verification request was not found.");
  }
  if (row.expires_at <= nowIso && row.status !== "consumed") {
    await env.DB.prepare("UPDATE bot_reauth_challenges SET status = 'expired' WHERE id = ? AND status IN ('pending', 'verified')")
      .bind(row.id).run();
    row.status = "expired";
  }
  return serializeChallenge(row);
}

export async function consumeReauthChallenge(env, id, actor, auth, options = {}) {
  const nowIso = new Date(normalizeNow(options.nowSeconds) * 1000).toISOString();
  const result = await env.DB.prepare(`
    UPDATE bot_reauth_challenges
    SET status = 'consumed', consumed_at = ?
    WHERE id = ? AND actor_discord_user_id = ? AND client_id = ?
      AND status = 'verified' AND expires_at > ?
    RETURNING id
  `).bind(nowIso, normalizeChallengeId(id), actor.discordUserId, auth.clientId, nowIso).first();
  if (!result) throw new ReauthError(403, "Fresh Discord verification is required.");
  return true;
}

export async function handleReauthCallback(request, env, options = {}) {
  try {
    const url = new URL(request.url);
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    if (!state || !code) throw new ReauthError(400, "Verification request is incomplete.");
    const claims = await verifyReauthStateToken(env, state, options);
    const stateHash = await sha256Hex(state);
    const row = await env.DB.prepare(`
      SELECT id, actor_discord_user_id, client_id, status, expires_at
      FROM bot_reauth_challenges WHERE id = ? AND state_hash = ?
    `).bind(claims.challengeId, stateHash).first();
    const nowIso = new Date(normalizeNow(options.nowSeconds) * 1000).toISOString();
    if (
      !row
      || row.status !== "pending"
      || row.expires_at <= nowIso
      || row.actor_discord_user_id !== claims.actorDiscordId
      || row.client_id !== claims.clientId
    ) throw new ReauthError(400, "Verification request has expired.");
    const token = await exchangeDiscordCode(env, code, options.fetch || fetch);
    const identity = await fetchDiscordIdentity(token, options.fetch || fetch);
    validateVerifiedIdentity(row.actor_discord_user_id, identity);
    await env.DB.prepare(`
      UPDATE bot_reauth_challenges SET status = 'verified', verified_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(nowIso, row.id).run();
    return htmlResponse("Verification complete", "Return to Discord to continue.", 200);
  } catch (error) {
    const status = error instanceof ReauthError ? error.status : 500;
    const message = status >= 500 ? "Verification could not be completed." : error.message;
    return htmlResponse("Verification failed", message, status);
  }
}

async function exchangeDiscordCode(env, code, fetchImpl) {
  const redirectUri = requireHttpsUrl(env.BOT_REAUTH_REDIRECT_URI, "BOT_REAUTH_REDIRECT_URI");
  const response = await fetchImpl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireConfigured(env.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID"),
      client_secret: requireConfigured(env.DISCORD_CLIENT_SECRET, "DISCORD_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new ReauthError(502, "Discord verification failed.");
  return body.access_token;
}

async function fetchDiscordIdentity(accessToken, fetchImpl) {
  const response = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) throw new ReauthError(502, "Discord verification failed.");
  return body;
}

async function cleanupChallenges(env, nowIso) {
  await env.DB.prepare(`
    DELETE FROM bot_reauth_challenges
    WHERE id IN (
      SELECT id FROM bot_reauth_challenges
      WHERE expires_at <= ? OR status IN ('consumed', 'expired')
      ORDER BY expires_at ASC LIMIT 250
    )
  `).bind(nowIso).run();
}

function serializeChallenge(row) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at || null,
    consumedAt: row.consumed_at || null
  };
}

function htmlResponse(title, message, status) {
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    }
  });
}

function requireSecret(env) {
  return requireConfigured(env.BOT_REAUTH_SECRET, "BOT_REAUTH_SECRET");
}

function requireConfigured(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new ReauthError(500, `${name} is not configured.`);
  return normalized;
}

function requireHttpsUrl(value, name) {
  const normalized = requireConfigured(value, name);
  let url;
  try { url = new URL(normalized); } catch { throw new ReauthError(500, `${name} is invalid.`); }
  if (url.protocol !== "https:") throw new ReauthError(500, `${name} must use HTTPS.`);
  return url.toString();
}

function normalizeNow(value) {
  const number = value === undefined ? Math.floor(Date.now() / 1000) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("Current timestamp is invalid.");
  return number;
}

function normalizeChallengeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new ReauthError(400, "Verification request is invalid.");
  return id;
}

function normalizeDiscordId(value) {
  const id = String(value || "").trim();
  if (!/^\d{8,32}$/.test(id)) throw new ReauthError(400, "Discord user ID is invalid.");
  return id;
}

function normalizeClientId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw new ReauthError(400, "Client ID is invalid.");
  return id;
}
