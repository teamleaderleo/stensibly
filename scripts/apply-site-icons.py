from __future__ import annotations

import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text()
    if source.count(old) != 1:
        raise RuntimeError(f"{path.relative_to(ROOT)} expected exactly one replacement target")
    path.write_text(source.replace(old, new))


payload = (ROOT / "scripts" / "favicon.ico.b64").read_text().strip()
(ROOT / "site" / "favicon.ico").write_bytes(base64.b64decode(payload, validate=True))

replace_once(
    ROOT / "site" / "index.html",
    '    <link rel="icon" href="/favicon.svg" />',
    '    <link rel="icon" href="/favicon.ico" sizes="any" />',
)

replace_once(
    ROOT / "src" / "verify-dashboard.ts",
    '    \'content="Stensibly keeps shared work visible and resumable for people and agents."\',',
    '    \'content="Stensibly keeps shared work visible and resumable for people and agents."\',\n    \'href="/favicon.ico"\',',
)

replace_once(
    ROOT / "test" / "verify-dashboard.test.ts",
    '''<meta name="description" content="Stensibly keeps shared work visible and resumable for people and agents." />
<link rel="stylesheet" href="/styles.css" />''',
    '''<meta name="description" content="Stensibly keeps shared work visible and resumable for people and agents." />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="stylesheet" href="/styles.css" />''',
)

site_icon_test = r'''import { createHash } from "node:crypto";
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
'''
(ROOT / "test" / "site-icon.test.ts").write_text(site_icon_test)
