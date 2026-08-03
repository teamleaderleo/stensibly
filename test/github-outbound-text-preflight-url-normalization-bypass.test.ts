import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const canonicalPath = "/example/project/issues/12";

describe("GitHub outbound direct URL normalization bypasses", () => {
  test("never passes routes that WHATWG normalizes to a GitHub issue URL", () => {
    const cases = [
      String.raw`https://github.com\example\project\issues\12`,
      String.raw`https:\\github.com\example\project\issues\12`,
      "https://git\thub.com/example/project/issues/12",
      "https://git\nhub.com/example/project/issues/12",
      "https://git\rhub.com/example/project/issues/12",
      "https://github.com/example/project/temporary/../issues/12",
      "https://github.com/example/./project/issues/12",
      "https://%67ithub.com/example/project/issues/12",
      "https://github\u3002com/example/project/issues/12",
    ];

    for (const text of cases) {
      const normalized = new URL(text);
      expect(normalized.hostname).toBe("github.com");
      expect(normalized.pathname).toBe(canonicalPath);
      expectBoundedFindingOrFixedRejection(text);
    }
  });
});

function expectBoundedFindingOrFixedRejection(text: string): void {
  try {
    const result = compile(text);
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
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    const message = (error as Error).message;
    expect(message).toMatch(/^GitHub outbound direct reference /);
    expect(message).not.toContain(text);
    expect(JSON.stringify(error)).not.toContain(text);
  }
}

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "url-normalization-bypass-control",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}
