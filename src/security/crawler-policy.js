const SITE_STATE_KEY = "__system/site-state.json";
const PUBLIC_ROBOTS_TAG = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
const PRIVATE_ROBOTS_TAG = "noindex, nofollow, noarchive";
const AI_TRAINING_CRAWLERS = [
  "Amazonbot",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "ClaudeBot",
  "Google-Extended",
  "GPTBot",
  "meta-externalagent"
];
const DISALLOWED_PATHS = [
  "/api/",
  "/.env",
  "/.git/",
  "/wp-login.php",
  "/xmlrpc.php",
  "/phpmyadmin/",
  "/admin/"
];
const POLICY_PATHS = new Set([
  "/robots.txt",
  "/bots.txt",
  "/.well-known/security.txt",
  "/llms.txt",
  "/llm.txt",
  "/llms-full.txt",
  "/sitemap.xml"
]);

export function buildSecurityText(request, env) {
  const siteUrl = getSiteUrl(request, env);
  return [
    "Contact: mailto:bbtsl@pve.bio",
    `Contact: ${siteUrl}/team`,
    "Expires: 2027-07-25T00:00:00.000Z",
    "Preferred-Languages: en",
    `Canonical: ${siteUrl}/.well-known/security.txt`,
    "Policy: https://github.com/BBTS-Value-List/BBTSL-Website/blob/main/SECURITY.md",
    ""
  ].join("\n");
}

export function buildRobotsText(request, env) {
  const siteUrl = getSiteUrl(request, env);
  const lines = [
    "# BBTSL crawler and content-use policy",
    "# Search indexing and attributed reference are permitted.",
    "# AI model training is not permitted.",
    "",
    "User-Agent: *",
    "Content-signal: search=yes, ai-train=no, use=reference",
    "Allow: /",
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    "",
    "User-agent: Googlebot",
    "Allow: /",
    "Disallow: /api/",
    "",
    "User-agent: Bingbot",
    "Allow: /",
    "Disallow: /api/",
    ""
  ];
  for (const crawler of AI_TRAINING_CRAWLERS) {
    lines.push(`User-agent: ${crawler}`, "Disallow: /", "");
  }
  lines.push(`Sitemap: ${siteUrl}/sitemap.xml`, "");
  return lines.join("\n");
}

export function buildLlmsText(request, env) {
  const siteUrl = getSiteUrl(request, env);
  const siteName = String(env?.SITE_NAME || "BBTSL Blade Ball Top Spender List").trim();
  return [
    `# ${siteName}`,
    "",
    "BBTSL is a public community-maintained catalogue of Blade Ball Top Spender item values and media.",
    "Search indexing and real-time attributed reference are permitted.",
    "AI training, fine-tuning, bulk dataset creation, and unattributed reproduction are not permitted.",
    "When using public BBTSL information, attribute BBTSL and link to the canonical page.",
    "",
    "## Canonical public links",
    `- Website: ${siteUrl}/`,
    `- Team: ${siteUrl}/team`,
    `- Bot support: ${siteUrl}/bot/`,
    `- Privacy: ${siteUrl}/privacy`,
    `- Terms: ${siteUrl}/terms`,
    `- Security: ${siteUrl}/.well-known/security.txt`,
    `- Sitemap: ${siteUrl}/sitemap.xml`,
    "",
    "## Contact",
    "- bbtsl@pve.bio",
    ""
  ].join("\n");
}

export function buildLlmsFullText(request, env) {
  const siteUrl = getSiteUrl(request, env);
  const siteName = String(env?.SITE_NAME || "BBTSL Blade Ball Top Spender List").trim();
  return [
    `# ${siteName}`,
    "",
    "## Public purpose",
    "BBTSL provides a searchable public Blade Ball item catalogue with community-maintained value, demand, trend, count, category, description, and media information.",
    "",
    "## Public Discord bot support",
    "BBTSL provides a public bot support page with command examples, status checks, issue-report details, and item-to-Discord handoff examples.",
    "",
    "## Permitted use",
    "Search indexing and real-time attributed reference are permitted.",
    "AI training, fine-tuning, bulk dataset creation, and unattributed reproduction are not permitted.",
    "Attribute public facts to BBTSL and link to the canonical item or catalogue page.",
    "",
    "## Canonical pages",
    `- Catalogue: ${siteUrl}/`,
    `- Team: ${siteUrl}/team`,
    `- Bot support: ${siteUrl}/bot/`,
    `- Privacy: ${siteUrl}/privacy`,
    `- Terms: ${siteUrl}/terms`,
    `- Security: ${siteUrl}/.well-known/security.txt`,
    "",
    "## Accuracy",
    "Values are community-maintained and can change. Use the live canonical page for the current record.",
    "",
    "## Contact",
    "- bbtsl@pve.bio",
    ""
  ].join("\n");
}

