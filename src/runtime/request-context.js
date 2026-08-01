import { createTrackedR2Bucket } from "../security/r2-usage-boundary.js";
import { createRuntimeSchemaSafeDatabase } from "../security/runtime-schema-boundary.js";

export function createRequestContext(env = {}, executionContext = {}, options = {}) {
  const bindings = { ...env };
  const db = createRuntimeSchemaSafeDatabase(env.DB);
  const mediaBucket = createTrackedR2Bucket(env.MEDIA_BUCKET, db, options.r2Usage);
  const quarantineBucket = createTrackedR2Bucket(env.MEDIA_QUARANTINE_BUCKET, db, options.r2Usage);

  return {
    db,
    assets: env.ASSETS,
    mediaBucket,
    quarantineBucket,
    executionContext,
    bindings
  };
}

export function createRuntimeEnvironment(context, overrides = {}) {
  return {
    ...context.bindings,
    DB: context.db,
    ASSETS: context.assets,
    MEDIA_BUCKET: context.mediaBucket,
    MEDIA_QUARANTINE_BUCKET: context.quarantineBucket,
    ...overrides
  };
}
