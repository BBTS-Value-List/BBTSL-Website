const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bytes = new Uint8Array(20);
crypto.getRandomValues(bytes);

let bits = 0;
let value = 0;
let output = "";

for (const byte of bytes) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    output += alphabet[(value >>> (bits - 5)) & 31];
    bits -= 5;
  }
}

if (bits > 0) {
  output += alphabet[(value << (5 - bits)) & 31];
}

console.log(output);
