import { normalizeGaMeasurementId } from "./public-config.js";

const CONSENT_SCRIPT = "/consent.min.js";
const CONSENT_STYLES = "/consent.css";
const GOOGLE_CONNECT_SOURCES = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googletagmanager.com"
];
const GOOGLE_IMAGE_SOURCES = [
  "https://*.google-analytics.com",
  "https://*.googletagmanager.com"
];

export async function applyAnalyticsConsentMarkup(request, response, env) {
  const measurementId = normalizeGaMeasurementId(env?.GA_MEASUREMENT_ID);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (
    !measurementId
    || request.method === "HEAD"
    || response.status < 200
    || response.status >= 300
    || !contentType.includes("text/html")
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  const policy = String(headers.get("content-security-policy") || "");
  const nonce = readNonce(policy);
  if (!nonce) return response;

  const original = await response.text();
  if (original.includes(`src="${CONSENT_SCRIPT}"`)) {
    return new Response(original, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  let html = original;
  const stylesheet = `<link rel="stylesheet" href="${CONSENT_STYLES}">`;
  const script = `<script nonce="${nonce}" type="module" src="${CONSENT_SCRIPT}"></script>`;
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${stylesheet}\n</head>`) : `${stylesheet}${html}`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `  ${script}\n</body>`) : `${html}${script}`;

  headers.set("content-security-policy", appendDirectiveSources(
    appendDirectiveSources(policy, "connect-src", GOOGLE_CONNECT_SOURCES),
    "img-src",
    GOOGLE_IMAGE_SOURCES
  ));
  headers.delete("content-length");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function readNonce(policy) {
  const match = String(policy).match(/script-src[^;]*'nonce-([A-Za-z0-9_-]{16,128})'/i);
  return match?.[1] || null;
}

function appendDirectiveSources(policy, directive, sources) {
  const escaped = directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|;\\s*)${escaped}\\s+([^;]*)`, "i");
  const match = String(policy).match(pattern);
  if (!match) {
    return `${String(policy).replace(/;?\s*$/, "; ")}${directive} ${sources.join(" ")}`;
  }
  const existing = new Set(match[1].trim().split(/\s+/).filter(Boolean));
  for (const source of sources) existing.add(source);
  const replacement = `${directive} ${[...existing].join(" ")}`;
  return String(policy).replace(new RegExp(`${escaped}\\s+[^;]*`, "i"), replacement);
}
