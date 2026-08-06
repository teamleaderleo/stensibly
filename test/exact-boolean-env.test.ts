import { describe, expect, test } from "bun:test";
import { exactBooleanEnv } from "../src/exact-boolean-env.ts";

const key = "FEATURE_ENABLED";
const configuredReadKeys = [
  "STENSIBLY_GITHUB_DELEGATED_READS_ENABLED",
  "STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED",
] as const;
const providerConfigurationSignal = {
  STENSIBLY_GITHUB_APP_ID: "12345",
};

describe("exactBooleanEnv", () => {
  test.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
  ] as const)("maps generic value %p to %s", (value, expected) => {
    expect(exactBooleanEnv({ [key]: value }, key)).toBe(expected);
  });

  test.each(configuredReadKeys)(
    "defaults configured GitHub read capability %s on",
    (capabilityKey) => {
      expect(exactBooleanEnv(providerConfigurationSignal, capabilityKey))
        .toBe(true);
      expect(exactBooleanEnv({
        ...providerConfigurationSignal,
        [capabilityKey]: "",
      }, capabilityKey)).toBe(true);
    },
  );

  test.each(configuredReadKeys)(
    "keeps exact false as the %s kill switch",
    (capabilityKey) => {
      expect(exactBooleanEnv({
        ...providerConfigurationSignal,
        [capabilityKey]: "false",
      }, capabilityKey)).toBe(false);
    },
  );

  test.each(configuredReadKeys)(
    "does not activate %s without provider configuration",
    (capabilityKey) => {
      expect(exactBooleanEnv({}, capabilityKey)).toBe(false);
      expect(exactBooleanEnv({ [capabilityKey]: "" }, capabilityKey))
        .toBe(false);
    },
  );

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
    expect(exactBooleanEnv({ [key]: "false", OTHER: "true" }, key))
      .toBe(false);
  });
});
