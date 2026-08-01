import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { minify } from "terser";

const ROOT = new URL("../", import.meta.url);
const TARGETS = [
  { source: "public/app.js", output: "public/app.min.js" },
  { source: "public/team.js", output: "public/team.min.js" },
  { source: "public/consent.js", output: "public/consent.min.js" }
];

for (const target of TARGETS) {
  const sourceUrl = new URL(target.source, ROOT);
  const outputUrl = new URL(target.output, ROOT);
  const input = await readFile(sourceUrl, "utf8");
  const result = await minify(input, {
    compress: {
      passes: 2
    },
    format: {
      comments: false
    },
    module: true,
    mangle: true
  });
  if (!result.code) {
    throw new Error(`Terser returned no output for ${target.source}`);
  }
  await writeFile(outputUrl, `${result.code}\n`, "utf8");
  console.log(`Built ${fileURLToPath(outputUrl)}`);
}
