import { describe, expect, test } from "bun:test";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const payload = "a".repeat(12);
const credentialRepositories = [
  `projectxstn.svc_${payload}`,
  `projectxstn.tok_${payload}`,
] as const;

describe("GitHub outbound final retained credential policy", () => {
  test("rejects final-threshold Stensibly identities in canonical findings", () => {
    for (const repository of credentialRepositories) {
      for (const text of [
        `https://github.com/example/${repository}/issues/12`,
        `example/${repository}#12`,
        `example/${repository}@abcdef0`,
      ]) {
        expectFixedRejection(
          () => compile(text),
          "GitHub outbound repository identity is credential-shaped",
          repository,
        );
      }
    }
  });

  test("rejects final-threshold Stensibly identities in normalized URL findings", () => {
    for (const repository of credentialRepositories) {
      const text = `https://github.com./example/${repository}/issues/12`;
      expectFixedRejection(
        () => compile(text),
        "GitHub outbound repository identity is credential-shaped",
        repository,
      );
    }
  });

  test("rejects final-threshold Stensibly identities in retained policy IDs", () => {
    for (const family of ["svc", "tok"] as const) {
      const policyId = `policyxstn.${family}_${payload}`;
      expectFixedRejection(
        () => compile("ordinary outbound prose", policyId),
        "GitHub outbound text policy ID is invalid",
        policyId,
      );
    }
  });

  test("preserves benign short Stensibly-like aliases", () => {
    const repository = "projectxstn.svc_review";
    const result = compile(
      `https://github.com/example/${repository}/issues/12`,
      "policyxstn.tok_review",
    );

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      externalOwner: "example",
      externalRepository: repository,
      referenceKind: "issue",
      itemNumber: 12,
    });
  });
});

function compile(text: string, policyId = "final-credential-policy") {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId,
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

function expectFixedRejection(
  operation: () => unknown,
  message: string,
  rejectedText: string,
): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(message);
  expect((thrown as Error).message).not.toContain(rejectedText);
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}
