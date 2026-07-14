const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const HTML_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
  ].join("; "),
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

const SESSION_COOKIE = "bbtsl_admin_session";
const TOTP_CONFIG_KEY = "admin_totp";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW_STEPS = 1;
const MAX_EDIT_VALUE = 10_000_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DIRECT_IMAGE_READ_LIMIT = 512 * 1024;
const SESSION_LIFETIME_SECONDS = 60 * 60 * 12;
const OWNER_HEADER = "x-owner-key";
const APP_REQUEST_HEADER = "x-bbts-request";
const AUTH_VERIFY_BUCKET = "auth_verify";
const OWNER_BUCKET = "owner_totp";
const ADMIN_MUTATION_BUCKET = "admin_mutation";
let coreSchemaReadyPromise = null;

const CATEGORIES = new Set(["LTM", "Ranked", "Top Spenders", "Other Swords", "Explosions"]);
const DEMANDS = new Set(["Very High", "High", "Medium", "Low", "N/A"]);
const TRENDS = new Set(["Rising", "Falling", "Stable", "Manipulated", "N/A"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        await ensureCoreSchema(env);
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        return withSecurityHeaders(await handleAuthStatus(request, env));
      }

      if (url.pathname === "/api/auth/verify" && request.method === "POST") {
        return withSecurityHeaders(await handleAuthVerify(request, env));
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return withSecurityHeaders(await handleAuthLogout(request, env));
      }

      if (url.pathname === "/api/owner/totp" && request.method === "GET") {
        return withSecurityHeaders(await requireOwner(request, env, () => handleOwnerTotpGet(env)));
      }

      if (url.pathname === "/api/owner/totp" && request.method === "POST") {
        return withSecurityHeaders(await requireOwner(request, env, () => handleOwnerTotpSet(request, env)));
      }

      if (url.pathname === "/api/owner/images/import" && request.method === "POST") {
        return withSecurityHeaders(await requireOwner(request, env, () => handleOwnerImageImport(request, env)));
      }

      if (url.pathname === "/api/swords" && request.method === "GET") {
        return withSecurityHeaders(await handleListSwords(env, url));
      }

      if (url.pathname === "/api/swords" && request.method === "POST") {
        return withSecurityHeaders(await requireEditor(request, env, () => handleCreateSword(request, env)));
      }

      if (url.pathname.startsWith("/api/swords/")) {
        const id = parseSwordId(url.pathname);
        if (id === null) {
          return withSecurityHeaders(json({ error: "Invalid sword id." }, 400));
        }

        if (request.method === "PUT") {
          return withSecurityHeaders(await requireEditor(request, env, () => handleUpdateSword(request, env, id)));
        }

        if (request.method === "DELETE") {
          return withSecurityHeaders(await requireEditor(request, env, () => handleDeleteSword(env, id)));
        }
      }

      if (url.pathname === "/api/reset" && request.method === "POST") {
        return withSecurityHeaders(await requireEditor(request, env, () => handleReset(env)));
      }

      if (url.pathname.startsWith("/images/") && request.method === "GET") {
        return withSecurityHeaders(await handleGetImage(request, env, decodeURIComponent(url.pathname.slice("/images/".length))));
      }

      if (url.pathname === "/robots.txt" || url.pathname === "/bots.txt") {
        return withSecurityHeaders(text(buildRobotsText(request, env), "text/plain; charset=utf-8"));
      }

      if (url.pathname === "/llms.txt" || url.pathname === "/llm.txt") {
        return withSecurityHeaders(text(buildLlmsText(request, env), "text/plain; charset=utf-8"));
      }

      if (url.pathname === "/llms-full.txt") {
        return withSecurityHeaders(text(buildLlmsFullText(request, env), "text/plain; charset=utf-8"));
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

  const contentType = headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    headers.set("content-security-policy", HTML_SECURITY_HEADERS["content-security-policy"]);
    headers.set("cache-control", "public, max-age=300");
    const html = await response.text();
    return new Response(injectDynamicHeadMarkup(html, request, env), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } else if (contentType.includes("text/css") || contentType.includes("javascript")) {
    headers.set("cache-control", "public, max-age=3600");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleAuthStatus(request, env) {
  const session = await readSession(request, env);
  return json({
    authenticated: Boolean(session)
  });
}

async function handleAuthVerify(request, env) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  await consumeRateLimit(env, AUTH_VERIFY_BUCKET, getClientIdentifier(request), 6, 300);

  const body = await request.json().catch(() => null);
  const code = String(body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    throw new HttpError(400, "Enter a valid 6-digit code.");
  }

  const config = await getTotpConfig(env);
  if (!config) {
    throw new HttpError(503, "Admin authenticator is not configured yet.");
  }

  const valid = await verifyTotpCode(config.secret, code, TOTP_WINDOW_STEPS);
  if (!valid) {
    throw new HttpError(401, "Authenticator code is invalid or expired.");
  }

  const cookie = await issueSessionCookie(request, env);
  return new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "set-cookie": cookie
    }
  });
}

