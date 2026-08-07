import { describe, expect, test } from "bun:test";
import {
  compareCodeUnits as canonicalCompareCodeUnits,
  stableJson,
} from "../src/canonical-json.ts";
import { compareCodeUnits } from "../src/code-unit-order.ts";

describe("runtime-neutral code-unit ordering", () => {
  test("compares exact UTF-16 code units", () => {
    expect(compareCodeUnits("a", "a")).toBe(0);
    expect(compareCodeUnits("a", "b")).toBe(-1);
    expect(compareCodeUnits("b", "a")).toBe(1);

    const astral = "\u{10000}";
    const privateUse = "\uE000";
    expect(astral.codePointAt(0)).toBeGreaterThan(privateUse.codePointAt(0)!);
    expect(compareCodeUnits(astral, privateUse)).toBe(-1);
    expect([privateUse, astral].sort(compareCodeUnits)).toEqual([
      astral,
      privateUse,
    ]);
  });

  test("keeps canonical JSON on the exact shared comparator", () => {
    expect(canonicalCompareCodeUnits).toBe(compareCodeUnits);

    const astral = "\u{10000}";
    const privateUse = "\uE000";
    expect(stableJson({ [privateUse]: 2, [astral]: 1 })).toBe(
      `{${JSON.stringify(astral)}:1,${JSON.stringify(privateUse)}:2}`,
    );
  });
});
