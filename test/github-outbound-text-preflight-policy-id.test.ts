import { describe, expect, test } from "bun:test";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
} from "../src/github-outbound-text-preflight.ts";

const repository = "teamleaderleo/stensibly";

function compile(policyId: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId,
      controlledRepositories: [repository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: repository,
    field: "comment",
    text: "No external GitHub reference appears here.",
  });
}

describe("GitHub outbound text preflight policy identity", () => {
  test("retains a canonical backlink-safe policy ID", () => {
    const result = compile("outbound-policy-w01");

    expect(result.policyId).toBe("outbound-policy-w01");
    expect(result.decision).toBe("pass");
  });

  test("rejects policy IDs that can themselves form external backlinks", () => {
    for (const policyId of [
      "example/project#1",
      "https://github.com/example/project/issues/1",
      "example/project@abcdef0",
      "example:project",
    ]) {
      expect(() => compile(policyId)).toThrow(
        "GitHub outbound text policy ID is invalid",
      );
    }
  });
});
