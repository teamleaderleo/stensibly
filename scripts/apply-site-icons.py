from __future__ import annotations

import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = ROOT / ".github" / "icon-payload"

ASSETS = {
    "favicon.ico": "favicon.ico.b64",
    "favicon-32x32.png": "favicon-32x32.png.b64",
    "apple-touch-icon.png": "apple-touch-icon.png.b64",
    "icon-192.png": "icon-192.png.b64",
    "icon-512.png": "icon-512.png.b64",
}


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text()
    if source.count(old) != 1:
        raise RuntimeError(f"{path.relative_to(ROOT)} expected exactly one replacement target")
    path.write_text(source.replace(old, new))


for output_name, payload_name in ASSETS.items():
    encoded = (PAYLOAD / payload_name).read_text().strip()
    (ROOT / "site" / output_name).write_bytes(base64.b64decode(encoded, validate=True))

manifest = {
    "name": "Stensibly",
    "short_name": "Stensibly",
    "description": "Shared work for people and agents.",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "background_color": "#e9e5dd",
    "theme_color": "#70668b",
    "icons": [
        {
            "src": "/icon-192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any",
        },
        {
            "src": "/icon-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any",
        },
    ],
}
(ROOT / "site" / "site.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")

replace_once(
    ROOT / "site" / "index.html",
    '    <link rel="icon" href="/favicon.svg" />',
    '''    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
    <link rel="manifest" href="/site.webmanifest" />''',
)

replace_once(
    ROOT / "src" / "verify-dashboard.ts",
    '''    'content="Stensibly keeps shared work visible and resumable for people and agents."',
    'src="/hosted-session-bridge.js"', ''',
    '''    'content="Stensibly keeps shared work visible and resumable for people and agents."',
    'href="/favicon.ico"',
    'href="/favicon-32x32.png"',
    'href="/apple-touch-icon.png"',
    'href="/site.webmanifest"',
    'src="/hosted-session-bridge.js"', ''',
)

replace_once(
    ROOT / "test" / "verify-dashboard.test.ts",
    '''<meta name="description" content="Stensibly keeps shared work visible and resumable for people and agents." />
<link rel="stylesheet" href="/styles.css" />''',
    '''<meta name="description" content="Stensibly keeps shared work visible and resumable for people and agents." />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
<link rel="manifest" href="/site.webmanifest" />
<link rel="stylesheet" href="/styles.css" />''',
)

site_icons_test = r'''import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const siteUrl = new URL("../site/", import.meta.url);

const expectedHashes = {
  "favicon.ico": "d040295e82021f7d4bead39438515363fdf7d61083a86c4ae53ccc91e1e9acc3",
  "favicon-32x32.png": "e8b440831bbea4f311ad0fdc55213ba4d1763ecadfd54a70cf24c789747c92a4",
  "apple-touch-icon.png": "b5aec3ad83db8a0ee41af2915758623d6585b6f5d80f02cc963349244aedbdbe",
  "icon-192.png": "eb3d42dd145e3773079953051d3adac734cf366af15eb83351d4bd1c53fc0e8b",
  "icon-512.png": "73386088e47ed97200edeb71502bf1a57c6185849c7dab68a0f69d27894b1a60",
} as const;

describe("site icons", () => {
  test("uses the supplied artwork without an active SVG fallback", () => {
    const html = readFileSync(new URL("index.html", siteUrl), "utf8");

    for (const marker of [
      'href="/favicon.ico"',
      'href="/favicon-32x32.png"',
      'href="/apple-touch-icon.png"',
      'href="/site.webmanifest"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain('href="/favicon.svg"');
  });

  test("keeps the exact resized binary assets", () => {
    for (const [name, expectedHash] of Object.entries(expectedHashes)) {
      const bytes = readFileSync(new URL(name, siteUrl));
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(expectedHash);
    }
  });

  test("ships the expected PNG dimensions", () => {
    expect(readPngSize("favicon-32x32.png")).toEqual([32, 32]);
    expect(readPngSize("apple-touch-icon.png")).toEqual([180, 180]);
    expect(readPngSize("icon-192.png")).toEqual([192, 192]);
    expect(readPngSize("icon-512.png")).toEqual([512, 512]);
  });

  test("ships a multi-resolution ICO", () => {
    const bytes = readFileSync(new URL("favicon.ico", siteUrl));
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    const count = bytes.readUInt16LE(4);
    expect(count).toBe(6);

    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      const width = bytes[offset] === 0 ? 256 : bytes[offset]!;
      const height = bytes[offset + 1] === 0 ? 256 : bytes[offset + 1]!;
      expect(height).toBe(width);
      sizes.push(width);
    }
    expect(sizes).toEqual([16, 32, 48, 64, 128, 256]);
  });

  test("publishes install icons through the web manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("site.webmanifest", siteUrl), "utf8"),
    ) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };

    expect(manifest.name).toBe("Stensibly");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });
});

function readPngSize(name: string): [number, number] {
  const bytes = readFileSync(new URL(name, siteUrl));
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
'''
(ROOT / "test" / "site-icons.test.ts").write_text(site_icons_test)
