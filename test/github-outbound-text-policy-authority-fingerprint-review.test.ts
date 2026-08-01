import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  evaluateGitHubOutboundText,
  parseGitHubOutboundTextReceipt,
  type GitHubOutboundTextInput,
} from "../src/github-outbound-text-policy.ts";

function authorityFingerprint(
  generation: number,
  repositories: readonly string[],
): string {
  return fingerprintCanonicalRequest({
    policy: "github-external-contact-authority/v1",
    generation,
    repositories,
  });
}

function input(
  repository: string,
  fingerprint: string,
): GitHubOutboundTextInput {
  return {
    workspace: "default",
    project: "github-provider",
    destination: { owner: "teamleaderleo", repository: "stensibly" },
    surface: "comment",
    operationRef: "github-comment-authority-fingerprint-review",
    authorityGeneration: 3,
    fields: [{ name: "body", text: `See ${repository}#12.` }],
    policy: {
      version: 1,
      controlledOwners: ["teamleaderleo"],
      controlledRepositories: [],
    },
    externalContactAuthority: {
      fingerprint,
      generation: 3,
      repositories: [repository],
    },
  };
}

describe("GitHub outbound authority fingerprint binding", () => {
  test("does not grant external contact from caller-computable authority fields", () => {
    const repositories = ["external/project"] as const;
    const receipt = evaluateGitHubOutboundText(
      input(
        repositories[0],
        authorityFingerprint(3, repositories),
      ),
    );

    expect(receipt.decision).toBe("reject");
    expect(receipt.referenceCounts).toMatchObject({
      authorized: 0,
      rejected: 1,
    });
    expect(receipt.externalContactAuthorityFingerprint).toBeNull();
    expect(receipt.externalContactAuthorityGeneration).toBeNull();
    expect(receipt.providerDispatchAuthorized).toBe(false);
    expect(receipt.diagnostics[0]).toMatchObject({
      owner: "external",
      repository: "project",
      rule: "external_reference_requires_authority",
      authorityRequired: true,
    });
  });

  test("rejects repository substitution under another authority fingerprint", () => {
    const fingerprint = authorityFingerprint(3, ["external/project"]);

    expect(() =>
      evaluateGitHubOutboundText(
        input("other/project", fingerprint),
      )
    ).toThrow("authority fingerprint does not match");
  });

  test("rejects authority-bearing receipts even with a recomputed fingerprint", () => {
    const repositories = ["external/project"] as const;
    const receipt = evaluateGitHubOutboundText(
      input(repositories[0], authorityFingerprint(3, repositories)),
    );
    const altered = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    altered.externalContactAuthorityFingerprint = authorityFingerprint(3, repositories);
    altered.externalContactAuthorityGeneration = 3;
    const { receiptFingerprint: _discarded, ...withoutFingerprint } = altered;
    altered.receiptFingerprint = fingerprintCanonicalRequest(withoutFingerprint);

    expect(() => parseGitHubOutboundTextReceipt(altered)).toThrow(
      "cannot retain caller-provided external contact authority",
    );
  });

  test("continues to allow project-policy-controlled references", () => {
    const candidate = input(
      "external/project",
      authorityFingerprint(3, ["external/project"]),
    );
    const receipt = evaluateGitHubOutboundText({
      ...candidate,
      fields: [{ name: "body", text: "See teamleaderleo/fieldwork#12." }],
      externalContactAuthority: null,
    });

    expect(receipt.decision).toBe("allow");
    expect(receipt.referenceCounts).toMatchObject({
      controlled: 1,
      authorized: 0,
      rejected: 0,
    });
  });
});

describe("GitHub outbound destination field-set admission", () => {
  test("rejects the receipt-only full name on evaluator input", () => {
    const repositories = ["external/project"] as const;
    const candidate = input(
      repositories[0],
      authorityFingerprint(3, repositories),
    );

    expect(() =>
      evaluateGitHubOutboundText({
        ...candidate,
        destination: {
          ...candidate.destination,
          repositoryFullName: "teamleaderleo/stensibly",
        },
      })
    ).toThrow("unknown field repositoryFullName");
  });

  test("rejects a parsed receipt whose destination omits its full name", () => {
    const repositories = ["external/project"] as const;
    const receipt = evaluateGitHubOutboundText(
      input(
        repositories[0],
        authorityFingerprint(3, repositories),
      ),
    );
    const altered = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    const destination = altered.destination as Record<string, unknown>;
    delete destination.repositoryFullName;

    expect(() => parseGitHubOutboundTextReceipt(altered)).toThrow(
      "receipt destination fields are invalid",
    );
  });
});