export function buildSitemapXml(request, env, lastModified = null) {
  const siteUrl = getSiteUrl(request, env);
  const lastmod = normalizeDate(lastModified);
  const pages = [
    { path: "/", changefreq: "hourly", priority: "1.0" },
    { path: "/team", changefreq: "daily", priority: "0.7" },
    { path: "/bot/", changefreq: "weekly", priority: "0.6" },
    { path: "/privacy", changefreq: "monthly", priority: "0.3" },
    { path: "/terms", changefreq: "monthly", priority: "0.3" }
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => [
    "  <url>",
    `    <loc>${siteUrl}${page.path}</loc>`,
    ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
    `    <changefreq>${page.changefreq}</changefreq>`,
    `    <priority>${page.priority}</priority>`,
    "  </url>"
  ].join("\n")).join("\n")}\n</urlset>`;
}

export async function handleCrawlerPolicyRequest(request, env) {
  const url = new URL(request.url);
  if (!POLICY_PATHS.has(url.pathname) || !["GET", "HEAD"].includes(request.method)) return null;

  let body;
  let contentType;
  let cacheControl = "public, max-age=3600";
  if (url.pathname === "/robots.txt" || url.pathname === "/bots.txt") {
    body = buildRobotsText(request, env);
    contentType = "text/plain; charset=utf-8";
  } else if (url.pathname === "/.well-known/security.txt") {
    body = buildSecurityText(request, env);
    contentType = "text/plain; charset=utf-8";
    cacheControl = "public, max-age=300";
  } else if (url.pathname === "/llms.txt" || url.pathname === "/llm.txt") {
    body = buildLlmsText(request, env);
    contentType = "text/markdown; charset=utf-8";
    cacheControl = "public, max-age=300";
  } else if (url.pathname === "/llms-full.txt") {
    body = buildLlmsFullText(request, env);
    contentType = "text/markdown; charset=utf-8";
    cacheControl = "public, max-age=300";
  } else {
    body = buildSitemapXml(request, env, await readLatestContentDate(env));
    contentType = "application/xml; charset=utf-8";
  }

  return applyCrawlerResponsePolicy(request, new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  }));
}

export function applyCrawlerResponsePolicy(request, response) {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  const contentType = String(headers.get("content-type") || "").toLowerCase();
  if (shouldNoIndex(url.pathname, response.status)) {
    headers.set("x-robots-tag", PRIVATE_ROBOTS_TAG);
  } else if (response.status >= 200 && response.status < 300 && contentType.includes("text/html")) {
    headers.set("x-robots-tag", PUBLIC_ROBOTS_TAG);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function isCrawlerPolicyPath(pathname) {
  return POLICY_PATHS.has(String(pathname || ""));
}

function shouldNoIndex(pathname, status) {
  if (status >= 400) return true;
  if (POLICY_PATHS.has(pathname)) return true;
  return pathname.startsWith("/api/")
    || pathname === "/.env"
    || pathname.startsWith("/.git/")
    || pathname.startsWith("/wp-login")
    || pathname === "/xmlrpc.php"
    || pathname.startsWith("/phpmyadmin")
    || pathname === "/admin"
    || pathname.startsWith("/admin/");
}

async function readLatestContentDate(env) {
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function") return null;
  try {
    const object = await env.MEDIA_BUCKET.get(SITE_STATE_KEY);
    if (!object) return null;
    const state = JSON.parse(await object.text());
    const dates = [...(state?.swords || []), ...(state?.baseline || [])]
      .map((row) => normalizeDate(row?.u))
      .filter(Boolean)
      .sort();
    return dates.at(-1) || null;
  } catch {
    return null;
  }
}

function getSiteUrl(request, env) {
  return String(env?.PUBLIC_SITE_URL || new URL(request.url).origin).trim().replace(/\/+$/, "");
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}