async function handleAuthLogout(request, env) {
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

async function handleOwnerTotpGet(env) {
  const config = await getTotpConfig(env);
  const issuer = config?.issuer || env.ADMIN_TOTP_DEFAULT_ISSUER || "BBTSL Blade Ball Value List";
  const accountLabel = config?.accountLabel || env.ADMIN_TOTP_DEFAULT_ACCOUNT || "bbtsl-admin";

  if (!config) {
    return json({
      configured: false,
      issuer,
      accountLabel
    });
  }

  return json(buildTotpStatusResponse(config));
}

async function handleOwnerTotpSet(request, env) {
  const body = await request.json().catch(() => ({}));
  const issuer = sanitizeOptionalString(body.issuer || env.ADMIN_TOTP_DEFAULT_ISSUER || "BBTSL Blade Ball Value List", 120) || "BBTSL Blade Ball Value List";
  const accountLabel = sanitizeOptionalString(body.accountLabel || env.ADMIN_TOTP_DEFAULT_ACCOUNT || "bbtsl-admin", 120) || "bbtsl-admin";
  const secret = body.secret
    ? normalizeBase32Secret(body.secret)
    : generateTotpSecret();

  const config = {
    secret,
    issuer,
    accountLabel,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    updatedAt: currentIsoString()
  };

  await env.DB.prepare(`
    INSERT INTO admin_config (config_key, secret, issuer, account_label, digits, period, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(config_key) DO UPDATE SET
      secret = excluded.secret,
      issuer = excluded.issuer,
      account_label = excluded.account_label,
      digits = excluded.digits,
      period = excluded.period,
      updated_at = excluded.updated_at
  `).bind(
    TOTP_CONFIG_KEY,
    config.secret,
    config.issuer,
    config.accountLabel,
    config.digits,
    config.period,
    config.updatedAt
  ).run();

  return json(buildTotpProvisioningResponse(config));
}

async function handleOwnerImageImport(request, env) {
  const body = await request.json().catch(() => null);
  const items = Array.isArray(body?.items)
    ? body.items
    : [{ key: body?.key, dataUrl: body?.dataUrl }];

  if (items.length === 0) {
    throw new HttpError(400, "At least one image import item is required.");
  }

  for (const item of items) {
    const imageKey = requireImageKey(item?.key);
    await importImageRecord(env, imageKey, item?.dataUrl);
  }

  return json({ ok: true, imported: items.length });
}

async function handleListSwords(env, url) {
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
    SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
    FROM swords
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ${sortSql}
  `;

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return json({
    swords: (results || []).map((row) => serializeSword(row))
  });
}

async function handleCreateSword(request, env) {
  const payload = normalizePayload(await request.json());
  const image = payload.img !== undefined ? await persistImage(env, payload.img, null, payload.n) : { imageKey: null };

  const now = currentDateString();
  const result = await env.DB.prepare(`
    INSERT INTO swords (n, c, v, d, t, ct, u, descr, image_key, edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    payload.n,
    payload.c,
    payload.v,
    payload.d,
    payload.t,
    payload.ct,
    now,
    payload.descr,
    image.imageKey
  ).run();

  const created = await env.DB.prepare(`
    SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
    FROM swords
    WHERE id = ?
  `).bind(result.meta.last_row_id).first();

  return json({ sword: serializeSword(created) }, 201);
}

async function handleUpdateSword(request, env, id) {
  const existing = await env.DB.prepare(`
    SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
    FROM swords
    WHERE id = ?
  `).bind(id).first();

  if (!existing) {
    throw new HttpError(404, "Sword not found.");
  }

  const payload = normalizePayload(await request.json());
  const image = payload.img !== undefined
    ? await persistImage(env, payload.img, existing.image_key, payload.n)
    : { imageKey: existing.image_key };

  await env.DB.prepare(`
    UPDATE swords
    SET n = ?, c = ?, v = ?, d = ?, t = ?, ct = ?, u = ?, descr = ?, image_key = ?, edited = 1
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
    image.imageKey,
    id
  ).run();

  const updated = await env.DB.prepare(`
    SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
    FROM swords
    WHERE id = ?
  `).bind(id).first();

  return json({ sword: serializeSword(updated) });
}

async function handleDeleteSword(env, id) {
  const existing = await env.DB.prepare("SELECT image_key FROM swords WHERE id = ?").bind(id).first();
  if (!existing) {
    throw new HttpError(404, "Sword not found.");
  }

  await env.DB.prepare("DELETE FROM swords WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function handleReset(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM swords"),
    env.DB.prepare(`
      INSERT INTO swords (id, n, c, v, d, t, ct, u, descr, image_key, edited)
      SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
      FROM sword_baseline
      ORDER BY v DESC, id ASC
    `)
  ]);

  const { results } = await env.DB.prepare(`
    SELECT id, n, c, v, d, t, ct, u, descr, image_key, edited
    FROM swords
    ORDER BY v DESC, id ASC
  `).all();

  return json({
    ok: true,
    swords: (results || []).map((row) => serializeSword(row))
  });
}

async function handleGetImage(request, env, key) {
  if (!key) {
    throw new HttpError(400, "Missing image key.");
  }

  if (key === "unavailable.webp") {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const row = await env.DB.prepare(`
    SELECT content_type, length(image_data) AS image_size
    FROM sword_images
    WHERE image_key = ?
  `).bind(key).first();

  if (!row) {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const imageSize = Number(row.image_size || 0);
  let imageBody = null;
  if (imageSize > 0 && imageSize <= DIRECT_IMAGE_READ_LIMIT) {
    const bodyRow = await env.DB.prepare(`
      SELECT image_data
      FROM sword_images
      WHERE image_key = ?
    `).bind(key).first();

    imageBody = await readImageBody(bodyRow?.image_data);
  }

  if (!imageBody?.byteLength) {
    imageBody = await readImageBodyFromChunks(env, key, imageSize);
  }

  if (!imageBody?.byteLength) {
    return env.ASSETS.fetch(new Request(new URL("/images/unavailable.webp", request.url), request));
  }

  const headers = new Headers();
  const contentType = String(row.content_type || "").toLowerCase();
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", HTML_SECURITY_HEADERS["x-content-type-options"]);
  if (contentType === "image/svg+xml" || key.toLowerCase().endsWith(".svg")) {
    headers.set("content-disposition", `attachment; filename="${key.split("/").pop() || "image.svg"}"`);
    headers.set("content-security-policy", "default-src 'none'; sandbox");
  }
  return new Response(imageBody, { headers });
}

async function requireEditor(request, env, fn) {
  enforceTrustedOrigin(request);
  enforceAppRequest(request);
  await consumeRateLimit(env, ADMIN_MUTATION_BUCKET, getClientIdentifier(request), 60, 300);

  const session = await readSession(request, env);
  if (!session) {
    throw new HttpError(401, "Admin verification required.");
  }

  return fn();
}

async function requireOwner(request, env, fn) {
  const configured = (env.OWNER_API_KEY || "").trim();
  const provided = (request.headers.get(OWNER_HEADER) || "").trim();
  if (!configured || provided !== configured) {
    throw new HttpError(403, "Owner key is invalid.");
  }

  await consumeRateLimit(env, OWNER_BUCKET, getClientIdentifier(request), 20, 600);
  return fn();
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
    throw new HttpError(403, "Invalid admin request.");
  }
}

async function readSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const raw = cookies[SESSION_COOKIE];
  if (!raw) {
    return null;
  }

  const parts = raw.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadBase64, signature] = parts;
  const expected = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  if (!expected || !timingSafeEqual(signature, expected)) {
    return null;
  }

  const payload = JSON.parse(base64UrlDecode(payloadBase64));
  if (!payload || payload.role !== "admin" || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

async function issueSessionCookie(request, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    role: "admin",
    iat: now,
    exp: now + SESSION_LIFETIME_SECONDS
  };
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(env.ADMIN_SESSION_SECRET || "", payloadBase64);
  return buildSessionCookie(request, `${payloadBase64}.${signature}`, SESSION_LIFETIME_SECONDS);
}

function buildSessionCookie(request, value, maxAge) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

async function getTotpConfig(env) {
  const row = await env.DB.prepare(`
    SELECT secret, issuer, account_label, digits, period, updated_at
    FROM admin_config
    WHERE config_key = ?
  `).bind(TOTP_CONFIG_KEY).first();

  if (!row) {
    return null;
  }

  return {
    secret: row.secret,
    issuer: row.issuer,
    accountLabel: row.account_label,
    digits: Number(row.digits),
    period: Number(row.period),
    updatedAt: row.updated_at
  };
}

function buildTotpStatusResponse(config) {
  return {
    configured: true,
    issuer: config.issuer,
    accountLabel: config.accountLabel,
    period: config.period,
    digits: config.digits,
    updatedAt: config.updatedAt
  };
}

function buildTotpProvisioningResponse(config) {
  return {
    configured: true,
    secret: config.secret,
    manualEntryKey: config.secret,
    issuer: config.issuer,
    accountLabel: config.accountLabel,
    period: config.period,
    digits: config.digits,
    otpauthUrl: buildOtpAuthUrl(config),
    googleAuthenticatorUrl: buildOtpAuthUrl(config)
  };
}

async function verifyTotpCode(secret, providedCode, windowSteps) {
  const secretBytes = decodeBase32(secret);
  const now = Math.floor(Date.now() / 1000);
  const currentCounter = Math.floor(now / TOTP_PERIOD_SECONDS);

  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const expected = await generateTotp(secretBytes, currentCounter + offset, TOTP_DIGITS);
    if (timingSafeEqual(expected, providedCode)) {
      return true;
    }
  }

  return false;
}

async function generateTotp(secretBytes, counter, digits) {
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  const high = Math.floor(counter / 2 ** 32);
  const low = counter >>> 0;
  view.setUint32(0, high);
  view.setUint32(4, low);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);
  const otp = binary % (10 ** digits);
  return String(otp).padStart(digits, "0");
}

function buildOtpAuthUrl(config) {
  const label = encodeURIComponent(`${config.issuer}:${config.accountLabel}`);
  const issuer = encodeURIComponent(config.issuer);
  return `otpauth://totp/${label}?secret=${config.secret}&issuer=${issuer}&algorithm=SHA1&digits=${config.digits}&period=${config.period}`;
}

function generateTotpSecret(length = 20) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

function normalizeBase32Secret(value) {
  const normalized = String(value).toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!normalized) {
    throw new HttpError(400, "Authenticator secret is invalid.");
  }

  decodeBase32(normalized);
  return normalized;
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
    throw new HttpError(500, "Admin session secret is not configured.");
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

function decodeBase32(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const output = [];

  for (const char of input) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) {
      throw new HttpError(400, "Authenticator secret is invalid.");
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

function encodeBase32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
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

async function persistImage(env, imageInput, currentKey, swordName) {
  if (imageInput === null) {
    return { imageKey: null };
  }

  if (typeof imageInput !== "string") {
    throw new HttpError(400, "Image must be a data URL string or null.");
  }

  const parsed = parseDataUrl(imageInput);
  if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "Image is too large.");
  }

  const nextKey = buildImageKey(swordName, parsed.extension);
  await upsertImageRecord(env, nextKey, parsed.contentType, parsed.bytes);

  return { imageKey: nextKey };
}

async function importImageRecord(env, imageKey, imageDataUrl) {
  if (typeof imageDataUrl !== "string") {
    throw new HttpError(400, "Image payload is invalid.");
  }

  const parsed = parseDataUrl(imageDataUrl);
  if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "Image is too large.");
  }

  await upsertImageRecord(env, imageKey, parsed.contentType, parsed.bytes);
}

