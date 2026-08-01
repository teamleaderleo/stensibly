import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  evaluateGitHubOutboundText,
  type GitHubOutboundTextInput,
} from "../src/github-outbound-text-policy.ts";

function callerComputableFingerprint(
  generation: number,
  repositories: readonly string[],
): string {
  return fingerprintCanonicalRequest({
    policy: "github-external-contact-authority/v1",
    generation,
    repositories,
  });
}

function externalInput(): GitHubOutboundTextInput {
  const repositories = ["external/project"] as const;
  return {
    workspace: "default",
    project: "github-provider",
    destination: { owner: "teamleaderleo", repository: "stensibly" },
    surface: "comment",
    operationRef: "github-comment-trusted-authority-review",
    authorityGeneration: 3,
    fields: [{ name: "body", text: "See external/project#12." }],
    policy: {
      version: 1,
      controlledOwners: ["teamleaderleo"],
      controlledRepositories: [],
    },
    externalContactAuthority: {
      fingerprint: callerComputableFingerprint(3, repositories),
      generation: 3,
      repositories: [...repositories],
    },
  };
}

describe("GitHub outbound trusted external-contact authority", () => {
  test("does not authorize external contact from caller-computable fields", () => {
    const receipt = evaluateGitHubOutboundText(externalInput());

    expect(receipt.decision).toBe("reject");
    expect(receipt.referenceCounts).toMatchObject({
      total: 1,
      controlled: 0,
      authorized: 0,
      rejected: 1,
    });
    expect(receipt.providerDispatchAuthorized).toBe(false);
    expect(receipt.diagnostics[0]).toMatchObject({
      owner: "external",
      repository: "project",
      rule: "external_reference_requires_authority",
      authorityRequired: true,
    });
  });

  test("continues to allow references controlled by project policy", () => {
    const candidate = externalInput();
    const receipt = evaluateGitHubOutboundText({
      ...candidate,
      fields: [{ name: "body", text: "See teamleaderleo/fieldwork#12." }],
      policy: {
        version: 1,
        controlledOwners: ["teamleaderleo"],
        controlledRepositories: [],
      },
      externalContactAuthority: null,
    });

    expect(receipt.decision).toBe("allow");
    expect(receipt.referenceCounts).toMatchObject({
      controlled: 1,
      authorized: 0,
      rejected: 0,
    });
    expect(receipt.providerDispatchAuthorized).toBe(false);
  });
});
