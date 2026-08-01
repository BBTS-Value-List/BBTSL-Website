import { authenticateBotRequest, BotApiError } from "../bot-api/auth.js";
import { consumeAtomicRateLimit } from "../security/rate-limit.js";

const SESSION_COOKIE = "bbtsl_session";
const APP_REQUEST_HEADER = "x-bbts-request";
const SITE_STATE_KEY = "__system/site-state.json";
const FAVORITES_PREFIX = "/api/favorites";
const BOT_FAVORITES_PREFIX = "/api/bot/v1/favorites";
const RATE_BUCKET_SECOND = "favorites_mutation_second";
const RATE_BUCKET_FIVE_SECONDS = "favorites_mutation_five_seconds";
const RATE_BUCKET_MINUTE = "favorites_mutation_minute";
const FAVORITE_REALTIME_INTERVAL_MS = 3_000;
const RATE_LIMITS = [
  { bucket: RATE_BUCKET_SECOND, limit: 4, windowSeconds: 1, cooldown: false },
  { bucket: RATE_BUCKET_FIVE_SECONDS, limit: 10, windowSeconds: 5, cooldown: false },
  { bucket: RATE_BUCKET_MINUTE, limit: 40, windowSeconds: 60, cooldown: true }
];
const COOLDOWN_SECONDS = 3 * 60;

export class FavoritesError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "FavoritesError";
    this.status = status;
    this.headers = headers;
  }
}

export function isFavoritesApiRequest(request) {
  const pathname = new URL(request.url).pathname;
  return pathname === FAVORITES_PREFIX || pathname.startsWith(`${FAVORITES_PREFIX}/`);
}

export function isBotFavoritesApiRequest(request) {
  const pathname = new URL(request.url).pathname;
  return pathname === BOT_FAVORITES_PREFIX || pathname.startsWith(`${BOT_FAVORITES_PREFIX}/`);
}

export async function handleFavoritesApiRequest(request, env) {
  try {
    const actor = await getSessionFavoriteActor(request, env);
    return await handleFavoriteOperation(request, env, actor.discordUserId, FAVORITES_PREFIX);
  } catch (error) {
    return favoriteErrorResponse(error);
  }
}

export async function handleBotFavoritesApiRequest(request, env) {
  try {
    const auth = await authenticateBotRequest(request, env, { maxBodyBytes: 0 });
    const targetDiscordId = parseBotFavoriteDiscordId(new URL(request.url).pathname);
    if (auth.actorDiscordId !== targetDiscordId) {
      throw new FavoritesError(403, "Favorite owner does not match the signed actor.");
    }
    return await handleFavoriteOperation(request, env, targetDiscordId, `${BOT_FAVORITES_PREFIX}/${targetDiscordId}`);
  } catch (error) {
    return favoriteErrorResponse(error);
  }
}

export async function maybeInjectFavoritesIntoApiResponse(request, response, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" || !["/api/swords", "/api/auth/status"].includes(url.pathname)) {
    return response;
  }
  if (!String(response.headers.get("content-type") || "").includes("application/json")) {
    return response;
  }
  const actor = await getOptionalSessionFavoriteActor(request, env);
  if (!actor) return response;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!body?.auth?.authenticated) return response;
  body.auth = { ...body.auth, favorites: await listFavoriteCardIds(env, actor.discordUserId) };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

export async function maybeServeFavoritesAwareAppScript(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname !== "/app.js" && url.pathname !== "/app.min.js") return null;
  const assetRequest = url.pathname === "/app.min.js"
    ? new Request(new URL("/app.js", request.url).toString(), { method: request.method, headers: request.headers })
    : request;
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  if (!assetResponse.ok || request.method === "HEAD") return assetResponse;
  const source = await assetResponse.text();
  const patched = patchAppScript(source);
  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "application/javascript; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.delete("content-length");
  return new Response(patched, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
}

