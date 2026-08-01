const PRIVATE_ROBOTS_TAG = "noindex, nofollow, noarchive";

export function classifyProbePath(pathname) {
  const normalized = normalizePath(pathname);
  if (!normalized || normalized === "/.well-known" || normalized.startsWith("/.well-known/")) {
    return { blocked: false, kind: null, path: normalized || "/" };
  }
  if (normalized === "/.env" || normalized.startsWith("/.env.")) {
    return { blocked: true, kind: "environment-probe", path: normalized };
  }
  if (normalized === "/.git" || normalized.startsWith("/.git/")) {
    return { blocked: true, kind: "git-probe", path: normalized };
  }
  if (normalized === "/wp-login.php" || normalized === "/wp-login" || normalized === "/wp-admin" || normalized.startsWith("/wp-admin/")) {
    return { blocked: true, kind: "wordpress-probe", path: normalized };
  }
  if (normalized === "/xmlrpc.php") {
    return { blocked: true, kind: "xmlrpc-probe", path: normalized };
  }
  if (normalized === "/phpmyadmin" || normalized.startsWith("/phpmyadmin/")) {
    return { blocked: true, kind: "phpmyadmin-probe", path: normalized };
  }
  if (normalized === "/admin" || normalized.startsWith("/admin/")) {
    return { blocked: true, kind: "admin-probe", path: normalized };
  }
  return { blocked: false, kind: null, path: normalized };
}

export function handleProbePathRequest(request) {
  const classification = classifyProbePath(new URL(request.url).pathname);
  if (!classification.blocked) return null;
  return createNotFoundResponse(request.method === "HEAD");
}

function createNotFoundResponse(headOnly) {
  return new Response(headOnly ? null : "Not found.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": PRIVATE_ROBOTS_TAG,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function normalizePath(value) {
  let path = String(value || "/");
  try {
    path = decodeURIComponent(path);
  } catch {
    return "/";
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return path.toLowerCase();
}
