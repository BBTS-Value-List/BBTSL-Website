const R2_USAGE_TABLE = "r2_usage_counters";
const R2_CLASS_A_LIMIT = 1_000_000;
const R2_CLASS_B_LIMIT = 10_000_000;

const CLASS_A_METHODS = ["put", "delete", "list", "createMultipartUpload"];
const CLASS_B_METHODS = ["get", "head"];
const PASS_THROUGH_METHODS = ["resumeMultipartUpload"];

export class R2UsageQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "R2UsageQuotaError";
    this.status = 507;
  }
}

export function createTrackedR2Bucket(bucket, database, options = {}) {
  if (!bucket || (typeof bucket !== "object" && typeof bucket !== "function")) {
    return bucket;
  }
  if (!database || typeof database.prepare !== "function") {
    return bucket;
  }

  const tracked = {};
  for (const method of CLASS_A_METHODS) {
    if (typeof bucket[method] !== "function") continue;
    tracked[method] = async (...args) => {
      await reserveR2Operation(database, 1, 0, options);
      return bucket[method](...args);
    };
  }
  for (const method of CLASS_B_METHODS) {
    if (typeof bucket[method] !== "function") continue;
    tracked[method] = async (...args) => {
      await reserveR2Operation(database, 0, 1, options);
      return bucket[method](...args);
    };
  }
  for (const method of PASS_THROUGH_METHODS) {
    if (typeof bucket[method] === "function") {
      tracked[method] = (...args) => bucket[method](...args);
    }
  }
  return tracked;
}

export async function reserveR2Operation(database, classADelta, classBDelta, options = {}) {
  const normalizedClassA = normalizeDelta(classADelta);
  const normalizedClassB = normalizeDelta(classBDelta);
  const classALimit = normalizeLimit(options.classALimit, R2_CLASS_A_LIMIT);
  const classBLimit = normalizeLimit(options.classBLimit, R2_CLASS_B_LIMIT);
  const period = normalizePeriod(options.period);
  const updatedAt = new Date().toISOString();

  if (!normalizedClassA && !normalizedClassB) {
    return readUsage(database, period);
  }

  const row = await database.prepare(`
    INSERT INTO ${R2_USAGE_TABLE} (period, class_a_count, class_b_count, updated_at)
    SELECT ?, ?, ?, ?
    WHERE ? <= ? AND ? <= ?
    ON CONFLICT(period) DO UPDATE SET
      class_a_count = ${R2_USAGE_TABLE}.class_a_count + excluded.class_a_count,
      class_b_count = ${R2_USAGE_TABLE}.class_b_count + excluded.class_b_count,
      updated_at = excluded.updated_at
    WHERE ${R2_USAGE_TABLE}.class_a_count + excluded.class_a_count <= ?
      AND ${R2_USAGE_TABLE}.class_b_count + excluded.class_b_count <= ?
    RETURNING class_a_count, class_b_count
  `).bind(
    period,
    normalizedClassA,
    normalizedClassB,
    updatedAt,
    normalizedClassA,
    classALimit,
    normalizedClassB,
    classBLimit,
    classALimit,
    classBLimit
  ).first();

  if (!row) {
    const current = await readUsage(database, period);
    if (current.classACount + normalizedClassA > classALimit) {
      throw new R2UsageQuotaError("R2 Class A operation limit reached for the current month.");
    }
    if (current.classBCount + normalizedClassB > classBLimit) {
      throw new R2UsageQuotaError("R2 Class B operation limit reached for the current month.");
    }
    throw new R2UsageQuotaError("R2 operation limit reached for the current month.");
  }

  return serializeUsageRow(row);
}

export async function flushR2Usage(database, options = {}) {
  return readUsage(database, normalizePeriod(options.period));
}

async function readUsage(database, period) {
  const row = await database.prepare(`
    SELECT class_a_count, class_b_count
    FROM ${R2_USAGE_TABLE}
    WHERE period = ?
  `).bind(period).first();
  return serializeUsageRow(row);
}

function serializeUsageRow(row) {
  return {
    classACount: Math.max(0, Number(row?.class_a_count || 0)),
    classBCount: Math.max(0, Number(row?.class_b_count || 0))
  };
}

function normalizeDelta(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("R2 usage deltas must be non-negative safe integers.");
  }
  return number;
}

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("R2 usage limits must be non-negative safe integers.");
  }
  return number;
}

function normalizePeriod(value) {
  if (value === undefined || value === null || value === "") {
    return getCurrentUsagePeriodKey();
  }
  const normalized = String(value);
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw new TypeError("R2 usage period must use YYYY-MM format.");
  }
  return normalized;
}

function getCurrentUsagePeriodKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
