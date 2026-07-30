import { describe, expect, test } from "bun:test";
import { parseStrictJson, StrictJsonError } from "../src/strict-json.ts";

function duplicateErrorFor(key: string): StrictJsonError {
  const text = `{${JSON.stringify(key)}:1,${JSON.stringify(key)}:2}`;
  try {
    parseStrictJson(text, { prefix: "GITHUB_WEBHOOK_JSON" });
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    return error as StrictJsonError;
  }
  throw new Error("expected duplicate key rejection");
}

describe("strict JSON", () => {
  test("parses one bounded JSON value", () => {
    expect(parseStrictJson('{"event":"push","values":[1,true,null]}')).toEqual({
      event: "push",
      values: [1, true, null],
    });
  });

  test("rejects duplicate keys without retaining provider-controlled key text", () => {
    for (const key of [
      "repository",
      "token=stn.secret-value",
      "line\nbreak",
      "left\u202eright",
      "x".repeat(4_096),
    ]) {
      const error = duplicateErrorFor(key);
      expect(error.code).toBe("GITHUB_WEBHOOK_JSON_DUPLICATE_KEY");
      expect(error.message).toBe("Duplicate JSON object key.");
      expect(error.path).toBe("$.object[1]");
      expect(error.message).not.toContain(key);
      expect(error.path).not.toContain(key);
    }
  });

  test("enforces depth for empty and nonempty containers", () => {
    for (const text of ['{"a":{}}', '{"a":[]}', "[[]]"]) {
      expect(() => parseStrictJson(text, { maxDepth: 1 }))
        .toThrow("JSON nesting exceeds 1");
    }
    expect(parseStrictJson('{"a":1,"b":true}', { maxDepth: 1 })).toEqual({
      a: 1,
      b: true,
    });
    expect(() => parseStrictJson('{"a":{"b":{"c":1}}}', {
      maxDepth: 2,
    })).toThrow("JSON nesting exceeds 2");
  });

  test("enforces container counts", () => {
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
