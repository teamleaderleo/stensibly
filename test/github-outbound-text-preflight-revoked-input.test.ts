import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
  type GitHubOutboundTextPolicyV1,
  type GitHubOutboundTextPreflightInputV1,
} from "../src/github-outbound-text-preflight.ts";

const repository = "teamleaderleo/stensibly";

function policy(): GitHubOutboundTextPolicyV1 {
  return {
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: "revoked-input-control",
    controlledRepositories: [repository],
    externalReferenceDisposition: "reject",
  };
}

function input(): GitHubOutboundTextPreflightInputV1 {
  return {
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: policy(),
    repositoryFullName: repository,
    field: "comment",
    text: "No external reference.",
  };
}

describe("GitHub outbound preflight revoked caller admission", () => {
  test("normalizes a revoked top-level input", () => {
    const revoked = Proxy.revocable(input(), {});
    revoked.revoke();

    expect(() => compileGitHubOutboundTextPreflightV1(
      revoked.proxy as GitHubOutboundTextPreflightInputV1,
    )).toThrow("GitHub outbound text preflight input could not be inspected");
  });

  test("normalizes a revoked policy", () => {
    const revoked = Proxy.revocable(policy(), {});
    revoked.revoke();
    const value = {
      ...input(),
      policy: revoked.proxy as GitHubOutboundTextPolicyV1,
    };

    expect(() => compileGitHubOutboundTextPreflightV1(value))
      .toThrow("GitHub outbound text policy could not be inspected");
  });

  test("normalizes a revoked controlled-repository array", () => {
    const revoked = Proxy.revocable([repository], {});
    revoked.revoke();
    const value = {
      ...input(),
      policy: {
        ...policy(),
        controlledRepositories: revoked.proxy as string[],
      },
    };

    expect(() => compileGitHubOutboundTextPreflightV1(value))
      .toThrow("GitHub outbound controlled repositories could not be inspected");
  });
});
