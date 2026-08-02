import { describe, expect, test } from "bun:test";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
} from "../src/github-outbound-text-preflight.ts";

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "outbound-policy-w01",
      controlledRepositories: ["teamleaderleo/stensibly"],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: "teamleaderleo/stensibly",
    field: "comment",
    text,
  });
}

describe("GitHub outbound long numeric aliases", () => {
  test("blocks shorthand numbers longer than the provider domain", () => {
    const result = compile("See example/project#21474836480 before continuing.");

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "repository_shorthand",
      referenceKind: "issue_or_pull_request",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: null,
    });
    expect(JSON.stringify(result)).not.toContain("21474836480");
  });

  test("binds distinct long numeric aliases behind the same minimized finding", () => {
    const left = compile("See example/project#21474836480");
    const right = compile("See example/project#21474836481");

    expect(left.findings[0]?.itemNumber).toBeNull();
    expect(right.findings[0]?.itemNumber).toBeNull();
    expect(left.findings[0]?.findingFingerprint).not.toBe(
      right.findings[0]?.findingFingerprint,
    );
  });
});
