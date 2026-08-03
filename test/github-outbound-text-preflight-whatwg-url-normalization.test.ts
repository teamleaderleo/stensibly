import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

describe("GitHub outbound WHATWG URL normalization", () => {
  test("never passes GitHub routes reached through encoded authority or backslashes", () => {
    const cases = [
      "https://%67ithub.com/example/project/issues/12",
      "https://github.com\\example\\project\\issues\\12",
      "https://github.com/example\\project/issues/12",
      "http://github.com\\example/project/discussions/12",
      "https://www.github.com\\example\\project\\commit\\abcdef0",
    ];

    for (const text of cases) {
      expectFindingOrFixedRejection(text);
    }
  });

  test("normalizes uppercase scheme and host into one bounded finding", () => {
    const result = compile(
      "HTTPS://WWW.GITHUB.COM/example/project/issues/12",
    );

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "direct_url",
      referenceKind: "issue",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: 12,
      commitPrefix: null,
    });
  });
});

function expectFindingOrFixedRejection(text: string): void {
  try {
    const result = compile(text);
    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "direct_url",
      externalOwner: "example",
      externalRepository: "project",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message.length).toBeGreaterThan(0);
    expect((error as Error).message).not.toContain(text);
    expect(JSON.stringify(error)).not.toContain(text);
  }
}

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "whatwg-url-normalization-control",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}
