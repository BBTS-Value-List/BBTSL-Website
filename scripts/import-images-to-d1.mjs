const [baseUrlArg, ownerKey] = process.argv.slice(2);

if (!baseUrlArg || !ownerKey) {
  console.error("Usage: node scripts/import-images-to-d1.mjs <base-url> <owner-api-key>");
  process.exit(1);
}

const baseUrl = baseUrlArg.replace(/\/+$/g, "");
const swordsResponse = await fetch(`${baseUrl}/api/swords`);
if (!swordsResponse.ok) {
  throw new Error(`Could not load swords from ${baseUrl}/api/swords (${swordsResponse.status})`);
}

const payload = await swordsResponse.json();
const swords = payload.swords || [];
const swordsWithImages = swords.filter((sword) => typeof sword.img === "string" && sword.img.startsWith("/images/"));

for (const sword of swordsWithImages) {
  const imageUrl = new URL(sword.img, `${baseUrl}/`).toString();
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Could not fetch ${imageUrl} (${imageResponse.status})`);
  }

  const contentType = imageResponse.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
  const imageKey = decodeURIComponent(sword.img.slice("/images/".length));

  const importResponse = await fetch(`${baseUrl}/api/owner/images/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-owner-key": ownerKey
    },
    body: JSON.stringify({
      key: imageKey,
      dataUrl
    })
  });

  if (!importResponse.ok) {
    const errorText = await importResponse.text();
    throw new Error(`Could not import ${imageKey}: ${importResponse.status} ${errorText}`);
  }

  console.log(`Imported ${imageKey}`);
}

console.log(`Imported ${swordsWithImages.length} images into D1 from ${baseUrl}.`);
