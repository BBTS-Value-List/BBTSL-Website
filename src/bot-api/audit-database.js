const AUDIT_INSERT = /\bINSERT\s+OR\s+IGNORE\s+INTO\s+audit_logs\b/i;
const SOURCE = "discord-bot";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{16,96}$/;

export function createBotAuditDatabase(database, requestId) {
  validateDatabase(database);
  const normalizedRequestId = String(requestId || "").trim();
  if (!REQUEST_ID_PATTERN.test(normalizedRequestId)) {
    throw new TypeError("Bot audit request ID is invalid.");
  }

  return {
    __bbtslRateLimitKey: database,
    prepare(sql) {
      const sourceSql = String(sql || "");
      const statement = database.prepare(sourceSql);
      if (!AUDIT_INSERT.test(sourceSql)) return statement;
      return createAuditStatement(database, statement, normalizedRequestId);
    },
    batch(statements) {
      return database.batch(statements);
    },
    exec(sql) {
      if (typeof database.exec !== "function") throw new TypeError("Database exec is unavailable.");
      return database.exec(sql);
    },
    dump() {
      if (typeof database.dump !== "function") throw new TypeError("Database dump is unavailable.");
      return database.dump();
    },
    withSession(...args) {
      if (typeof database.withSession !== "function") throw new TypeError("Database sessions are unavailable.");
      return database.withSession(...args);
    }
  };
}

function createAuditStatement(database, statement, requestId) {
  return {
    bind(...values) {
      const boundValues = [...values];
      if (boundValues.length < 12) {
        throw new TypeError("Audit insert bindings are incomplete.");
      }
      boundValues[6] = prefixSummary(boundValues[6]);
      const commitId = normalizeCommitId(boundValues[11]) || requestId;
      boundValues[11] = commitId;
      const auditStatement = statement.bind(...boundValues);
      const createdAt = new Date().toISOString();
      const sourceStatement = database.prepare(`
        INSERT INTO audit_sources (audit_log_id, source, source_request_id, created_at)
        SELECT id, ?, ?, ? FROM audit_logs WHERE commit_id = ?
        ON CONFLICT(audit_log_id) DO UPDATE SET
          source = excluded.source,
          source_request_id = excluded.source_request_id,
          created_at = excluded.created_at
      `).bind(SOURCE, requestId, createdAt, commitId);
      return createBoundAuditStatement(database, auditStatement, sourceStatement);
    }
  };
}

function createBoundAuditStatement(database, auditStatement, sourceStatement) {
  return {
    async run() {
      const results = await database.batch([auditStatement, sourceStatement]);
      return results?.[0];
    },
    async first() {
      throw new TypeError("Audit inserts do not support first().");
    },
    async all() {
      throw new TypeError("Audit inserts do not support all().");
    },
    async raw() {
      throw new TypeError("Audit inserts do not support raw().");
    }
  };
}

function prefixSummary(value) {
  const summary = String(value || "");
  return summary.startsWith("Discord Bot: ") ? summary : `Discord Bot: ${summary}`;
}

function normalizeCommitId(value) {
  if (value === null || value === undefined || value === "") return null;
  const commitId = String(value);
  if (!/^[A-Za-z0-9._:-]{8,96}$/.test(commitId)) {
    throw new TypeError("Audit commit ID is invalid.");
  }
  return commitId;
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new TypeError("A D1-compatible database is required for bot audit attribution.");
  }
}
