import { consumeAtomicRateLimit } from "./rate-limit.js";

const SESSION_COOKIE = "bbtsl_session";
const APP_REQUEST_HEADER = "x-bbts-request";
const SYSTEM_DISCORD_USER_ID = "386438401563557888";
const ADMISSION_RATE_LIMIT_BUCKET = "admin_mutation_admission";
const ADMISSION_IP_GUARD_BUCKET = "admin_mutation_ip_guard";
const ADMISSION_RATE_LIMIT = 60;
const ADMISSION_IP_GUARD_LIMIT = 1_200;
const ADMISSION_WINDOW_SECONDS = 300;
const REAUTH_WINDOW_SECONDS = 10 * 60;

const ROLE_PERMISSIONS = {
  Viewer: [],
  Contributor: ["team:view:self"],
  Editor: ["team:view:self", "sword:update", "media:update"],
  Maintainer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete"],
  Administrator: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export"],
  Developer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "data:reset", "audit:revert", "team:manage", "session:revoke", "backup:manage"],
  Owner: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "data:reset", "audit:revert", "team:manage", "session:revoke", "backup:manage", "owner:all"]
};

const EXPENSIVE_READ_ROUTES = new Map([
  ["/api/export", { capability: "data:export", bucket: "data_export", limit: 6, ipLimit: 120, windowSeconds: 60 }],
  ["/api/audit", { capability: "audit:view", bucket: "audit_read", limit: 60, ipLimit: 600, windowSeconds: 60 }]
]);

export class MutationAdmissionError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "MutationAdmissionError";
    this.status = status;
    this.headers = headers;
  }
}

export async function authorizeSiteStateMutation(request, env) {
  const route = getMutationRoute(request);
  if (!route) {
    return null;
  }

  if (route.maintenance) {
    authorizeMaintenanceRequest(request, env);
    return { actorId: null, actorRole: "System", capability: "maintenance" };
  }

  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  const actor = await authenticateActor(request, env);
  if (!hasCapability(actor.role, route.capability)) {
    throw new MutationAdmissionError(403, "You do not have permission to perform this action.");
  }

  if (route.freshReauth && !isFreshReauth(actor.session)) {
    throw new MutationAdmissionError(403, "Discord re-authentication is required before continuing.");
  }

  await consumeIdentityAwareRateLimit(env, request, {
    bucket: ADMISSION_RATE_LIMIT_BUCKET,
    ipGuardBucket: ADMISSION_IP_GUARD_BUCKET,
    userId: actor.user.id,
    limit: ADMISSION_RATE_LIMIT,
    ipLimit: ADMISSION_IP_GUARD_LIMIT,
    windowSeconds: ADMISSION_WINDOW_SECONDS
  });

  return {
    actorId: Number(actor.user.id),
    actorRole: actor.role,
    capability: route.capability,
    actor: {
      session: actor.session,
      user: { ...actor.user, role: actor.role },
      baseUser: actor.user,
      isSystem: Boolean(actor.session?.systemMode && actor.role === "Owner")
    }
  };
}

export async function authorizeExpensiveRead(request, env) {
  const route = getExpensiveReadRoute(request);
  if (!route) {
    return null;
  }

  enforceTrustedOrigin(request);
  const actor = await authenticateActor(request, env);
  if (!hasCapability(actor.role, route.capability)) {
    throw new MutationAdmissionError(403, "You do not have permission to perform this action.");
  }

  await consumeIdentityAwareRateLimit(env, request, {
    bucket: route.bucket,
    ipGuardBucket: `${route.bucket}_ip_guard`,
    userId: actor.user.id,
    limit: route.limit,
    ipLimit: route.ipLimit,
    windowSeconds: route.windowSeconds
  });

  return {
    actorId: Number(actor.user.id),
    actorRole: actor.role,
    capability: route.capability
  };
}

export function isExpensiveAuthenticatedReadRequest(request) {
  return Boolean(getExpensiveReadRoute(request));
}

export function applyAdmissionRateLimitIdentity(request, admission) {
  if (!admission?.actorId) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", `user:${Number(admission.actorId)}`);
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  return new Request(request, { headers });
}

