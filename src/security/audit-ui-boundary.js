export async function markHistoryOnlyAuditEntries(response) {
  if (
    response.status < 200
    || response.status >= 300
    || !String(response.headers.get("content-type") || "").includes("application/json")
  ) {
    return response;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!Array.isArray(payload?.logs)) return response;

  payload.logs = payload.logs.map((log) => {
    const canRevert = log?.revertStatus === "reverted" ? false : log?.canRevert;
    const normalized = canRevert === log?.canRevert ? log : { ...log, canRevert };
    if (normalized?.entityType !== "sword" || normalized?.canRevert !== false) return normalized;
    return {
      ...normalized,
      entityType: "sword-history",
      originalEntityType: "sword"
    };
  });
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
