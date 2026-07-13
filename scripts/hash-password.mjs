import crypto from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("Usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}

const hash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
console.log(hash);
