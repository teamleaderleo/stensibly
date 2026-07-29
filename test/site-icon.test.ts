import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const siteUrl = new URL("../site/", import.meta.url);
const expectedHash = "ce9c88893bc8c54013422d0f30491d1c8e0f388a8419b487d700420fc0e7ef78";

describe("site favicon", () => {
  test("uses the supplied artwork as the active browser icon", () => {
    const html = readFileSync(new URL("index.html", siteUrl), "utf8");
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
    expect(html).not.toContain('href="/favicon.svg"');
  });

  test("keeps the exact resized favicon payload", () => {
    const bytes = readFileSync(new URL("favicon.ico", siteUrl));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
  });

  test("contains 16, 32, and 48 pixel icon entries", () => {
    const bytes = readFileSync(new URL("favicon.ico", siteUrl));
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);

    const count = bytes.readUInt16LE(4);
    expect(count).toBe(3);

    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      const width = bytes[offset] === 0 ? 256 : bytes[offset]!;
      const height = bytes[offset + 1] === 0 ? 256 : bytes[offset + 1]!;
      expect(height).toBe(width);
      sizes.push(width);
    }

    expect(sizes).toEqual([16, 32, 48]);
  });
});
