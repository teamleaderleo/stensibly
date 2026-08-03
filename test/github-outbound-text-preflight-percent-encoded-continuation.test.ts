import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const fixedDiagnostic =
  "GitHub outbound direct URL contains encoded path continuation";

describe("GitHub outbound percent-encoded path continuation", () => {
  test("rejects valid percent escapes that can continue direct route identity", () => {
    const hostile = [
      "https://github.com/example/project/issues/12%33",
      "https://github.com/example/project/pull/12%2Ffiles",
      "https://github.com/example/project/discussions/12%3Fcategory=ideas",
      "https://github.com/example/project/issues/12%23comment-1",
      "https://github.com/example/project/commit/abcdef0%61",
      "https://github.com/example/project/commit/abcdef0%2Fchecks",
    ];

    for (const text of hostile) {
      const error = captureError(() => compile(text));
      expect(error.message).toBe(fixedDiagnostic);
      expect(error.message).not.toContain(text);
      expect(JSON.stringify(error)).not.toContain(text);
    }
  });

  test("never emits a truncated issue number or commit prefix", () => {
    for (const text of [
      "https://github.com/example/project/issues/12%33",
      "https://github.com/example/project/commit/abcdef0%61",
    ]) {
      let result: ReturnType<typeof compile> | null = null;
      let error: unknown;
      try {
        result = compile(text);
      } catch (caught) {
        error = caught;
      }

      expect(result?.findings.some((finding) =>
        finding.itemNumber === 12 || finding.commitPrefix === "abcd"
      ) ?? false).toBe(false);
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(fixedDiagnostic);
    }
  });

  test("preserves literal query, fragment, path decoration, patch, punctuation, and emoji delimiters", () => {
    const result = compile([
      "https://github.com/example/project/issues/12?tab=activity",
      "https://github.com/example/project/pull/13#discussion_r1",
      "https://github.com/example/project/issues/14/comments",
      "https://github.com/example/project/commit/abcdef0.patch",
      "https://github.com/example/project/discussions/15!",
      "https://github.com/example/project/issues/16🙂",
    ].join("\n"));

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(6);
    expect(result.findings.map((finding) => finding.itemNumber)).toEqual([
      12,
      13,
      14,
      null,
      15,
      16,
    ]);
    expect(result.findings[3]?.commitPrefix).toBe("abcd");
  });
});

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "percent-encoded-continuation-control",
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
  throw new Error("Expected operation to reject encoded path continuation");
}
