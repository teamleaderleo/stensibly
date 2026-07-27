import { describe, expect, test } from "bun:test";
import {
  baseCallsignCategories,
  callsignCollisionKey,
  callsignPools,
  suggestCallsign,
  suggestCallsigns,
} from "../src/callsign-suggestions.ts";
import {
  callsignUsage,
  formatCallsignSuggestions,
  parseCallsignCliArgs,
} from "../src/callsigns.ts";

describe("callsign suggestions", () => {
  test("replays deterministically regardless of avoid-list order", () => {
    const first = suggestCallsigns({
      count: 8,
      seed: "same entrant",
      avoid: ["Nightjar", "Teacup", "Lantern"],
    });
    const second = suggestCallsigns({
      count: 8,
      seed: "same entrant",
      avoid: ["Lantern", "night-jar", "tea_cup"],
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      seedSource: "explicit",
      reservesCallsign: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
    expect(first.seedFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.suggestions).toHaveLength(8);
    expect(new Set(first.suggestions.map((entry) => entry.collisionKey)).size).toBe(8);
  });

  test("normalises case and separators for collision detection", () => {
    expect(callsignCollisionKey("Nightjar")).toBe("nightjar");
    expect(callsignCollisionKey("night-jar")).toBe("nightjar");
    expect(callsignCollisionKey("NIGHT_JAR")).toBe("nightjar");
    expect(callsignCollisionKey(" night jar ")).toBe("nightjar");
  });

  test("returns category diversity before repeating a pool", () => {
    const result = suggestCallsigns({ count: 4, seed: "diverse" });
    expect(result.suggestions.every((entry) => entry.source === "curated")).toBe(true);
    expect(new Set(result.suggestions.map((entry) => entry.category))).toEqual(
      new Set(baseCallsignCategories),
    );
  });

  test("uses category preferences first without restricting fallback", () => {
    const result = suggestCallsigns({
      count: 4,
      seed: "objects first",
      categories: ["object"],
    });
    expect(result.suggestions[0]?.category).toBe("object");
    expect(new Set(result.suggestions.map((entry) => entry.category)).size).toBe(4);
  });

  test("falls back to bounded compound names after curated pools are exhausted", () => {
    const avoid = Object.values(callsignPools).flat();
    const result = suggestCallsigns({ count: 5, seed: "compound", avoid });
    expect(result.suggestions).toHaveLength(5);
    expect(result.suggestions.every((entry) => entry.category === "compound")).toBe(true);
    expect(result.suggestions.every((entry) => entry.source === "compound")).toBe(true);
    expect(result.suggestions.every((entry) => entry.callsign.length <= 32)).toBe(true);
  });

  test("returns one suggestion through the convenience helper", () => {
    const suggestion = suggestCallsign({ seed: "one", avoid: ["Nightjar"] });
    expect(suggestion.callsign).toBeTruthy();
    expect(suggestion.collisionKey).not.toBe("nightjar");
  });

  test("rejects malformed or unbounded input", () => {
    expect(() => suggestCallsigns({ count: 0 })).toThrow("integer from 1 to 20");
    expect(() => suggestCallsigns({ count: 21 })).toThrow("integer from 1 to 20");
    expect(() => suggestCallsigns({ seed: "\n" })).toThrow("control characters");
    expect(() => suggestCallsigns({ avoid: ["not/allowed"] })).toThrow(
      "unsupported characters",
    );
    expect(() => suggestCallsigns({ categories: [] })).toThrow("1 to 4 entries");
    expect(() => suggestCallsigns({ categories: ["animal", "animal"] })).toThrow(
      "duplicate entries",
    );
    expect(() => callsignCollisionKey("\u202eNightjar")).toThrow("control characters");
  });

  test("uses cryptographic random mode when no seed is supplied", () => {
    const result = suggestCallsigns({ count: 2, avoid: ["Nightjar"] });
    expect(result.seedSource).toBe("random");
    expect(result.seedFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.suggestions).toHaveLength(2);
  });
});

describe("callsign suggestion CLI", () => {
  test("parses flags, repeated lists, and environment defaults", () => {
    const parsed = parseCallsignCliArgs(
      [
        "--count",
        "3",
        "--seed",
        "entrant-7",
        "--avoid",
        "Nightjar, Teacup",
        "--category",
        "object",
        "--json",
      ],
      {
        STENSIBLY_CALLSIGN_AVOID: "Lantern",
        STENSIBLY_CALLSIGN_CATEGORIES: "animal",
      },
    );

    expect(parsed).toEqual({
      help: false,
      json: true,
      options: {
        count: 3,
        seed: "entrant-7",
        avoid: ["Lantern", "Nightjar", "Teacup"],
        categories: ["animal", "object"],
      },
    });
  });

  test("formats text and JSON output without implying reservation", () => {
    const result = suggestCallsigns({ count: 2, seed: "format" });
    const text = formatCallsignSuggestions(result, false);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("\t");

    const json = JSON.parse(formatCallsignSuggestions(result, true)) as {
      reservesCallsign: boolean;
      suggestions: unknown[];
    };
    expect(json.reservesCallsign).toBe(false);
    expect(json.suggestions).toHaveLength(2);
  });

  test("documents categories and rejects unknown flags", () => {
    expect(callsignUsage()).toContain("animal, object, literary, internet");
    expect(() => parseCallsignCliArgs(["--wat"], {})).toThrow("Unknown argument");
    expect(() => parseCallsignCliArgs(["--category", "space"], {})).toThrow(
      "Unknown callsign category",
    );
  });
});
