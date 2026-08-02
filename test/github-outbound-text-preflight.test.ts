import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundExternalReferenceDisposition,
} from "../src/github-outbound-text-preflight.ts";

const targetRepository = "teamleaderleo/stensibly";

function policy(
  disposition: GitHubOutboundExternalReferenceDisposition = "reject",
  controlledRepositories: readonly string[] = [targetRepository],
) {
  return {
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: "outbound-policy-w01",
    controlledRepositories,
    externalReferenceDisposition: disposition,
  };
}

function input(
  text: string,
  overrides: Partial<{
    schemaVersion: 1;
    policy: ReturnType<typeof policy>;
    repositoryFullName: string;
    field: "title" | "body" | "comment" | "review" | "inline_review";
  }> = {},
) {
  return {
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: policy(),
    repositoryFullName: targetRepository,
    field: "comment" as const,
    text,
    ...overrides,
  };
}

describe("GitHub outbound text preflight", () => {
  test("passes controlled references without granting provider authority", () => {
    const text = [
      "See https://github.com/teamleaderleo/stensibly/issues/573.",
      "Related teamleaderleo/stensibly#921.",
      "Revision teamleaderleo/stensibly@22495e4.",
    ].join("\n");
    const result = compileGitHubOutboundTextPreflightV1(input(text));

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.textSha256).toBe(sha256(text));
    expect(result.authorizesProviderMutation).toBe(false);
    expect(result.authorizesExternalInteraction).toBe(false);
    expect(result.grantsAuthority).toBe(false);
  });

  test("detects direct issue, pull request, discussion, and commit URLs", () => {
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    const text = [
      "Issue https://github.com/example/project/issues/12",
      "PR https://github.com/example/project/pull/13",
      "Discussion https://github.com/example/project/discussions/14",
      `Commit https://github.com/example/project/commit/${commit}`,
    ].join("\n");
    const result = compileGitHubOutboundTextPreflightV1(input(text));

    expect(result.decision).toBe("reject");
    expect(result.findings.map((finding) => finding.referenceKind)).toEqual([
      "issue",
      "pull_request",
      "discussion",
      "commit",
    ]);
    expect(result.findings.map((finding) => finding.itemNumber)).toEqual([
      12,
      13,
      14,
      null,
    ]);
    expect(result.findings[3]?.commitPrefix).toBe("abcd");
    expect(result.findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("https://github.com/example/project");
    expect(serialized).not.toContain("example/project#");
    expect(serialized).not.toContain(commit);
    expect(serialized).not.toContain("Issue https");
  });

  test("classifies repository shorthand without guessing issue versus pull request", () => {
    const text = "Please inspect Example/Project#42 before continuing.";
    const result = compileGitHubOutboundTextPreflightV1(input(text));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "repository_shorthand",
      referenceKind: "issue_or_pull_request",
      externalOwner: "example",
      externalRepository: "project",
      itemNumber: 42,
      commitPrefix: null,
    });
  });

  test("detects commit shorthand and retains only a non-reconstructing prefix", () => {
    const commit = "abcdef0";
    const result = compileGitHubOutboundTextPreflightV1(input(
      `Review example/project@${commit}.`,
    ));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "commit_shorthand",
      referenceKind: "commit",
      commitPrefix: "abcd",
      itemNumber: null,
    });
    expect(JSON.stringify(result)).not.toContain(commit);
  });

  test("marks external closing expressions without retaining the expression", () => {
    const text = "Fixes example/project#88";
    const result = compileGitHubOutboundTextPreflightV1(input(text));

    expect(result.findings[0]?.rule).toBe("external_closing_reference");
    expect(JSON.stringify(result)).not.toContain("Fixes");
    expect(JSON.stringify(result)).not.toContain("example/project#88");
  });

  test("returns requires_authority without granting authority", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "See example/project#9",
      { policy: policy("require_authority") },
    ));

    expect(result.decision).toBe("requires_authority");
    expect(result.findings[0]?.authorityRequired).toBe(true);
    expect(result.authorizesExternalInteraction).toBe(false);
    expect(result.grantsAuthority).toBe(false);
  });

  test("treats every explicitly controlled repository as internal", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "See example/project#9 and teamleaderleo/stensibly#573",
      {
        policy: policy("reject", [
          "example/project",
          "teamleaderleo/stensibly",
        ]),
      },
    ));

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  test("does not duplicate shorthand inside an admitted direct URL", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "https://github.com/example/project/issues/12",
    ));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.source).toBe("direct_url");
  });

  test("does not treat a short numeric commit path as a Git commit", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "https://github.com/example/project/commit/123",
    ));

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  test("blocks syntactic external references even when the item number is outside provider range", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "See example/project#2147483648",
    ));

    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.referenceKind).toBe("issue_or_pull_request");
    expect(result.findings[0]?.itemNumber).toBeNull();
  });

  test("reports Unicode-aware line and column positions", () => {
    const result = compileGitHubOutboundTextPreflightV1(input(
      "😀 prefix\nSee example/project#5",
    ));

    expect(result.findings[0]?.line).toBe(2);
    expect(result.findings[0]?.column).toBe(5);
  });

  test("requires sorted unique canonical controlled repositories and controlled target", () => {
    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: policy("reject", [
        "teamleaderleo/stensibly",
        "example/project",
      ]),
    }))).toThrow("canonical sorted order");

    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: policy("reject", [
        "teamleaderleo/stensibly",
        "teamleaderleo/stensibly",
      ]),
    }))).toThrow("must be unique");

    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      repositoryFullName: "example/project",
    }))).toThrow("must be controlled");

    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      repositoryFullName: "TeamLeaderLeo/Stensibly",
    }))).toThrow("canonical lowercase identity");
  });

  test("rejects unsupported fields, unsafe text, and oversized text", () => {
    expect(() => compileGitHubOutboundTextPreflightV1({
      ...input("safe"),
      field: "description",
    })).toThrow("field is unsupported");

    expect(() => compileGitHubOutboundTextPreflightV1(input("unsafe\u202e")))
      .toThrow("text is invalid");

    expect(() => compileGitHubOutboundTextPreflightV1(input(
      "x".repeat(128 * 1024 + 1),
    ))).toThrow("byte budget");
  });

  test("rejects more than the bounded number of external references", () => {
    const text = Array.from(
      { length: 101 },
      (_, index) => `example/project#${index + 1}`,
    ).join(" ");

    expect(() => compileGitHubOutboundTextPreflightV1(input(text)))
      .toThrow("at most 100 external references");
  });

  test("rejects hostile input and policy descriptors without invoking getters", () => {
    let inputReads = 0;
    const hostileInput = Object.defineProperty(input("safe"), "text", {
      enumerable: true,
      configurable: true,
      get() {
        inputReads += 1;
        throw new Error("private outbound text");
      },
    });
    expect(() => compileGitHubOutboundTextPreflightV1(hostileInput))
      .toThrow("enumerable data properties");
    expect(inputReads).toBe(0);

    let policyReads = 0;
    const hostilePolicy = Object.defineProperty(policy(), "policyId", {
      enumerable: true,
      configurable: true,
      get() {
        policyReads += 1;
        throw new Error("private policy value");
      },
    });
    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: hostilePolicy as ReturnType<typeof policy>,
    }))).toThrow("enumerable data properties");
    expect(policyReads).toBe(0);
  });

  test("rejects sparse, decorated, and accessor-bearing controlled-repository lists", () => {
    const sparse = [targetRepository, , "example/project"];
    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: policy("reject", sparse as string[]),
    }))).toThrow("dense data entries");

    const decorated = [targetRepository] as string[] & { note?: string };
    decorated.note = "unexpected";
    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: policy("reject", decorated),
    }))).toThrow("dense data entries");

    let reads = 0;
    const accessor = [targetRepository];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return targetRepository;
      },
    });
    expect(() => compileGitHubOutboundTextPreflightV1(input("safe", {
      policy: policy("reject", accessor),
    }))).toThrow("dense data entries");
    expect(reads).toBe(0);
  });

  test("produces deterministic deeply immutable results", () => {
    const left = compileGitHubOutboundTextPreflightV1(input(
      "See example/project#12",
    ));
    const right = compileGitHubOutboundTextPreflightV1(input(
      "See example/project#12",
    ));

    expect(left).toEqual(right);
    expect(left.resultFingerprint).toBe(right.resultFingerprint);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.findings)).toBe(true);
    expect(Object.isFrozen(left.findings[0])).toBe(true);
    expect(() => {
      (left as { decision: string }).decision = "pass";
    }).toThrow();
    expect(left.decision).toBe("reject");
  });
});
