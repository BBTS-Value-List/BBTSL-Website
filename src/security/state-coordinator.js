const PRIVATE_API_CLIENT_HEADER = "x-bbtsl-api-client";
const SITE_STATE_KEY = "__system/site-state.json";
const STATE_MERGE_TOKEN_PREFIX = "__system/__state-merge/";
const STATE_LOCK_TABLE = "site_state_mutation_locks";
const STATE_LOCK_NAME = "site-state";
const DEFAULT_LOCK_LEASE_MS = 120_000;
const DEFAULT_LOCK_RENEWAL_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 75;
const DEFAULT_LOCK_MAX_ATTEMPTS = 8;
const MAX_LOCK_RETRY_DELAY_MS = 500;
const R2_CLASS_A_LIMIT = 1_000_000;
const R2_CLASS_B_LIMIT = 10_000_000;
const R2_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_SITE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_SITE_SWORDS = 500;
const MAX_SITE_BASELINE_ROWS = 500;
const MAX_SITE_MEDIA_VARIANTS = 2_000;
const MAX_SITE_MEDIA_OBJECTS = 5_000;

export class SiteStateQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteStateQuotaError";
    this.status = 507;
  }
}

export class SiteStateLockError extends Error {
  constructor(message = "Site data is busy. Try again shortly.") {
    super(message);
    this.name = "SiteStateLockError";
    this.status = 503;
  }
}

export function getPrivateApiClientBoundaryDecision(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" || !isProtectedPrivateApiPath(url.pathname)) {
    return "delegate";
  }

  const clientId = String(request.headers.get(PRIVATE_API_CLIENT_HEADER) || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(clientId)) {
    return "delegate";
  }

  const rawSecrets = String(env.V1_API_CLIENT_SECRETS || "").trim();
  if (!rawSecrets) {
    return "delegate";
  }

  let parsed;
  try {
    parsed = JSON.parse(rawSecrets);
  } catch {
    return "delegate";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "delegate";
  }

  if (!Object.hasOwn(parsed, clientId)) {
    return "deny";
  }
  const secret = parsed[clientId];
  return typeof secret === "string" && secret.trim() ? "delegate" : "deny";
}

export function isSiteStateMutationRequest(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (method === "POST") {
    return pathname === "/api/swords"
      || pathname === "/api/swords/commit"
      || pathname === "/api/media"
      || pathname === "/api/reset"
      || pathname === "/api/audit/revert"
      || pathname === "/api/internal/media-reconcile";
  }
  if (method === "PUT") {
    return /^\/api\/swords\/commit\/\d+$/.test(pathname) || /^\/api\/swords\/\d+$/.test(pathname);
  }
  if (method === "DELETE") {
    return /^\/api\/swords\/\d+$/.test(pathname);
  }
  return false;
}

export async function withSiteStateMutationLock(env, fn, options = {}) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new TypeError("A D1 binding is required for site-state mutation locking.");
  }
  if (typeof fn !== "function") {
    throw new TypeError("A site-state mutation callback is required.");
  }

  const leaseMs = normalizePositiveInteger(options.leaseMs, DEFAULT_LOCK_LEASE_MS);
  const renewalMs = Math.min(
    normalizePositiveInteger(options.renewalMs, Math.min(DEFAULT_LOCK_RENEWAL_MS, Math.max(1, Math.floor(leaseMs / 3)))),
    Math.max(1, leaseMs - 1)
  );
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_LOCK_MAX_ATTEMPTS);
  const ownerToken = crypto.randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const now = Date.now();
    const shouldAttempt = attempt === 0 || await isLockAvailable(env.DB, now);
    if (shouldAttempt) {
      const row = await tryAcquireLock(env.DB, ownerToken, now, leaseMs);
      if (row?.owner_token === ownerToken) {
        acquired = true;
        break;
      }
    }
    if (attempt + 1 < maxAttempts) {
      const delayMs = Math.min(MAX_LOCK_RETRY_DELAY_MS, retryDelayMs * (2 ** Math.min(attempt, 4)));
      await sleep(delayMs);
    }
  }

  if (!acquired) {
    throw new SiteStateLockError();
  }

  const lease = createLeaseController(env.DB, ownerToken, leaseMs, renewalMs);
  try {
    return await fn(lease);
  } finally {
    await lease.stop();
    await env.DB.prepare(`
      DELETE FROM ${STATE_LOCK_TABLE}
      WHERE lock_name = ? AND owner_token = ?
    `).bind(STATE_LOCK_NAME, ownerToken).run();
  }
}

