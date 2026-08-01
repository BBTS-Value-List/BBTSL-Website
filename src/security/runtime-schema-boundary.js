const CORE_SCHEMA_DDL = [
  /^CREATE TABLE IF NOT EXISTS (users|audit_logs)\b/i,
  /^CREATE INDEX IF NOT EXISTS (idx_users_role_sort|idx_audit_logs_created_at|idx_audit_logs_entity_public_id)\b/i
];
const CORE_ROLE_SORT_READ = /^SELECT id, role FROM users$/i;
const guardedDatabaseByDatabase = new WeakMap();

export function createRuntimeSchemaSafeDatabase(database) {
  if (!database || typeof database.prepare !== "function") {
    return database;
  }

  let guardedDatabase = guardedDatabaseByDatabase.get(database);
  if (guardedDatabase) return guardedDatabase;

  guardedDatabase = {
    prepare(sql) {
      if (isRuntimeCoreSchemaStatement(sql)) {
        return createNoopStatement();
      }
      return database.prepare(sql);
    },
    batch(statements) {
      if (typeof database.batch !== "function") {
        throw new TypeError("D1 batch is unavailable.");
      }
      return database.batch(statements);
    }
  };

  for (const method of ["exec", "dump", "withSession"]) {
    if (typeof database[method] === "function") {
      guardedDatabase[method] = (...args) => database[method](...args);
    }
  }

  guardedDatabaseByDatabase.set(database, guardedDatabase);
  return guardedDatabase;
}

export function isRuntimeCoreSchemaStatement(sql) {
  const normalized = String(sql || "").trim().replace(/\s+/g, " ");
  return CORE_ROLE_SORT_READ.test(normalized)
    || CORE_SCHEMA_DDL.some((pattern) => pattern.test(normalized));
}

function createNoopStatement() {
  const statement = {
    bind() {
      return statement;
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
    async all() {
      return { success: true, results: [], meta: {} };
    },
    async first() {
      return null;
    },
    async raw() {
      return [];
    }
  };
  return statement;
}
