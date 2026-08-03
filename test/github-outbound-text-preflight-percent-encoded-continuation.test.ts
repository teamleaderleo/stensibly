import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const fixedDiagnostic =
  "GitHub outbound direct reference contains percent-encoded path continuation";

describe("GitHub outbound percent-encoded path continuation", () => {
  test("fails closed before emitting a truncated direct item or commit identity", () => {
    const cases = [
      "https://github.com/example/project/issues/12%33",
      "https://github.com/example/project/issues/12%2Fcomments",
      "https://github.com/example/project/issues/12%2fcomments",
      "https://github.com/example/project/issues/12%3Ftab=activity",
      "https://github.com/example/project/issues/12%3ftab=activity",
      "https://github.com/example/project/issues/12%23discussion",
      "https://github.com/example/project/commit/abcdef0%61",
      "https://github.com/example/project/commit/abcdef0%2Fchecks",
      "https://github.com/example/project/commit/abcdef0%2fchecks",
      "https://github.com/example/project/commit/abcdef0%3Fdiff=split",
      "https://github.com/example/project/commit/abcdef0%3fdiff=split",
      "https://github.com/example/project/commit/abcdef0%23files",
    ];

    for (const text of cases) {
      const error = captureError(() => compile(text));
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toBe(fixedDiagnostic);
      expect(error.message).not.toContain(text);
      expect(JSON.stringify(error)).not.toContain(text);
    }
  });

  test("preserves literal suffix delimiters as external-reference findings", () => {
    const itemCases = [
      "https://github.com/example/project/issues/12/comments",
      "https://github.com/example/project/issues/12.patch",
      "https://github.com/example/project/issues/12?tab=activity",
      "https://github.com/example/project/issues/12#discussion",
      "https://github.com/example/project/issues/12！",
      "https://github.com/example/project/issues/12🙂",
    ];
    for (const text of itemCases) {
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

    const commitCases = [
      "https://github.com/example/project/commit/abcdef0/checks",
      "https://github.com/example/project/commit/abcdef0.patch",
      "https://github.com/example/project/commit/abcdef0?diff=split",
      "https://github.com/example/project/commit/abcdef0#files",
      "https://github.com/example/project/commit/abcdef0！",
      "https://github.com/example/project/commit/abcdef0🙂",
    ];
    for (const text of commitCases) {
      const result = compile(text);
      expect(result.decision).toBe("reject");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        source: "direct_url",
        referenceKind: "commit",
        externalOwner: "example",
        externalRepository: "project",
        itemNumber: null,
        commitPrefix: "abcd",
      });
    }
  });
});

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "percent-encoded-path-control",
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
  throw new Error("Expected percent-encoded path continuation to fail closed");
}
