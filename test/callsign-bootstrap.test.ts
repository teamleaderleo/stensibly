import { describe, expect, test } from "bun:test";
import {
  callsignBootstrapCandidates,
  callsignBootstrapCategories,
} from "../src/callsign-bootstrap.ts";
import { callsignCollisionKey } from "../src/callsign-suggestions.ts";

describe("callsign bootstrap pool", () => {
  test("offers a broad category vocabulary with deterministic unique candidates", () => {
    expect(callsignBootstrapCategories).toEqual([
      "animal",
      "food",
      "object",
      "concept",
      "nature",
      "science",
      "sport",
      "verb",
      "word",
      "internet",
      "myth",
      "gibberish",
      "literary",
      "language",
    ]);

    const first = callsignBootstrapCandidates({ seed: "worker/session/alpha", count: 32 });
    const replay = callsignBootstrapCandidates({ seed: "worker/session/alpha", count: 32 });
    expect(first).toEqual(replay);
    expect(first.category).toBe("any");
    expect(first.candidates).toHaveLength(32);
    expect(new Set(first.candidates.map((candidate) => candidate.collisionKey)).size).toBe(32);
    expect(first.candidates.every((candidate) =>
      callsignCollisionKey(candidate.callsign) === candidate.collisionKey
    )).toBe(true);
    expect(new Set(first.candidates.map((candidate) => candidate.category)).size).toBeGreaterThan(4);
    expect(first).toMatchObject({
      reservesCallsign: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
  });

  test("honors a broad category hint without turning it into identity semantics", () => {
    for (const category of ["food", "science", "sport", "gibberish", "language"] as const) {
      const result = callsignBootstrapCandidates({
        seed: `category/${category}`,
        category,
        count: 12,
      });
      expect(result.category).toBe(category);
      expect(result.candidates).toHaveLength(12);
      expect(result.candidates.every((candidate) => candidate.category === category)).toBe(true);
      expect(result.grantsAuthority).toBe(false);
    }
  });

  test("excludes caller-supplied collision keys and fails only when none remain", () => {
    const baseline = callsignBootstrapCandidates({ seed: "avoidance", category: "food", count: 12 });
    const avoided = baseline.candidates.slice(0, 5).map((candidate) => candidate.callsign);
    const filtered = callsignBootstrapCandidates({
      seed: "avoidance",
      category: "food",
      avoid: avoided,
      count: 12,
    });
    const avoidedKeys = new Set(avoided.map(callsignCollisionKey));
    expect(filtered.candidates.some((candidate) => avoidedKeys.has(candidate.collisionKey))).toBe(false);

    const allFood = callsignBootstrapCandidates({ seed: "all-food", category: "food", count: 24 });
    expect(() => callsignBootstrapCandidates({
      seed: "all-food",
      category: "food",
      avoid: allFood.candidates.map((candidate) => candidate.callsign),
    })).toThrow("No callsign bootstrap candidates remain");
  });
});
