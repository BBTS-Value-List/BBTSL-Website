export async function enrichAuditJsonResponse(response, env) {
  if (!response.ok || !String(response.headers.get("content-type") || "").includes("application/json")) return response;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!Array.isArray(body?.logs) || body.logs.length === 0) return response;
  const ids = body.logs
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return response;
  const placeholders = ids.map(() => "?").join(",");
  let results = [];
  try {
    const query = await env.DB.prepare(`
      SELECT audit_log_id, source, source_request_id
      FROM audit_sources
      WHERE audit_log_id IN (${placeholders})
    `).bind(...ids).all();
    results = query.results || [];
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/audit_sources|no such table|no such column/i.test(message)) {
      throw error;
    }
    results = [];
  }
  const sources = new Map(results.map((row) => [Number(row.audit_log_id), row]));
  body.logs = body.logs.map((row) => {
    const source = sources.get(Number(row.id));
    return {
      ...row,
      source: source?.source || "website",
      sourceRequestId: source?.source_request_id || null
    };
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
