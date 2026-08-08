import { describe, expect, test } from "bun:test";
import {
  compareCodeUnits,
  sha256,
  stableJson,
} from "../src/canonical-json.ts";
import {
  canonicalLogins,
  canonicalStringList,
  sha256 as githubSha256,
  stableJson as githubStableJson,
} from "../src/github-provider-validation.ts";
import { mcpCapabilityPolicyRegistry } from "../src/mcp-capability-policy.ts";

describe("canonical JSON and digest helpers", () => {
  test("orders object keys recursively and preserves array order", () => {
    expect(stableJson({
      z: [{ beta: 2, alpha: 1 }, true],
      a: "first",
    })).toBe('{"a":"first","z":[{"alpha":1,"beta":2},true]}');
  });

  test("uses exact UTF-16 code-unit order across canonical and provider paths", () => {
    const supplementary = "\u{10000}";
    const privateUse = "\uE000";
    const unordered = [privateUse, supplementary, "a", "Z"];
    const expected = ["Z", "a", supplementary, privateUse];

    expect([...unordered].sort(compareCodeUnits)).toEqual(expected);
    expect(compareCodeUnits("same", "same")).toBe(0);

    const canonical = stableJson({
      [privateUse]: 3,
      [supplementary]: 4,
      a: 2,
      Z: 1,
    });
    expect(canonical).toBe(
      `{"Z":1,"a":2,"${supplementary}":4,"${privateUse}":3}`,
    );
    expect(sha256(canonical)).toBe(
      "sha256:7725e02f3312cd360c9cfb126e8645889a2b21801528cd7209b91674efa9f054",
    );
    expect(canonicalStringList(unordered, 4, 10)).toEqual(expected);
    expect(canonicalLogins(["zeta", "alpha", "beta"])).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("normalizes negative zero and rejects unsupported values", () => {
    expect(stableJson(-0)).toBe("0");
    expect(() => stableJson(Number.NaN)).toThrow("Canonical JSON number must be finite");
    expect(() => stableJson(Number.POSITIVE_INFINITY)).toThrow(
      "Canonical JSON number must be finite",
    );
    expect(() => stableJson(undefined)).toThrow("Canonical JSON value is invalid");
    expect(() => stableJson(1n)).toThrow("Canonical JSON value is invalid");
  });

  test("produces the existing prefixed SHA-256 identity", () => {
    expect(sha256("stensibly")).toBe(
      "sha256:fc06bf1e41241eeaabcab19a4ced027c84345784a1b7383103569e900adb63af",
    );
    expect(sha256("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("🙂\n多代理")).toBe(
      "sha256:53ef7b8e8a12c85504040e7de85dd931a816c4d2ee2e07c8d583a5401440fda4",
    );
  });

  test("keeps GitHub compatibility exports bound to the neutral helpers", () => {
    expect(githubSha256).toBe(sha256);
    expect(githubStableJson).toBe(stableJson);
  });

  test("preserves the MCP capability registry fingerprint path", () => {
    expect(mcpCapabilityPolicyRegistry.fingerprint).toBe(sha256(stableJson({
      version: mcpCapabilityPolicyRegistry.version,
      policies: mcpCapabilityPolicyRegistry.policies,
    })));
  });
});
