import { describe, expect, test } from "bun:test";
import type { GitHubMailAttentionDecision } from "../src/github-mail-bridge-core.ts";
import { compileGitHubMailMaterial } from "../src/github-mail-material-compiler.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const revision = "a".repeat(40);

function attention(
  overrides: Partial<GitHubMailAttentionDecision> = {},
): GitHubMailAttentionDecision {
  return {
    version: 1,
    threadId: "mail_thread_quarry_1",
    handle: "STN-REVIEW:7K3Q",
    repository: "Coreys-Quarry/quarry",
    pullRequestNumber: 666,
    currentHeadRevision: revision,
    sourceObservationId: "github_observation_1",
    sourceSemanticFingerprint: sha("b"),
    repositorySemantic: "pr_lifecycle",
    attentionClass: "review",
    mailAction: "update",
    reason: "pr_review_ready",
    requiresMaterialityDecision: false,
    returningEffectId: null,
    loopSuppressed: false,
    deduped: false,
    materialFingerprint: sha("c"),
    ...overrides,
  };
}

describe("GitHub mail material compiler", () => {
  test("compiles review-ready state into deterministic provider-neutral material", () => {
    const input = attention();
    const first = compileGitHubMailMaterial(input);
    const second = compileGitHubMailMaterial(input);

    expect(first).toEqual(second);
    expect(first).toEqual({
      threadClass: "review",
      sourceIdentity: "github:Coreys-Quarry/quarry#666",
      canonicalSubject: "Coreys-Quarry/quarry PR #666",
      sourceFingerprint: sha("c"),
      whatChanged: "Pull request #666 is ready for review.",
      attentionReason: "The tracked candidate entered review-ready state.",
      nextAction: "Refresh the pull request head, reviews, and required checks, then perform the eligible exact-head review.",
      sourceObject: "github:Coreys-Quarry/quarry#666",
      sourceRevision: revision,
      blocker: null,
      resolutionCondition: "A current-head review verdict is recorded or the candidate changes or is superseded.",
      threadState: "open",
      references: [],
    });
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("keeps one existing thread class while compiling a CI incident", () => {
    const result = compileGitHubMailMaterial(attention({
      reason: "ci_failed",
      repositorySemantic: "terminal_status",
      attentionClass: "incident",
    }));

    expect(result?.threadClass).toBe("review");
    expect(result?.threadState).toBe("open");
    expect(result?.blocker).toBe("Required CI is failing on the observed candidate.");
    expect(result?.nextAction).toContain("Refresh the exact current head and failing checks");
  });

  test("compiles terminal repository state as one resolved checkpoint", () => {
    const result = compileGitHubMailMaterial(attention({
      mailAction: "resolve",
      reason: "pr_merged",
      attentionClass: "none",
    }));

    expect(result?.threadState).toBe("resolved");
    expect(result?.whatChanged).toBe("Pull request #666 merged.");
    expect(result?.resolutionCondition).toBe("The tracked pull request lifecycle is merged.");
  });

  test("stays quiet for routine, replayed, loop-suppressed, and unresolved-materiality input", () => {
    expect(compileGitHubMailMaterial(attention({
      mailAction: "quiet",
      reason: "pr_head_changed",
      attentionClass: "none",
    }))).toBeNull();

    expect(compileGitHubMailMaterial(attention({ deduped: true }))).toBeNull();
    expect(compileGitHubMailMaterial(attention({ loopSuppressed: true }))).toBeNull();
    expect(compileGitHubMailMaterial(attention({
      reason: "inline_review_finding_observed",
      repositorySemantic: "inline_review_finding",
      requiresMaterialityDecision: true,
    }))).toBeNull();
  });

  test("fails closed on unsupported decision versions and invalid internal handles", () => {
    expect(() => compileGitHubMailMaterial(attention({ version: 2 as 1 }))).toThrow(
      "GitHub mail attention decision version is unsupported",
    );
    expect(() => compileGitHubMailMaterial(attention({ handle: "QRY-REVIEW:7K3Q" }))).toThrow(
      "Mail thread handle is invalid",
    );
  });
});