async function upsertImageRecord(env, imageKey, contentType, bytes) {
  await env.DB.prepare(`
    INSERT INTO sword_images (image_key, content_type, image_data, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(image_key) DO UPDATE SET
      content_type = excluded.content_type,
      image_data = excluded.image_data,
      updated_at = excluded.updated_at
  `).bind(
    imageKey,
    contentType,
    bytes,
    currentIsoString()
  ).run();
}

function parseDataUrl(input) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(input);
  if (!match) {
    throw new HttpError(400, "Image must be a base64 data URL.");
  }

  const contentType = match[1].toLowerCase();
  const extension = mimeToExtension(contentType);
  if (!extension) {
    throw new HttpError(415, "Unsupported image type.");
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { contentType, extension, bytes };
}

function mimeToExtension(contentType) {
  switch (contentType) {
    case "image/webp":
      return "webp";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

function buildImageKey(swordName, extension) {
  const slug = swordName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sword";
  return `swords/${slug}-${crypto.randomUUID()}.${extension}`;
}

function requireImageKey(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "Image key is invalid.");
  }

  const normalized = value.trim().slice(0, 512);
  if (!normalized) {
    throw new HttpError(400, "Image key is invalid.");
  }

  return normalized;
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

async function readImageBody(value) {
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

async function readImageBodyFromChunks(env, key, imageSize) {
  if (!Number.isFinite(imageSize) || imageSize <= 0) {
    return null;
  }

  const chunkSize = 262144;
  const bytes = new Uint8Array(imageSize);

  for (let offset = 0; offset < imageSize; offset += chunkSize) {
    const length = Math.min(chunkSize, imageSize - offset);
    const row = await env.DB.prepare(`
      SELECT hex(substr(image_data, ?, ?)) AS image_hex
      FROM sword_images
      WHERE image_key = ?
    `).bind(offset + 1, length, key).first();

    const chunk = hexToBytes(row?.image_hex);
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

function serializeSword(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    n: row.n,
    c: row.c,
    v: Number(row.v),
    d: row.d,
    t: row.t,
    ct: row.ct === null || row.ct === undefined ? null : Number(row.ct),
    u: row.u,
    descr: row.descr || "",
    img: row.image_key ? `/images/${encodeURIComponent(row.image_key)}` : null,
    edited: Boolean(row.edited)
  };
}

function currentDateString() {
  return new Date().toISOString().slice(0, 10);
}

function currentIsoString() {
  return new Date().toISOString();
}

function normalizePayload(body) {
  return {
    n: requireString(body.n, "Name"),
    c: requireEnum(body.c, CATEGORIES, "Category"),
    v: clampInteger(body.v, 0, MAX_EDIT_VALUE, "Value"),
    d: requireEnum(body.d, DEMANDS, "Demand"),
    t: requireEnum(body.t, TRENDS, "Trend"),
    ct: body.ct === null || body.ct === undefined || body.ct === "" ? null : clampInteger(body.ct, 0, 1_000_000, "Count"),
    descr: sanitizeOptionalString(body.descr, 1000),
    img: body.img
  };
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

function parseSwordId(pathname) {
  const raw = pathname.slice("/api/swords/".length);
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  return Number(raw);
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

function text(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600"
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
    "Authenticated admins can edit entries through server-side TOTP verification.",
    "The main page presents a searchable card grid with each sword's name, category, demand, trend, count, value, and description when available.",
    "",
    `Canonical: ${siteUrl}/`,
    `Sitemap: ${siteUrl}/sitemap.xml`,
    `More: ${siteUrl}/llms-full.txt`
  ].join("\n");
}

function buildLlmsFullText(request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const siteName = env.SITE_NAME || "BBTSL Blade Ball Value List";
  return [
    `# ${siteName}`,
    "",
    "## Purpose",
    "Track Blade Ball sword values in a public dark-mode catalogue.",
    "",
    "## Public page structure",
    "- Sticky top bar with site identity and last-updated text.",
    "- Search field to filter swords by name.",
    "- Category chips for All, LTM, Ranked, Top Spenders, Other Swords, and Explosions.",
    "- Sort control for value and recency ordering.",
    "- Card grid where each sword card shows name, category, demand, trend, count, value, image, and description.",
    "",
    "## Machine-readable endpoints",
    `- Swords API: ${siteUrl}/api/swords`,
    `- Robots: ${siteUrl}/robots.txt`,
    `- Sitemap: ${siteUrl}/sitemap.xml`,
    `- LLM summary: ${siteUrl}/llms.txt`,
    "",
    "## Notes",
    "- Public data is readable without authentication.",
    "- Admin editing requires TOTP verification and is not needed for normal visitors."
  ].join("\n");
}

function injectDynamicHeadMarkup(html, request, env) {
  const siteUrl = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/g, "");
  const pageUrl = `${siteUrl}/`;
  const imageUrl = `${siteUrl}/og-image.png`;

  const markup = [
    `<link rel="canonical" href="${pageUrl}">`,
    `<meta property="og:url" content="${pageUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="96">`,
    `<meta property="og:image:height" content="96">`,
    `<meta property="og:image:alt" content="BBTSL Blade Ball Value List preview image">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<meta name="twitter:image:alt" content="BBTSL Blade Ball Value List preview image">`
  ].join("");

  return html.replace("<!-- dynamic-meta -->", markup);
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
</urlset>`;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  const contentType = (headers.get("content-type") || "").toLowerCase();
  headers.set("referrer-policy", HTML_SECURITY_HEADERS["referrer-policy"]);
  headers.set("x-content-type-options", HTML_SECURITY_HEADERS["x-content-type-options"]);
  headers.set("x-frame-options", HTML_SECURITY_HEADERS["x-frame-options"]);
  headers.set("permissions-policy", HTML_SECURITY_HEADERS["permissions-policy"]);
  if (contentType.includes("text/html")) {
    headers.set("content-security-policy", HTML_SECURITY_HEADERS["content-security-policy"]);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

async function ensureCoreSchema(env) {
  if (!coreSchemaReadyPromise) {
    coreSchemaReadyPromise = (async () => {
      const statements = [
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
        "CREATE INDEX IF NOT EXISTS idx_swords_category ON swords (c)",
        "CREATE INDEX IF NOT EXISTS idx_swords_value ON swords (v DESC)",
        "CREATE INDEX IF NOT EXISTS idx_sword_baseline_category ON sword_baseline (c)",
        "CREATE INDEX IF NOT EXISTS idx_sword_images_updated_at ON sword_images (updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start)"
      ];

      for (const statement of statements) {
        await env.DB.prepare(statement).run();
      }
    })().catch((error) => {
      coreSchemaReadyPromise = null;
      throw error;
    });
  }

  await coreSchemaReadyPromise;
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

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