export function createStateMutationBucket(bucket, options = {}) {
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") {
    throw new TypeError("An R2 media bucket with get and put methods is required.");
  }

  const baselineByToken = new Map();
  let stateWriteQueue = Promise.resolve();
  const adapter = {};

  adapter.get = async (key, ...args) => {
    const object = await bucket.get(key, ...args);
    if (key !== SITE_STATE_KEY || !object) {
      return object;
    }
    const rawState = JSON.parse(await object.text());
    const baseline = removeStateMergeTokens(cloneJson(rawState));
    const token = `${STATE_MERGE_TOKEN_PREFIX}${crypto.randomUUID()}`;
    baselineByToken.set(token, baseline);
    const taggedState = cloneJson(baseline);
    taggedState.mediaObjects = {
      ...(taggedState.mediaObjects || {}),
      [token]: {
        mediaKey: token,
        contentType: "application/x-bbtsl-state-merge-token",
        sizeBytes: 0
      }
    };
    return createTextOverrideObject(object, JSON.stringify(taggedState));
  };

  adapter.put = (key, value, putOptions) => {
    if (key !== SITE_STATE_KEY || typeof value !== "string") {
      return bucket.put(key, value, putOptions);
    }
    const write = async () => {
      try {
        const incoming = JSON.parse(value);
        const token = findStateMergeToken(incoming);
        const baseline = token ? baselineByToken.get(token) : null;
        const cleanIncoming = removeStateMergeTokens(incoming);
        if (token) baselineByToken.delete(token);

        if (!baseline) {
          const serialized = JSON.stringify(cleanIncoming);
          assertSiteStateWithinLimits(cleanIncoming, serialized);
          await options.lock?.assertActive?.();
          return bucket.put(key, serialized, putOptions);
        }

        const latestObject = await bucket.get(key);
        const latest = latestObject
          ? removeStateMergeTokens(JSON.parse(await latestObject.text()))
          : cloneJson(baseline);
        const merged = mergeSiteState(latest, baseline, cleanIncoming);
        assertUsageWithinLimits(merged.usage);
        const serialized = JSON.stringify(merged);
        assertSiteStateWithinLimits(merged, serialized);
        await options.lock?.assertActive?.();
        return bucket.put(key, serialized, putOptions);
      } catch (error) {
        options.onStateError?.(error);
        throw error;
      }
    };
    const result = stateWriteQueue.then(write, write);
    stateWriteQueue = result.catch(() => {});
    return result;
  };

  for (const method of ["delete", "head", "list", "createMultipartUpload", "resumeMultipartUpload"]) {
    if (typeof bucket[method] === "function") {
      adapter[method] = (...args) => bucket[method](...args);
    }
  }

  return adapter;
}

function createTextOverrideObject(object, text) {
  const result = {
    key: object.key,
    version: object.version,
    size: new TextEncoder().encode(text).byteLength,
    etag: object.etag,
    httpEtag: object.httpEtag,
    checksums: object.checksums,
    uploaded: object.uploaded,
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    range: object.range,
    storageClass: object.storageClass,
    body: object.body,
    bodyUsed: object.bodyUsed,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
    async blob() {
      return new Blob([text], { type: "application/json" });
    }
  };
  if (typeof object.writeHttpMetadata === "function") {
    result.writeHttpMetadata = (headers) => object.writeHttpMetadata(headers);
  }
  return result;
}

