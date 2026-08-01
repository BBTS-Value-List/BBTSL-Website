import {
  createSession,
  loadActiveSession,
  revokeSession,
  revokeUserSessions
} from "./session-store.js";

const SESSION_COOKIE = "bbtsl_session";
const SESSION_SCOPE = "session";

export async function prepareSessionBoundary(request, env, options = {}) {
  const nowSeconds = normalizeNowSeconds(options.nowSeconds);
  const nowIso = new Date(nowSeconds * 1_000).toISOString();
  const incomingToken = getCookieValue(request.headers.get("cookie") || "", SESSION_COOKIE);
  let sessionStoreAvailable = true;
  let activeSession = null;
  if (incomingToken) {
    try {
      activeSession = await loadActiveSession(env, incomingToken, nowIso);
    } catch (error) {
      if (!isMissingSessionStoreError(error)) throw error;
      console.warn("Session store table is missing; falling back to signed cookie sessions until migrations are applied.");
      sessionStoreAvailable = false;
    }
  }
  const effectiveRequest = sessionStoreAvailable && incomingToken && !activeSession
    ? removeCookieFromRequest(request, SESSION_COOKIE)
    : request;

  return {
    request: effectiveRequest,
    activeSession,
    async finalize(response) {
      if (!sessionStoreAvailable) return response;
      const issuedCookie = getResponseSessionCookie(response);
      if (issuedCookie.present) {
        if (!issuedCookie.value) {
          if (incomingToken && activeSession) {
            await revokeSession(env, incomingToken, getRevocationReason(request, "logout"), nowIso).catch((error) => {
              if (!isMissingSessionStoreError(error)) throw error;
            });
          }
        } else {
          const payload = await verifyIssuedSessionToken(env, issuedCookie.value, nowSeconds);
          await ensureSessionRegistered(env, issuedCookie.value, payload);
          if (incomingToken && incomingToken !== issuedCookie.value && activeSession) {
            await revokeSession(env, incomingToken, "session_replaced", nowIso).catch((error) => {
              if (!isMissingSessionStoreError(error)) throw error;
            });
          }
        }
      }

      await revokeDisabledUserSessions(request, response, env, nowIso);
      return response;
    }
  };
}

async function ensureSessionRegistered(env, token, payload) {
  const issuedAt = new Date(Number(payload.iat) * 1_000).toISOString();
  const expiresAt = new Date(Number(payload.exp) * 1_000).toISOString();
  const reauthAtSeconds = Number(payload.reauthAt || payload.iat);
  const reauthAt = new Date(reauthAtSeconds * 1_000).toISOString();
  let existing = null;
  try {
    existing = await loadActiveSession(env, token, issuedAt);
  } catch (error) {
    if (!isMissingSessionStoreError(error)) throw error;
    return null;
  }
  if (existing) {
    return existing;
  }

  try {
    return await createSession(env, {
      sessionId: token,
      userId: Number(payload.uid),
      issuedAt,
      expiresAt,
      reauthAt,
      mode: payload.mode === "system" ? "system" : "user"
    });
  } catch (error) {
    if (isMissingSessionStoreError(error)) return null;
    if (!/UNIQUE|constraint/i.test(String(error?.message || ""))) {
      throw error;
    }
    const raced = await loadActiveSession(env, token, issuedAt).catch((loadError) => {
      if (isMissingSessionStoreError(loadError)) return null;
      throw loadError;
    });
    if (!raced) {
      throw error;
    }
    return raced;
  }
}

async function verifyIssuedSessionToken(env, token, nowSeconds) {
  if (typeof token !== "string") {
    throw new Error("Issued session token is invalid.");
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Issued session token is invalid.");
  }

  const [payloadBase64, signature] = parts;
  const expected = await hmacHex(String(env.ADMIN_SESSION_SECRET || ""), payloadBase64);
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("Issued session token signature is invalid.");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadBase64));
  } catch {
    throw new Error("Issued session token payload is invalid.");
  }
  if (
    !payload
    || payload.scope !== SESSION_SCOPE
    || !Number.isSafeInteger(Number(payload.uid))
    || Number(payload.uid) <= 0
    || !Number.isSafeInteger(Number(payload.iat))
    || !Number.isSafeInteger(Number(payload.exp))
    || Number(payload.iat) > nowSeconds + 60
    || Number(payload.exp) <= nowSeconds
    || Number(payload.exp) <= Number(payload.iat)
    || (payload.mode !== undefined && payload.mode !== "user" && payload.mode !== "system")
  ) {
    throw new Error("Issued session token claims are invalid.");
  }
  return payload;
}

async function revokeDisabledUserSessions(request, response, env, nowIso) {
  const url = new URL(request.url);
  if (
    request.method !== "PATCH"
    || !/^\/api\/team\/users\/\d+$/.test(url.pathname)
    || response.status < 200
    || response.status >= 300
    || !String(response.headers.get("content-type") || "").includes("application/json")
  ) {
    return;
  }

  let body;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  const user = body?.user;
  if (user?.status !== "disabled" || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    return;
  }
  await revokeUserSessions(env, Number(user.id), "user_disabled", nowIso).catch((error) => {
    if (!isMissingSessionStoreError(error)) throw error;
  });
}

function getResponseSessionCookie(response) {
  const setCookie = String(response.headers.get("set-cookie") || "");
  if (!setCookie) {
    return { present: false, value: "" };
  }
  const match = setCookie.match(/(?:^|,\s*)bbtsl_session=([^;,]*)/i);
  if (!match) {
    return { present: false, value: "" };
  }
  return { present: true, value: match[1] || "" };
}

function getCookieValue(cookieHeader, name) {
  let value = "";
  for (const pair of String(cookieHeader || "").split(/;\s*/)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator) === name) {
      value = pair.slice(separator + 1);
    }
  }
  return value;
}

function removeCookieFromRequest(request, name) {
  const headers = new Headers(request.headers);
  const remaining = String(headers.get("cookie") || "")
    .split(/;\s*/)
    .filter(Boolean)
    .filter((pair) => pair.slice(0, pair.indexOf("=")) !== name);
  if (remaining.length) {
    headers.set("cookie", remaining.join("; "));
  } else {
    headers.delete("cookie");
  }
  return new Request(request, { headers });
}

function getRevocationReason(request, fallback) {
  const pathname = new URL(request.url).pathname;
  return pathname === "/api/auth/logout" ? "logout" : fallback;
}

function normalizeNowSeconds(value) {
  if (value === undefined || value === null) {
    return Math.floor(Date.now() / 1_000);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Session boundary timestamp is invalid.");
  }
  return number;
}

function isMissingSessionStoreError(error) {
  return /sessions|session_id_hash|reauth_at|revoked_at|revoke_reason|no such table|no such column/i.test(String(error?.message || error || ""));
}

async function hmacHex(secret, value) {
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not configured.");
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
