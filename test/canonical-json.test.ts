import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import {
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
