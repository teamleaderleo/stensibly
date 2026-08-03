import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const encodedPathDiagnostic =
  "GitHub outbound direct reference contains percent-encoded path continuation";

describe("GitHub outbound canonical direct URL routes", () => {
  test("fails closed when any identity-bearing path segment contains a percent escape", () => {
    const cases = [
      "https://github.com/exam%70le/project/issues/12",
      "https://github.com/example/pro%6Aect/issues/12",
      "https://github.com/example/project/iss%75es/12",
      "https://github.com/example/project/pu%6Cl/12",
      "https://github.com/example/project/discuss%69ons/12",
      "https://github.com/example/project/comm%69t/abcdef0",
      "https://github.com/example/project/issues/12%33",
      "https://github.com/example/project/commit/abcdef0%61",
    ];

    for (const text of cases) {
      const error = captureError(() => compile(text));
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toBe(encodedPathDiagnostic);
      expect(error.message).not.toContain(text);
      expect(JSON.stringify(error)).not.toContain(text);
    }
  });

  test("does not silently pass normalized GitHub host spellings", () => {
    const cases = [
      "https://github.com:443/example/project/issues/12",
      "http://github.com:80/example/project/issues/12",
      "https://github.com./example/project/issues/12",
      "https://www.github.com:443/example/project/issues/12",
      "https://reader@github.com/example/project/issues/12",
    ];

    for (const text of cases) {
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
    }
  });

  test("preserves canonical direct GitHub route findings", () => {
    const result = compile(
      "https://github.com/example/project/issues/12?tab=activity#discussion",
    );

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "direct_url",
      referenceKind: "issue",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: 12,
    });
  });
});

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "canonical-url-route-control",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected non-canonical GitHub URL path rejection");
}
