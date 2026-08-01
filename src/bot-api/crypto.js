const encoder = new TextEncoder();

const SIGNED_HEADER_NAMES = Object.freeze([
  "content-type",
  "x-bbtsl-idempotency-key",
  "x-bbtsl-media-variant",
  "x-bbtsl-reauth-challenge",
  "x-bbtsl-sword-name"
]);

export async function sha256Hex(value) {
  const bytes = normalizeBytes(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(digest);
}

export async function hmacHex(secret, value) {
  const normalizedSecret = String(secret || "");
  if (!normalizedSecret) throw new TypeError("HMAC secret is required.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalizedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, normalizeBytes(value)));
  return bytesToHex(signature);
}

export async function deriveDailyKey(baseSecret, clientId, date) {
  return (await hmacHex(baseSecret, `bbtsl-v1:${clientId}:${date}`)).slice(0, 32);
}

export async function deriveSigningKey(baseSecret, clientId, date) {
  return hmacHex(baseSecret, `bbtsl-bot-signing:${clientId}:${date}`);
}

export function canonicalizePath(pathOrUrl) {
  const url = pathOrUrl instanceof URL
    ? new URL(pathOrUrl.toString())
    : new URL(String(pathOrUrl || "/"), "https://bbtsl.invalid");
  const pairs = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  ));
  const query = new URLSearchParams();
  for (const [key, value] of pairs) query.append(key, value);
  const serialized = query.toString();
  return `${url.pathname}${serialized ? `?${serialized}` : ""}`;
}

export function canonicalizeSignedHeaders(headersInput) {
  const headers = headersInput instanceof Headers ? headersInput : new Headers(headersInput || {});
  return SIGNED_HEADER_NAMES
    .map((name) => `${name}:${normalizeHeaderValue(headers.get(name))}`)
    .join("\n");
}

export function buildCanonicalRequest(fields) {
  return [
    "bbtsl-bot-v1",
    String(fields.clientId || ""),
    String(fields.date || ""),
    String(fields.method || "").toUpperCase(),
    canonicalizePath(fields.path || "/"),
    String(fields.actorDiscordId || ""),
    String(fields.timestamp || ""),
    String(fields.nonce || ""),
    String(fields.headerHash || "").toLowerCase(),
    String(fields.bodyHash || "").toLowerCase()
  ].join("\n");
}

export function timingSafeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

export function base64UrlEncodeJson(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecodeJson(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function normalizeHeaderValue(value) {
  return String(value || "").trim().replace(/[ \t]+/g, " ");
}

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return encoder.encode(String(value ?? ""));
}

function bytesToHex(bytes) {
  return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
}
