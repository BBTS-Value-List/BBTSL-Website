const TRUSTED_SCRIPT_SOURCES = new Set(["/app.min.js", "/app.js", "/team.min.js", "/bot-support.js", "/consent.min.js"]);
const TRUSTED_SCRIPT_ORIGIN = "https://bbtsl.lol";

const JSON_HTML_ESCAPE_MAP = new Map([
  ["<", "\\u003c"],
  [">", "\\u003e"],
  ["&", "\\u0026"],
  ["\u2028", "\\u2028"],
  ["\u2029", "\\u2029"]
]);

export function serializeJsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => JSON_HTML_ESCAPE_MAP.get(character));
}

export function buildContentSecurityPolicy(basePolicy, nonce) {
  const normalizedNonce = normalizeNonce(nonce);
  const nonceSource = `'nonce-${normalizedNonce}'`;
  const scriptDirective = `script-src ${nonceSource} 'self'`;
  const scriptElementDirective = `script-src-elem ${nonceSource} 'self'`;
  const scriptAttributeDirective = "script-src-attr 'none'";
  return setCspDirective(
    setCspDirective(
      setCspDirective(basePolicy, "script-src", scriptDirective),
      "script-src-elem",
      scriptElementDirective
    ),
    "script-src-attr",
    scriptAttributeDirective
  );
}

export function addScriptNonces(html, nonce) {
  const normalizedNonce = normalizeNonce(nonce);
  return String(html).replace(/<script\b([^>]*)>/gi, (tag, attributes) => {
    if (/\bnonce\s*=/i.test(attributes)) {
      return tag;
    }
    const type = readAttribute(attributes, "type").toLowerCase();
    const src = readAttribute(attributes, "src");
    const trustedJsonLd = type === "application/ld+json" && !src;
    const trustedScript = src && TRUSTED_SCRIPT_SOURCES.has(normalizeScriptSourcePath(src));
    if (!trustedJsonLd && !trustedScript) {
      return tag;
    }
    return `<script nonce="${normalizedNonce}"${attributes}>`;
  });
}

function setCspDirective(policy, directive, value) {
  const source = String(policy || "").trim().replace(/;+\s*$/g, "");
  const escaped = directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|;\\s*)${escaped}\\s+[^;]*`, "i");
  if (pattern.test(source)) {
    return source.replace(pattern, (match) => {
      const prefix = match.startsWith(";") ? "; " : "";
      return `${prefix}${value}`;
    });
  }
  return source ? `${source}; ${value}` : value;
}

function normalizeScriptSourcePath(src) {
  const value = String(src || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, TRUSTED_SCRIPT_ORIGIN);
    return parsed.origin === TRUSTED_SCRIPT_ORIGIN ? parsed.pathname : "";
  } catch {
    return value.startsWith("/") ? value.split(/[?#]/, 1)[0] : "";
  }
}

function readAttribute(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\u0060]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function normalizeNonce(nonce) {
  const normalized = String(nonce || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(normalized)) {
    throw new TypeError("CSP nonce is invalid.");
  }
  return normalized;
}
