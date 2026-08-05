import { describe, expect, test } from "bun:test";
import {
  canonicalLogins,
  canonicalStringList,
} from "../src/github-provider-validation.ts";

describe("GitHub provider deterministic ordering", () => {
  test("orders canonical string lists by UTF-16 code unit", () => {
    expect(canonicalStringList(
      ["😀", "a", "é", "Z"],
      10,
      10,
    )).toEqual([
      "Z",
      "a",
      "é",
      "😀",
    ]);
  });

  test("normalizes and orders GitHub logins through the same comparator", () => {
    expect(canonicalLogins([
      "zeta",
      "Alpha",
      "a-1",
      "A0",
    ])).toEqual([
      "a-1",
      "a0",
      "alpha",
      "zeta",
    ]);
  });
});
