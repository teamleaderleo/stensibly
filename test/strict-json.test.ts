import { describe, expect, test } from "bun:test";
import { parseStrictJson, StrictJsonError } from "../src/strict-json.ts";

describe("strict JSON", () => {
  test("parses one bounded JSON value", () => {
    expect(parseStrictJson('{"event":"push","values":[1,true,null]}')).toEqual({
      event: "push",
      values: [1, true, null],
    });
  });

  test("rejects duplicate keys before JSON.parse can overwrite them", () => {
    try {
      parseStrictJson('{"repository":"one","repository":"two"}', {
        prefix: "GITHUB_WEBHOOK_JSON",
      });
      throw new Error("expected duplicate key rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(StrictJsonError);
      expect((error as StrictJsonError).code).toBe(
        "GITHUB_WEBHOOK_JSON_DUPLICATE_KEY",
      );
      expect((error as StrictJsonError).path).toBe("$.repository");
    }
  });

  test("enforces depth and container bounds", () => {
    expect(() => parseStrictJson('{"a":{"b":{"c":1}}}', {
      maxDepth: 2,
    })).toThrow("JSON nesting exceeds 2");
    expect(() => parseStrictJson("[1,2,3]", {
      maxArrayLength: 2,
    })).toThrow("JSON array exceeds 2 entries");
    expect(() => parseStrictJson('{"a":1,"b":2}', {
      maxObjectKeys: 1,
    })).toThrow("JSON object exceeds 1 keys");
  });

  test("rejects trailing data, invalid escapes, and oversized input", () => {
    expect(() => parseStrictJson("{}{}"))
      .toThrow("Trailing data after JSON value");
    expect(() => parseStrictJson('{"value":"\\x"}'))
      .toThrow("Invalid JSON escape");
    expect(() => parseStrictJson('{"value":"long"}', { maxBytes: 8 }))
      .toThrow("JSON input exceeds 8 bytes");
  });
});
