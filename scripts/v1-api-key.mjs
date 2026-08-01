import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [clientId, explicitSecret, explicitDate] = process.argv.slice(2);

if (!clientId) {
  console.error("Usage: node scripts/v1-api-key.mjs <client-id> [base-secret] [YYYY-MM-DD]");
  process.exit(1);
}

const baseSecret = explicitSecret || loadClientSecretFromDevVars(clientId);
if (!baseSecret) {
  console.error(`No base secret found for client "${clientId}". Pass it explicitly or add V1_API_CLIENT_SECRETS to .dev.vars.`);
  process.exit(1);
}

const date = explicitDate || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Date must use YYYY-MM-DD.");
  process.exit(1);
}

const key = crypto
  .createHmac("sha256", baseSecret)
  .update(`bbtsl-v1:${clientId}:${date}`)
  .digest("hex")
  .slice(0, 32);

console.log(`Client: ${clientId}`);
console.log(`Date:   ${date}`);
console.log(`Key:    ${key}`);
console.log("");
console.log("Headers:");
console.log(`x-bbtsl-api-client: ${clientId}`);
console.log(`x-bbtsl-api-date: ${date}`);
console.log(`authorization: Bearer ${key}`);
console.log("");
console.log("Example:");
console.log(`curl -H "x-bbtsl-api-client: ${clientId}" -H "x-bbtsl-api-date: ${date}" -H "authorization: Bearer ${key}" "https://bbtsl.lol/api/v1/swords"`);

function loadClientSecretFromDevVars(targetClientId) {
  const devVarsPath = path.resolve(process.cwd(), ".dev.vars");
  if (!fs.existsSync(devVarsPath)) {
    return "";
  }
  const content = fs.readFileSync(devVarsPath, "utf8");
  const line = content.split(/\r?\n/).find((entry) => entry.startsWith("V1_API_CLIENT_SECRETS="));
  if (!line) {
    return "";
  }
  const rawValue = line.slice("V1_API_CLIENT_SECRETS=".length).trim();
  if (!rawValue) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, targetClientId)) {
      return "";
    }
    return typeof parsed[targetClientId] === "string" ? parsed[targetClientId].trim() : "";
  } catch {
    return "";
  }
}
