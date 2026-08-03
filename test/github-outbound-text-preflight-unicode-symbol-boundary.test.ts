import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "unicode-symbol-boundary-review",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

describe("GitHub outbound Unicode reference boundaries", () => {
  test("detects direct GitHub URLs terminated by an emoji symbol", () => {
    const result = compile(
      "See https://github.com/example/project/issues/12👍 for context.",
    );

    expect(result).toMatchObject({
      decision: "reject",
      findings: [{
        source: "direct_url",
        referenceKind: "issue",
        externalOwner: "example",
        externalRepository: "project",
        itemNumber: 12,
        rule: "external_reference",
      }],
    });
  });

  test("ignores shorthand embedded through Unicode connector punctuation", () => {
    for (const text of [
      "prefix‿example/project#12",
      "example/project#12‿suffix",
      "prefix⁀example/project@abcdef0",
      "example/project@abcdef0⁀suffix",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("pass");
      expect(result.findings).toEqual([]);
    }
  });

  test("keeps emoji as a standalone shorthand delimiter", () => {
    const result = compile("Review👍example/project#12👍today.");

    expect(result).toMatchObject({
      decision: "reject",
      findings: [{
        source: "repository_shorthand",
        referenceKind: "issue_or_pull_request",
        externalOwner: "example",
        externalRepository: "project",
        itemNumber: 12,
      }],
    });
  });
});
