/**
 * Returns the lowercase hexadecimal SHA-1 digest for exact UTF-8 text.
 *
 * Git repositories using the original object format still identify blobs with
 * SHA-1. This implementation deliberately avoids Node-only APIs so canonical
 * Git evidence can be verified in Bun, workerd, browsers, and Convex.
 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3]! ^ words[index - 8]!
          ^ words[index - 14]! ^ words[index - 16]!,
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let functionValue: number;
      let constant: number;
      if (index < 20) {
        functionValue = (b & c) | (~b & d);
        constant = 0x5a827999;
      } else if (index < 40) {
        functionValue = b ^ c ^ d;
        constant = 0x6ed9eba1;
      } else if (index < 60) {
        functionValue = (b & c) | (b & d) | (c & d);
        constant = 0x8f1bbcdc;
      } else {
        functionValue = b ^ c ^ d;
        constant = 0xca62c1d6;
      }
      const next = (
        rotateLeft(a, 5) + functionValue + e + constant + words[index]!
      ) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}