export function patchAppScript(source) {
  let next = String(source || "");
  if (!/async function refreshFavoriteCardIds\(/.test(next)) {
    next = replaceRequired(next, /function loadFavoriteCardIds\(\) \{[\s\S]*?\n\}\n\nfunction saveFavoriteCardIds\(\) \{[\s\S]*?\n\}\n\nfunction getPendingFavoriteReturnCardId/, `${favoritesLoadReplacement()}\n\nfunction getPendingFavoriteReturnCardId`, "favorite storage block");
  }
  if (!/async function setFavoriteCardState\(cardId, isFavorite\)/.test(next)) {
    next = replaceRequired(next, /function setFavoriteCardState\(cardId, isFavorite\) \{[\s\S]*?\n\}\n\nfunction syncFavoriteButton/, `${favoriteSetReplacement()}\n\nfunction syncFavoriteButton`, "favorite mutation block");
  }
  if (!/async function toggleActiveFavorite\(\)/.test(next)) {
    next = replaceRequired(next, /function toggleActiveFavorite\(\) \{[\s\S]*?\n\}\n\nfunction handlePostLoginFavoriteReturn/, `${favoriteToggleReplacement()}\n\nfunction handlePostLoginFavoriteReturn`, "favorite toggle block");
  }
  next = replaceOptional(next, /dom\.sortSelect\.addEventListener\("change", \(event\) => \{\n\s*state\.sortMode = event\.target\.value;\n\s*refreshSwords\(\);\n\s*\}\);/, favoriteSortReplacement());
  if (!/function installFavoriteRuntimeCss\(\)/.test(next)) {
    next = replaceRequired(next, /\ninitialize\(\)\.catch/, `\n${favoriteRuntimeCssReplacement()}\n\n${favoriteRealtimeReplacement()}\n\ninstallFavoriteRuntimeCss();\ninstallFavoriteRealtimeSync();\ninitialize().catch`, "favorite runtime hooks");
  }
  return next;
}

export async function cleanupFavoriteState(env) {
  const now = new Date().toISOString();
  await Promise.all([
    env.DB.prepare("DELETE FROM favorite_rate_cooldowns WHERE cooldown_until <= ?").bind(now).run(),
    env.DB.prepare("DELETE FROM request_rate_limits_v2 WHERE bucket IN (?, ?, ?) AND expires_at <= ?").bind(RATE_BUCKET_SECOND, RATE_BUCKET_FIVE_SECONDS, RATE_BUCKET_MINUTE, Math.floor(Date.now() / 1000)).run(),
    pruneDeletedFavoriteRows(env)
  ]);
}

async function handleFavoriteOperation(request, env, discordUserId, prefix) {
  const url = new URL(request.url);
  if (url.pathname === prefix && request.method === "GET") {
    return json({ favorites: await listFavoriteCardIds(env, discordUserId) });
  }
  if (url.pathname === prefix) return methodNotAllowed(["GET"]);
  const cardId = decodeFavoriteCardId(url.pathname.slice(prefix.length + 1));
  if (request.method === "PUT") {
    enforceTrustedMutationRequest(request, url);
    await enforceFavoriteMutationRateLimit(env, discordUserId);
    await assertFavoriteCardExists(env, cardId);
    await env.DB.prepare(`
      INSERT INTO user_favorites (discord_user_id, card_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(discord_user_id, card_id) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(discordUserId, cardId, new Date().toISOString(), new Date().toISOString()).run();
    return json({ ok: true, cardId, favorites: await listFavoriteCardIds(env, discordUserId) });
  }
  if (request.method === "DELETE") {
    enforceTrustedMutationRequest(request, url);
    await enforceFavoriteMutationRateLimit(env, discordUserId);
    await env.DB.prepare("DELETE FROM user_favorites WHERE discord_user_id = ? AND card_id = ?").bind(discordUserId, cardId).run();
    return json({ ok: true, cardId, favorites: await listFavoriteCardIds(env, discordUserId) });
  }
  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

async function getSessionFavoriteActor(request, env) {
  const actor = await getOptionalSessionFavoriteActor(request, env);
  if (!actor) throw new FavoritesError(401, "Sign in with Discord to manage favorites.");
  return actor;
}

async function getOptionalSessionFavoriteActor(request, env) {
  const session = await readSession(request, env);
  if (!session) return null;
  const row = await env.DB.prepare("SELECT id, discord_user_id, status FROM users WHERE id = ?").bind(session.userId).first();
  if (!row || row.status === "disabled" || !row.discord_user_id) return null;
  return { userId: Number(row.id), discordUserId: String(row.discord_user_id) };
}

async function readSession(request, env) {
  const raw = parseCookies(request.headers.get("cookie") || "")[SESSION_COOKIE];
  if (!raw) return null;
  const payload = await verifySignedToken(env, raw, "session");
  if (!payload || typeof payload.uid !== "number") return null;
  return { userId: payload.uid };
}

async function verifySignedToken(env, token, expectedScope) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payloadBase64, signature] = parts;
  const expected = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  if (!timingSafeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadBase64));
  } catch {
    return null;
  }
  if (!payload || payload.scope !== expectedScope || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function listFavoriteCardIds(env, discordUserId) {
  const { results } = await env.DB.prepare(`
    SELECT card_id
    FROM user_favorites
    WHERE discord_user_id = ?
    ORDER BY updated_at DESC, card_id ASC
  `).bind(discordUserId).all();
  return reconcileFavoriteRows(env, discordUserId, results || []);
}

async function reconcileFavoriteRows(env, discordUserId, rows) {
  const liveCardIds = await loadLiveCardIdSet(env);
  const seen = new Set();
  const valid = [];
  const invalidRawValues = [];

  for (const row of rows || []) {
    const raw = String(row?.card_id || "").trim();
    let normalized;
    try {
      normalized = normalizeFavoriteCardId(raw);
    } catch {
      if (raw) invalidRawValues.push(raw);
      continue;
    }
    if (!liveCardIds.has(normalized)) {
      invalidRawValues.push(raw || normalized);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      valid.push(normalized);
    }
  }

  if (invalidRawValues.length) {
    await deleteFavoriteRows(env, discordUserId, invalidRawValues);
  }
  return valid;
}

async function loadLiveCardIdSet(env) {
  const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
  if (!object) throw new FavoritesError(500, "Could not read item data.");
  let state;
  try {
    state = JSON.parse(await object.text());
  } catch {
    throw new FavoritesError(500, "Could not read item data.");
  }
  const live = new Set();
  for (const row of state.swords || []) {
    try {
      live.add(normalizeFavoriteCardId(row.card_id));
    } catch {
    }
  }
  return live;
}

async function deleteFavoriteRows(env, discordUserId, cardIds) {
  const unique = [...new Set(cardIds.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) return;
  await env.DB.batch(unique.map((cardId) => (
    env.DB.prepare("DELETE FROM user_favorites WHERE discord_user_id = ? AND card_id = ?").bind(discordUserId, cardId)
  )));
}

async function pruneDeletedFavoriteRows(env) {
  const liveCardIds = await loadLiveCardIdSet(env);
  const { results } = await env.DB.prepare("SELECT discord_user_id, card_id FROM user_favorites").all();
  const deletions = [];
  for (const row of results || []) {
    let normalized;
    try {
      normalized = normalizeFavoriteCardId(row.card_id);
    } catch {
      normalized = "";
    }
    if (!normalized || !liveCardIds.has(normalized)) {
      deletions.push(env.DB.prepare("DELETE FROM user_favorites WHERE discord_user_id = ? AND card_id = ?").bind(row.discord_user_id, row.card_id));
    }
  }
  if (deletions.length) {
    await env.DB.batch(deletions);
  }
}

async function enforceFavoriteMutationRateLimit(env, discordUserId) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowSeconds * 1000).toISOString();
  const cooldown = await env.DB.prepare("SELECT cooldown_until FROM favorite_rate_cooldowns WHERE discord_user_id = ?").bind(discordUserId).first();
  if (cooldown?.cooldown_until && String(cooldown.cooldown_until) > nowIso) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(cooldown.cooldown_until) - Date.now()) / 1000));
    throw new FavoritesError(429, "Favorite limit reached. Try again later.", { "retry-after": String(retryAfter) });
  }
  for (const limit of RATE_LIMITS) {
    const result = await consumeAtomicRateLimit(env.DB, limit.bucket, discordUserId, limit.limit, limit.windowSeconds, nowSeconds);
    if (result.allowed) continue;
    if (limit.cooldown) {
      const cooldownUntil = new Date((nowSeconds + COOLDOWN_SECONDS) * 1000).toISOString();
      await env.DB.prepare(`
        INSERT INTO favorite_rate_cooldowns (discord_user_id, cooldown_until, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(discord_user_id) DO UPDATE SET cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at
      `).bind(discordUserId, cooldownUntil, nowIso, nowIso).run();
      throw new FavoritesError(429, "Favorite limit reached. Try again later.", { "retry-after": String(COOLDOWN_SECONDS) });
    }
    throw new FavoritesError(429, "Too many favorite changes. Try again shortly.", { "retry-after": String(result.retryAfter) });
  }
}

async function assertFavoriteCardExists(env, cardId) {
  const liveCardIds = await loadLiveCardIdSet(env);
  if (!liveCardIds.has(cardId)) throw new FavoritesError(404, "Item not found.");
}

function enforceTrustedMutationRequest(request, url) {
  if (url.pathname.startsWith(BOT_FAVORITES_PREFIX)) return;
  if (request.headers.get(APP_REQUEST_HEADER) !== "1") throw new FavoritesError(403, "Invalid application request.");
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new FavoritesError(403, "Cross-origin requests are not allowed.");
  const referer = request.headers.get("referer");
  if (!origin && referer) {
    let parsed;
    try {
      parsed = new URL(referer);
    } catch {
      throw new FavoritesError(403, "Invalid same-origin context.");
    }
    if (parsed.origin !== url.origin) throw new FavoritesError(403, "Cross-origin requests are not allowed.");
  }
  if (!origin && !referer) throw new FavoritesError(403, "Missing same-origin context.");
}

function parseBotFavoriteDiscordId(pathname) {
  const match = pathname.match(/^\/api\/bot\/v1\/favorites\/(\d{8,32})(?:\/|$)/);
  if (!match) throw new FavoritesError(404, "Not found.");
  return match[1];
}

function decodeFavoriteCardId(value) {
  try {
    return normalizeFavoriteCardId(decodeURIComponent(String(value || "")));
  } catch {
    throw new FavoritesError(400, "Card ID is invalid.");
  }
}

function normalizeFavoriteCardId(value) {
  const trimmed = String(value || "").trim().toUpperCase();
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!/^#[A-Z0-9]{6}$/.test(normalized)) throw new FavoritesError(400, "Card ID is invalid.");
  return normalized;
}

function favoriteErrorResponse(error) {
  if (error instanceof FavoritesError || error instanceof BotApiError) {
    return json({ error: error.message }, error.status, error.headers);
  }
  console.error(error);
  return json({ error: "Internal server error." }, 500);
}

function methodNotAllowed(methods) {
  return json({ error: "Method not allowed." }, 405, { allow: methods.join(", ") });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function replaceRequired(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Could not patch ${label}.`);
  return next;
}

function replaceOptional(source, pattern, replacement) {
  return source.replace(pattern, replacement);
}

function favoritesLoadReplacement() {
  return `function normalizeFavoriteIdSet(values) {
  const liveCardIds = new Set(state.swords.map((sword) => normalizeCardIdValue(sword.cardId)).filter(Boolean));
  return new Set((Array.isArray(values) ? values : []).map((value) => normalizeCardIdValue(value)).filter((cardId) => cardId && liveCardIds.has(cardId)));
}

function loadFavoriteCardIds() {
  state.favoriteCardIds = normalizeFavoriteIdSet(state.auth?.favorites);
}

async function refreshFavoriteCardIds({ render = false } = {}) {
  if (!state.auth?.authenticated) {
    state.favoriteCardIds = new Set();
    syncFavoriteIndicators();
    if (render) renderGrid();
    return;
  }
  const before = [...state.favoriteCardIds].sort().join("|");
  try {
    const body = await api("/favorites");
    state.favoriteCardIds = normalizeFavoriteIdSet(body.favorites);
  } catch (error) {
    console.error("Could not refresh favorites.", error);
  }
  const after = [...state.favoriteCardIds].sort().join("|");
  syncFavoriteIndicators();
  if (render || before !== after && state.sortMode === "favorites-only") {
    renderGrid();
  }
}

function saveFavoriteCardIds() {}`;
}

function favoriteSetReplacement() {
  return `async function setFavoriteCardState(cardId, isFavorite) {
  const normalizedCardId = normalizeCardIdValue(cardId);
  if (!normalizedCardId) {
    return;
  }
  const previousFavorites = new Set(state.favoriteCardIds);
  if (isFavorite) {
    state.favoriteCardIds.add(normalizedCardId);
  } else {
    state.favoriteCardIds.delete(normalizedCardId);
  }
  syncFavoriteIndicators();
  try {
    const body = await api(\`/favorites/\${encodeURIComponent(normalizedCardId)}\`, { method: isFavorite ? "PUT" : "DELETE" });
    state.favoriteCardIds = normalizeFavoriteIdSet(body.favorites);
  } catch (error) {
    state.favoriteCardIds = previousFavorites;
    const wait = Math.max(1, Number(error.retryAfter || 0));
    const message = error.status === 429 ? \`Favorite limit reached. Try again in \${wait} seconds.\` : "Could not update favorite.";
    window.alert(message);
  }
  syncFavoriteIndicators();
}`;
}

function favoriteToggleReplacement() {
  return `async function toggleActiveFavorite() {
  const sword = findSword(state.activeSwordId);
  if (!sword?.cardId) {
    return;
  }
  if (!state.auth?.authenticated) {
    setPendingFavoriteReturnCardId(sword.cardId);
    openFavoriteLoginModal();
    return;
  }
  await setFavoriteCardState(sword.cardId, !isFavoriteSword(sword));
  renderGrid();
  fillDetailPanel(findSword(state.activeSwordId));
}`;
}

function favoriteSortReplacement() {
  return `dom.sortSelect.addEventListener("change", async (event) => {
    state.sortMode = event.target.value;
    if (state.sortMode === "favorites-only") {
      await refreshFavoriteCardIds({ render: true });
      return;
    }
    refreshSwords();
  });`;
}

function favoriteRuntimeCssReplacement() {
  return `function installFavoriteRuntimeCss() {
  if (document.getElementById("bbtsl-favorite-runtime-css")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "bbtsl-favorite-runtime-css";
  style.textContent = ".grid:empty{min-height:0;margin-top:8px;padding-top:0}.empty{padding-top:22px;padding-bottom:38px}";
  document.head.appendChild(style);
}`;
}

function favoriteRealtimeReplacement() {
  return `function installFavoriteRealtimeSync() {
  if (window.__bbtslFavoriteRealtimeSyncInstalled) {
    return;
  }
  window.__bbtslFavoriteRealtimeSyncInstalled = true;
  const sync = () => {
    if (!state.auth?.authenticated || document.hidden) {
      return;
    }
    refreshFavoriteCardIds({ render: state.sortMode === "favorites-only" }).catch((error) => {
      console.error("Could not sync favorites.", error);
    });
  };
  window.setInterval(sync, ${FAVORITE_REALTIME_INTERVAL_MS});
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sync();
  });
}`;
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const pair of String(cookieHeader || "").split(/;\s*/)) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    out[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return out;
}

async function hmacHex(secret, value) {
  if (!secret) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...signature].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
