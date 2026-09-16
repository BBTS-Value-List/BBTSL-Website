import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const [baseUrlArg, ownerApiKey, stateRootArg] = process.argv.slice(2);

if (!baseUrlArg || !ownerApiKey) {
  console.error("Usage: node scripts/import-r2-state-to-d1.mjs <base-url> <owner-api-key> [r2-state-root]");
  process.exit(1);
}

const baseUrl = baseUrlArg.replace(/\/+$/, "");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stateRoot = path.resolve(repoRoot, stateRootArg || ".wrangler/state/v3/r2");
const metadataDbPath = findMetadataDatabase(stateRoot);
const blobsRoot = findBlobsRoot(stateRoot);
const db = new DatabaseSync(metadataDbPath, { readonly: true });
const objects = db.prepare(`
  SELECT key, blob_id, http_metadata
  FROM _mf_objects
  WHERE blob_id IS NOT NULL
  ORDER BY key
`).all();
const batchSize = 10;

let imported = 0;
for (let index = 0; index < objects.length; index += batchSize) {
  const batch = [];
  const slice = objects.slice(index, index + batchSize);

  for (const object of slice) {
    const blobPath = path.join(blobsRoot, object.blob_id);
    if (!fs.existsSync(blobPath)) {
      console.warn(`Skipping ${object.key}: missing blob file ${object.blob_id}`);
      continue;
    }

    const contentType = parseContentType(object.http_metadata, object.key);
    const buffer = fs.readFileSync(blobPath);
    batch.push({
      key: object.key,
      dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`
    });
  }

  if (batch.length === 0) {
    continue;
  }

  const response = await fetch(`${baseUrl}/api/owner/images/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-owner-key": ownerApiKey
    },
    body: JSON.stringify({ items: batch })
  });

  if (!response.ok) {
    const text = await response.text();
    const firstKey = batch[0]?.key || "batch";
    throw new Error(`Could not import ${firstKey}: ${response.status} ${text}`);
  }

  imported += batch.length;
  console.log(`Imported batch ending with ${batch[batch.length - 1].key}`);
}

console.log(`Imported ${imported} images into D1 from local R2 state.`);

function findMetadataDatabase(root) {
  const bucketRoot = path.join(root, "miniflare-R2BucketObject");
  const candidates = fs.readdirSync(bucketRoot)
    .filter((entry) => entry.toLowerCase().endsWith(".sqlite"))
    .map((entry) => path.join(bucketRoot, entry));

  if (candidates.length === 0) {
    throw new Error(`Could not find Miniflare R2 metadata database under ${bucketRoot}`);
  }

  return candidates[0];
}

function findBlobsRoot(root) {
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "miniflare-R2BucketObject")
    .map((entry) => path.join(root, entry.name, "blobs"))
    .filter((entry) => fs.existsSync(entry));

  if (candidates.length === 0) {
    throw new Error(`Could not find Miniflare R2 blobs directory under ${root}`);
  }

  return candidates[0];
}

function parseContentType(rawHttpMetadata, key) {
  try {
    const parsed = JSON.parse(rawHttpMetadata || "{}");
    if (typeof parsed.contentType === "string" && parsed.contentType) {
      return parsed.contentType;
    }
  } catch {
    // Fall back to extension-based detection.
  }

  const lowerKey = String(key).toLowerCase();
  if (lowerKey.endsWith(".png")) {
    return "image/png";
  }
  if (lowerKey.endsWith(".jpg") || lowerKey.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerKey.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/webp";
}
