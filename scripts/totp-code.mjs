const secret = (process.argv[2] || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
if (!secret) {
  console.error("Usage: node scripts/totp-code.mjs <BASE32_SECRET>");
  process.exit(1);
}

const secretBytes = decodeBase32(secret);
const counter = Math.floor(Date.now() / 1000 / 30);
console.log(await generateTotp(secretBytes, counter, 6));

async function generateTotp(secretBytes, counter, digits) {
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  const high = Math.floor(counter / 2 ** 32);
  const low = counter >>> 0;
  view.setUint32(0, high);
  view.setUint32(4, low);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function decodeBase32(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const output = [];

  for (const char of input) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) {
      throw new Error("Invalid base32 secret.");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}
