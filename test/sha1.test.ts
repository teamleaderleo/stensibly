import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sha1Hex } from "../src/sha1.ts";

describe("portable SHA-1", () => {
  test("matches the standard empty and abc vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("matches the runtime implementation across UTF-8 and block boundaries", () => {
    for (const input of [
      "safe\n",
      "你好, Stensibly 👋",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "x".repeat(65),
      "blob 5\0safe\n",
    ]) {
      expect(sha1Hex(input)).toBe(
        createHash("sha1").update(input, "utf8").digest("hex"),
      );
    }
  });
});
