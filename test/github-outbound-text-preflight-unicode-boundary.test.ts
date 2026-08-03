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
      policyId: "unicode-reference-boundary-review",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

describe("GitHub outbound Unicode reference boundaries", () => {
  test("ignores shorthand embedded in larger Unicode identifiers", () => {
    for (const text of [
      "αexample/project#12",
      "example/project#12β",
      "变量example/project@abcdef0",
      "example/project@abcdef0变量",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("pass");
      expect(result.findings).toEqual([]);
    }
  });

  test("detects direct GitHub URLs terminated by Unicode punctuation", () => {
    const result = compile(
      "参见 https://github.com/example/project/issues/12。然后继续。",
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

  test("detects standalone shorthand inside Unicode punctuation", () => {
    const result = compile("审查（example/project#12），然后继续。");

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
