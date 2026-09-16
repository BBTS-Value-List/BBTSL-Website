import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const scope = args.includes("--remote") ? "--remote" : "--local";
const databaseName = args.find((value) => !value.startsWith("--")) || "bladeball-value-list";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const seedFile = path.join(repoRoot, "tmp-d1-seed.sql");

const command = [
  "npx",
  "wrangler",
  "d1",
  "execute",
  `"${databaseName}"`,
  scope,
  "--file",
  `"${seedFile}"`
].join(" ");

execSync(command, {
  cwd: repoRoot,
  stdio: "inherit"
});
