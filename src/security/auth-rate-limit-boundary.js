import { consumeAtomicRateLimit } from "./rate-limit.js";

const AUTH_CLIENT_COOKIE = "bbtsl_auth_client";
const AUTH_PRIMARY_BUCKET = "auth_verify_primary";
const AUTH_PRIMARY_LIMIT = 60;
const AUTH_IP_GUARD_BUCKET = "auth_verify_ip_guard";
const AUTH_IP_GUARD_LIMIT = 400;
const AUTH_WINDOW_SECONDS = 300;
const AUTH_CLIENT_MAX_AGE_SECONDS = 24 * 60 * 60;

export class AuthRateLimitBoundaryError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "AuthRateLimitBoundaryError";
    this.status = status;
    this.headers = headers;
  }
}

export async function prepareOAuthRateLimitBoundary(request, env) {
  if (!isOAuthVerificationRequest(request)) {
    return {
      request,
      decorateResponse(response) {
        return response;
      }
    };
  }

  const ip = getClientIp(request);
  await enforceRateLimit(env, AUTH_PRIMARY_BUCKET, ip, AUTH_PRIMARY_LIMIT);
  await enforceRateLimit(env, AUTH_IP_GUARD_BUCKET, ip, AUTH_IP_GUARD_LIMIT);

  const cookies = parseCookies(request.headers.get("cookie") || "");
  const existingClientId = normalizeClientId(cookies[AUTH_CLIENT_COOKIE]);
  const clientId = existingClientId || crypto.randomUUID().replace(/-/g, "");
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", `oauth:${clientId}`);
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  const effectiveRequest = new Request(request, { headers });

  return {
    request: effectiveRequest,
    decorateResponse(response) {
      if (existingClientId) {
        return response;
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.append("set-cookie", buildAuthClientCookie(request, clientId));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }
  };
}

async function enforceRateLimit(env, bucket, key, limit) {
  const result = await consumeAtomicRateLimit(
    env.DB,
    bucket,
    key,
    limit,
    AUTH_WINDOW_SECONDS
  );
  if (!result.allowed) {
    throw new AuthRateLimitBoundaryError(429, "Too many authentication requests. Try again shortly.", {
      "retry-after": String(result.retryAfter)
    });
  }
}

function isOAuthVerificationRequest(request) {
  if (request.method !== "GET") {
    return false;
  }
  const pathname = new URL(request.url).pathname;
  return pathname === "/api/auth/start" || pathname === "/api/auth/callback";
}

function normalizeClientId(value) {
  const normalized = String(value || "").trim();
  return /^[a-f0-9]{32}$/i.test(normalized) ? normalized.toLowerCase() : "";
}

function getClientIp(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || request.headers.get("x-real-ip");
  return (forwarded || "local").split(",")[0].trim().slice(0, 80) || "local";
}

function buildAuthClientCookie(request, clientId) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${AUTH_CLIENT_COOKIE}=${clientId}; Path=/api/auth; Max-Age=${AUTH_CLIENT_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const pair of cookieHeader.split(/;\s*/)) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    out[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return out;
}
