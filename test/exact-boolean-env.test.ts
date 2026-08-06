import { describe, expect, test } from "bun:test";
import { exactBooleanEnv } from "../src/exact-boolean-env.ts";

const key = "FEATURE_ENABLED";

describe("exactBooleanEnv", () => {
  test.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
  ] as const)("maps %p to %s", (value, expected) => {
    expect(exactBooleanEnv({ [key]: value }, key)).toBe(expected);
  });

  test.each([
    "TRUE",
    "False",
    "0",
    "1",
    "yes",
    " true",
    "true ",
    " false ",
  ])("rejects non-exact value %p", (value) => {
    expect(() => exactBooleanEnv({ [key]: value }, key))
      .toThrow(`${key} must be exact true or false`);
  });

  test("reads only the named environment field", () => {
    expect(exactBooleanEnv({ OTHER: "true" }, key)).toBe(false);
    expect(exactBooleanEnv({ [key]: "false", OTHER: "true" }, key)).toBe(false);
  });
});