export function getMutationRoute(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/api/internal/media-reconcile") {
    return { maintenance: true };
  }
  if (method === "POST" && (pathname === "/api/swords" || pathname === "/api/swords/commit")) {
    return { capability: "sword:create" };
  }
  if (method === "POST" && pathname === "/api/media") {
    return { capability: "media:update" };
  }
  if (method === "POST" && pathname === "/api/reset") {
    return { capability: "data:reset", freshReauth: true };
  }
  if (method === "POST" && pathname === "/api/audit/revert") {
    return { capability: "audit:revert", freshReauth: true };
  }
  if (method === "PUT" && pathname.startsWith("/api/swords/commit/")) {
    const id = pathname.slice("/api/swords/commit/".length);
    if (!/^\d+$/.test(id)) throw new MutationAdmissionError(400, "Invalid sword id.");
    return { capability: "sword:update" };
  }
  if ((method === "PUT" || method === "DELETE") && pathname.startsWith("/api/swords/")) {
    const id = pathname.slice("/api/swords/".length);
    if (!/^\d+$/.test(id)) {
      throw new MutationAdmissionError(400, "Invalid sword id.");
    }
    return { capability: method === "PUT" ? "sword:update" : "sword:delete" };
  }
  return null;
}

function getExpensiveReadRoute(request) {
  if (request.method !== "GET") {
    return null;
  }
  return EXPENSIVE_READ_ROUTES.get(new URL(request.url).pathname) || null;
}

async function authenticateActor(request, env) {
  const session = await readSession(request, env);
  if (!session) {
    throw new MutationAdmissionError(401, "Sign in with Discord to continue.");
  }

  const user = await env.DB.prepare(`
    SELECT id, discord_user_id, role, status
    FROM users
    WHERE id = ?
  `).bind(session.userId).first();
  if (!user || user.status === "disabled") {
    throw new MutationAdmissionError(401, "Sign in with Discord to continue.");
  }

  const role = session.systemMode && String(user.discord_user_id || "") === SYSTEM_DISCORD_USER_ID
    ? "Owner"
    : String(user.role || "");
  return { session, user, role };
}

async function consumeIdentityAwareRateLimit(env, request, options) {
  const primary = await consumeAtomicRateLimit(
    env.DB,
    options.bucket,
    `user:${Number(options.userId)}`,
    options.limit,
    options.windowSeconds
  );
  if (!primary.allowed) {
    throw new MutationAdmissionError(429, "Too many requests. Try again shortly.", {
      "retry-after": String(primary.retryAfter)
    });
  }

  const ipGuard = await consumeAtomicRateLimit(
    env.DB,
    options.ipGuardBucket,
    getClientIp(request),
    options.ipLimit,
    options.windowSeconds
  );
  if (!ipGuard.allowed) {
    throw new MutationAdmissionError(429, "Too many requests from this network. Try again shortly.", {
      "retry-after": String(ipGuard.retryAfter)
    });
  }
}

function authorizeMaintenanceRequest(request, env) {
  const expectedSecret = String(env.MEDIA_MIGRATION_SECRET || "");
  const providedSecret = request.headers.get("x-bbtsl-maintenance-key") || "";
  if (!expectedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
    throw new MutationAdmissionError(404, "Not found.");
  }
}

function enforceTrustedOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) {
    const referer = request.headers.get("referer");
    if (!referer) {
      throw new MutationAdmissionError(403, "Missing same-origin context.");
    }
    let refererUrl;
    try {
      refererUrl = new URL(referer);
    } catch {
      throw new MutationAdmissionError(403, "Invalid same-origin context.");
    }
    if (refererUrl.origin !== url.origin) {
      throw new MutationAdmissionError(403, "Cross-origin requests are not allowed.");
    }
    return;
  }
  if (origin !== url.origin) {
    throw new MutationAdmissionError(403, "Cross-origin requests are not allowed.");
  }
}

function enforceAppRequest(request) {
  if (request.headers.get(APP_REQUEST_HEADER) !== "1") {
    throw new MutationAdmissionError(403, "Invalid application request.");
  }
}

async function readSession(request, env) {
  const raw = parseCookies(request.headers.get("cookie") || "")[SESSION_COOKIE];
  if (!raw) {
    return null;
  }
  const payload = await verifySignedToken(env, raw);
  if (!payload || typeof payload.uid !== "number") {
    return null;
  }
  return {
    userId: payload.uid,
    iat: payload.iat,
    reauthAt: payload.reauthAt || payload.iat || 0,
    systemMode: payload.mode === "system"
  };
}

async function verifySignedToken(env, token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadBase64, signature] = parts;
  const expected = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadBase64));
  } catch {
    return null;
  }
  if (!payload || payload.scope !== "session" || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function hasCapability(role, capability) {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(capability) || permissions.includes("owner:all");
}

function isFreshReauth(session) {
  return Boolean(session?.reauthAt)
    && (Math.floor(Date.now() / 1000) - Number(session.reauthAt)) <= REAUTH_WINDOW_SECONDS;
}

function getClientIp(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || request.headers.get("x-real-ip");
  return (forwarded || "local").split(",")[0].trim().slice(0, 80) || "local";
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
    throw new MutationAdmissionError(500, "ADMIN_SESSION_SECRET is not configured.");
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

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