export function assertSiteStateWithinLimits(state, serialized = JSON.stringify(state)) {
  if ((state?.swords || []).length > MAX_SITE_SWORDS) {
    throw new SiteStateQuotaError(`Site state cannot contain more than ${MAX_SITE_SWORDS} swords.`);
  }
  if ((state?.baseline || []).length > MAX_SITE_BASELINE_ROWS) {
    throw new SiteStateQuotaError(`Site state cannot contain more than ${MAX_SITE_BASELINE_ROWS} baseline rows.`);
  }
  if (Object.keys(state?.mediaVariants || {}).length > MAX_SITE_MEDIA_VARIANTS) {
    throw new SiteStateQuotaError(`Site state cannot contain more than ${MAX_SITE_MEDIA_VARIANTS} media variant sets.`);
  }
  if (Object.keys(state?.mediaObjects || {}).length > MAX_SITE_MEDIA_OBJECTS) {
    throw new SiteStateQuotaError(`Site state cannot contain more than ${MAX_SITE_MEDIA_OBJECTS} media objects.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SITE_STATE_BYTES) {
    throw new SiteStateQuotaError(`Site state cannot exceed ${MAX_SITE_STATE_BYTES} bytes.`);
  }
}

async function tryAcquireLock(database, ownerToken, now, leaseMs) {
  return database.prepare(`
    INSERT INTO ${STATE_LOCK_TABLE} (lock_name, owner_token, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_token = excluded.owner_token,
      expires_at = excluded.expires_at
    WHERE ${STATE_LOCK_TABLE}.expires_at <= ?
    RETURNING owner_token
  `).bind(STATE_LOCK_NAME, ownerToken, now + leaseMs, now).first();
}

async function isLockAvailable(database, now) {
  try {
    const row = await database.prepare(`
      SELECT expires_at
      FROM ${STATE_LOCK_TABLE}
      WHERE lock_name = ?
    `).bind(STATE_LOCK_NAME).first();
    return !row || Number(row.expires_at || 0) <= now;
  } catch {
    return true;
  }
}

function createLeaseController(database, ownerToken, leaseMs, renewalMs) {
  let stopped = false;
  let stopResolve;
  let renewalError = null;
  let renewalChain = Promise.resolve();
  const stopSignal = new Promise((resolve) => {
    stopResolve = resolve;
  });

  const renew = async () => {
    const now = Date.now();
    const row = await database.prepare(`
      UPDATE ${STATE_LOCK_TABLE}
      SET expires_at = ?
      WHERE lock_name = ? AND owner_token = ? AND expires_at > ?
      RETURNING owner_token
    `).bind(now + leaseMs, STATE_LOCK_NAME, ownerToken, now).first();
    if (row?.owner_token !== ownerToken) {
      throw new SiteStateLockError("Site data lock was lost before the mutation completed.");
    }
  };

  const queueRenewal = () => {
    renewalChain = renewalChain.then(renew).catch((error) => {
      renewalError = error instanceof SiteStateLockError
        ? error
        : new SiteStateLockError("Site data lock could not be renewed.");
      throw renewalError;
    });
    return renewalChain;
  };

  const loop = (async () => {
    while (!stopped) {
      const shouldStop = await Promise.race([
        sleep(renewalMs).then(() => false),
        stopSignal.then(() => true)
      ]);
      if (shouldStop || stopped) {
        return;
      }
      try {
        await queueRenewal();
      } catch {
        return;
      }
    }
  })();

  return {
    ownerToken,
    async assertActive() {
      if (renewalError) {
        throw renewalError;
      }
      await queueRenewal();
      if (renewalError) {
        throw renewalError;
      }
    },
    async stop() {
      stopped = true;
      stopResolve();
      await loop;
      await renewalChain.catch(() => {});
    }
  };
}

function isProtectedPrivateApiPath(pathname) {
  return pathname === "/api/v1/swords"
    || pathname === "/api/v1/team"
    || pathname.startsWith("/api/v1/swords/");
}

function findStateMergeToken(state) {
  return Object.keys(state?.mediaObjects || {}).find((key) => key.startsWith(STATE_MERGE_TOKEN_PREFIX)) || "";
}

function removeStateMergeTokens(state) {
  if (!state || typeof state !== "object") {
    return state;
  }
  const mediaObjects = Object.fromEntries(
    Object.entries(state.mediaObjects || {}).filter(([key]) => !key.startsWith(STATE_MERGE_TOKEN_PREFIX))
  );
  return {
    ...state,
    mediaObjects
  };
}

function mergeSiteState(latest, baseline, incoming) {
  return {
    ...latest,
    version: incoming.version ?? latest.version ?? baseline.version ?? 1,
    swords: mergeRecordArray(latest.swords, baseline.swords, incoming.swords, "id"),
    baseline: mergeRecordArray(latest.baseline, baseline.baseline, incoming.baseline, "id"),
    mediaVariants: mergeRecordMap(latest.mediaVariants, baseline.mediaVariants, incoming.mediaVariants),
    mediaObjects: mergeRecordMap(latest.mediaObjects, baseline.mediaObjects, incoming.mediaObjects),
    usage: mergeUsage(latest.usage, baseline.usage, incoming.usage)
  };
}

function mergeRecordArray(latestRows = [], baselineRows = [], incomingRows = [], idField) {
  const latest = new Map(latestRows.map((row) => [String(row?.[idField]), cloneJson(row)]));
  const baseline = new Map(baselineRows.map((row) => [String(row?.[idField]), row]));
  const incoming = new Map(incomingRows.map((row) => [String(row?.[idField]), row]));
  const candidateIds = new Set([...baseline.keys(), ...incoming.keys()]);

  for (const id of candidateIds) {
    const before = baseline.get(id);
    const after = incoming.get(id);
    if (jsonEqual(before, after)) {
      continue;
    }
    if (after === undefined) {
      latest.delete(id);
    } else {
      latest.set(id, cloneJson(after));
    }
  }

  return [...latest.values()].sort((left, right) => Number(left?.[idField] || 0) - Number(right?.[idField] || 0));
}

function mergeRecordMap(latestMap = {}, baselineMap = {}, incomingMap = {}) {
  const merged = cloneJson(latestMap || {});
  const candidateKeys = new Set([...Object.keys(baselineMap || {}), ...Object.keys(incomingMap || {})]);

  for (const key of candidateKeys) {
    const before = baselineMap?.[key];
    const after = incomingMap?.[key];
    if (jsonEqual(before, after)) {
      continue;
    }
    if (after === undefined) {
      delete merged[key];
    } else {
      merged[key] = cloneJson(after);
    }
  }
  return merged;
}

function mergeUsage(latestUsage = {}, baselineUsage = {}, incomingUsage = {}) {
  const latestMonthly = latestUsage.monthly || {};
  const baselineMonthly = baselineUsage.monthly || {};
  const incomingMonthly = incomingUsage.monthly || {};
  const monthly = cloneJson(latestMonthly);
  const periods = new Set([...Object.keys(baselineMonthly), ...Object.keys(incomingMonthly)]);

  for (const period of periods) {
    const latestRow = latestMonthly[period] || {};
    const before = baselineMonthly[period] || {};
    const after = incomingMonthly[period] || {};
    const classADelta = Number(after.classACount || 0) - Number(before.classACount || 0);
    const classBDelta = Number(after.classBCount || 0) - Number(before.classBCount || 0);
    if (!classADelta && !classBDelta && jsonEqual(before, after)) {
      continue;
    }
    monthly[period] = {
      ...latestRow,
      classACount: Number(latestRow.classACount || 0) + classADelta,
      classBCount: Number(latestRow.classBCount || 0) + classBDelta,
      updatedAt: after.updatedAt || latestRow.updatedAt || before.updatedAt || ""
    };
  }

  const storageDelta = Number(incomingUsage.totalStorageBytes || 0) - Number(baselineUsage.totalStorageBytes || 0);
  return {
    ...latestUsage,
    monthly,
    totalStorageBytes: Number(latestUsage.totalStorageBytes || 0) + storageDelta
  };
}

function assertUsageWithinLimits(usage = {}) {
  for (const row of Object.values(usage.monthly || {})) {
    if (Number(row?.classACount || 0) > R2_CLASS_A_LIMIT) {
      throw new SiteStateQuotaError("R2 Class A limit reached for the current month.");
    }
    if (Number(row?.classBCount || 0) > R2_CLASS_B_LIMIT) {
      throw new SiteStateQuotaError("R2 Class B limit reached for the current month.");
    }
  }
  if (Number(usage.totalStorageBytes || 0) > R2_STORAGE_LIMIT_BYTES) {
    throw new SiteStateQuotaError("R2 storage limit reached.");
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
