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
      policyId: "standalone-shorthand-review",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

describe("GitHub outbound shorthand context", () => {
  test("ignores repository-like text inside unrelated URLs", () => {
    for (const text of [
      "See https://example.com/example/project#12 for the external page.",
      "Open https://example.com/?next=example/project#12 after login.",
      "Use /redirect/example/project#12 only as a local route.",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("pass");
      expect(result.findings).toEqual([]);
    }
  });

  test("does not truncate shorthand before trailing identifier text", () => {
    for (const text of [
      "The label is example/project#12abc.",
      "The build key is example/project@abcdef0garbage.",
      "The route is example/project#12/continuation.",
      "The query value is example/project@abcdef0?mode=review.",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("pass");
      expect(result.findings).toEqual([]);
    }
  });

  test("detects standalone shorthand with ordinary delimiters", () => {
    const result = compile(
      "Review (example/project#12), then compare example/project@abcdef0;",
    );

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      source: "repository_shorthand",
      referenceKind: "issue_or_pull_request",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: 12,
      commitPrefix: null,
    });
    expect(result.findings[1]).toMatchObject({
      source: "commit_shorthand",
      referenceKind: "commit",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: null,
      commitPrefix: "abcd",
    });
  });

  test("preserves direct GitHub URL and closing-keyword detection", () => {
    const direct = compile(
      "See https://github.com/example/project/issues/12.",
    );
    expect(direct).toMatchObject({
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

    const closing = compile("Fixes example/project#12");
    expect(closing).toMatchObject({
      decision: "reject",
      findings: [{
        source: "repository_shorthand",
        itemNumber: 12,
        rule: "external_closing_reference",
      }],
    });
  });
});
