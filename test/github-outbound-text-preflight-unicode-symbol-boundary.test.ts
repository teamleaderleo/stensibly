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

describe("GitHub outbound Unicode symbol and connector boundaries", () => {
  test("detects direct GitHub URLs terminated by punctuation and symbols", () => {
    for (const text of [
      "See https://github.com/example/project/issues/12👍 for context.",
      "See https://github.com/example/project/issues/12. Then continue.",
      "See https://github.com/example/project/issues/12。然后继续。",
    ]) {
      const result = compile(text);
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
      expect(result.findings).toHaveLength(1);
    }
  });

  test("detects direct GitHub URLs with query and fragment suffixes", () => {
    for (const text of [
      "https://github.com/example/project/issues/12?notification_referrer_id=1",
      "https://github.com/example/project/issues/12#issuecomment-123",
      "https://github.com/example/project/commit/abcdef0?diff=split",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("reject");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        source: "direct_url",
        externalOwner: "example",
        externalRepository: "project",
      });
    }
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
