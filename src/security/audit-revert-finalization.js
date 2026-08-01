export class AuditAlreadyRevertedError extends Error {
  constructor(message = "This audit entry has already been reverted.") {
    super(message);
    this.name = "AuditAlreadyRevertedError";
    this.status = 409;
  }
}

export function assertAuditNotAlreadyReverted(row) {
  if (String(row?.revert_status || "") === "reverted") {
    throw new AuditAlreadyRevertedError();
  }
}

export async function markAuditReverted(env, auditLogId) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("D1 is required to finalize audit reverts.");
  }
  const id = Number(auditLogId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError("Audit log ID is invalid.");
  }
  const result = await env.DB.prepare(`
    UPDATE audit_logs
    SET revert_status = 'reverted'
    WHERE id = ? AND revert_status != 'reverted'
  `).bind(id).run();
  return Math.max(0, Number(result?.meta?.changes ?? result?.changes ?? 0)) > 0;
}
