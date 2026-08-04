import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

function input(
  text: string,
  overrides: Partial<{
    repositoryFullName: string;
    controlledRepositories: readonly string[];
  }> = {},
) {
  const repositoryFullName = overrides.repositoryFullName ?? controlledRepository;
  return {
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "final-boundary-review",
      controlledRepositories:
        overrides.controlledRepositories ?? [controlledRepository],
      externalReferenceDisposition: "reject" as const,
    },
    repositoryFullName,
    field: "comment" as const,
    text,
  };
}

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1(input(text));
}

describe("GitHub outbound final privacy and exact-text boundaries", () => {
  test("blocks overlong direct and shorthand commit aliases without retaining them", () => {
    const directIdentity = "a".repeat(65);
    const shorthandIdentity = "b".repeat(160);
    const result = compile([
      `https://github.com/example/project/commit/${directIdentity}!`,
      `Review example/project@${shorthandIdentity}.`,
    ].join("\n"));

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.source)).toEqual([
      "direct_url",
      "commit_shorthand",
    ]);
    expect(result.findings.map((finding) => finding.commitPrefix)).toEqual([
      "aaaa",
      "bbbb",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(directIdentity);
    expect(serialized).not.toContain(shorthandIdentity);
  });

  test("binds distinct overlong commits behind the same public prefix", () => {
    const left = compile(`See example/project@${"a".repeat(65)}1`);
    const right = compile(`See example/project@${"a".repeat(65)}2`);

    expect(left.findings[0]?.commitPrefix).toBe("aaaa");
    expect(right.findings[0]?.commitPrefix).toBe("aaaa");
    expect(left.findings[0]?.findingFingerprint).not.toBe(
      right.findings[0]?.findingFingerprint,
    );
  });

  test("rejects realistic credential-shaped controlled and target repositories", () => {
    for (const repository of [
      `example/github_pat_${"a".repeat(20)}`,
      `example/ghp_${"a".repeat(20)}`,
      `example/sk-proj-${"a".repeat(20)}`,
      `example/stn.tok_${"a".repeat(20)}`,
      `example/xoxb-${"a".repeat(16)}`,
      `example/eyJ${"a".repeat(8)}.eyJ${"b".repeat(8)}.${"c".repeat(8)}`,
    ]) {
      const error = captureError(() =>
        compileGitHubOutboundTextPreflightV1(input("safe", {
          repositoryFullName: repository,
          controlledRepositories: [repository],
        }))
      );
      expect(error.message).toBe(
        "GitHub outbound repository identity is credential-shaped",
      );
      expect(error.message).not.toContain(repository);
      expect(JSON.stringify(error)).not.toContain(repository);
    }
  });

  test("rejects credential-shaped repositories detected in URLs and shorthand", () => {
    const secretRepository = `github_pat_${"a".repeat(20)}`;
    for (const text of [
      `https://github.com/example/${secretRepository}/issues/12`,
      `See example/${secretRepository}#12`,
      `Review example/${secretRepository}@abcdef0`,
    ]) {
      const error = captureError(() => compile(text));
      expect(error.message).toBe(
        "GitHub outbound repository identity is credential-shaped",
      );
      expect(error.message).not.toContain(secretRepository);
      expect(JSON.stringify(error)).not.toContain(secretRepository);
    }
  });

  test("admits benign short token-like repository names", () => {
    for (const text of [
      "See example/github_pat_review#12",
      "Review example/ghp_review@abcdef0",
      "See example/sk-proj-review#13",
      "Review example/xoxb-review@abcdef0",
    ]) {
      const result = compile(text);
      expect(result.decision).toBe("reject");
      expect(result.findings).toHaveLength(1);
    }
  });

  test("preserves CRLF, lone CR, trailing whitespace, and final-newline identity", () => {
    const crlf = "first\r\nSee example/project#12\r\n";
    const lf = "first\nSee example/project#12\n";
    const loneCr = "prefix\rexample/project#13  ";

    const crlfResult = compile(crlf);
    const lfResult = compile(lf);
    const loneCrResult = compile(loneCr);

    expect(crlfResult.textSha256).toBe(sha256(crlf));
    expect(crlfResult.textByteLength).toBe(Buffer.byteLength(crlf, "utf8"));
    expect(crlfResult.findings[0]).toMatchObject({ line: 2, column: 5 });
    expect(loneCrResult.findings[0]).toMatchObject({ line: 1, column: 8 });
    expect(crlfResult.textSha256).not.toBe(lfResult.textSha256);
    expect(crlfResult.inputFingerprint).not.toBe(lfResult.inputFingerprint);
    expect(crlfResult.resultFingerprint).not.toBe(lfResult.resultFingerprint);
  });

  test("rejects unpaired surrogates before exact text hashing", () => {
    expect(() => compile("before \ud800 after")).toThrow(
      "GitHub outbound text is invalid",
    );
    expect(() => compile("before \udc00 after")).toThrow(
      "GitHub outbound text is invalid",
    );

    const replacement = compile("before \ufffd after");
    expect(replacement.decision).toBe("pass");
    expect(replacement.textSha256).toBe(sha256("before \ufffd after"));
  });
});

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}
