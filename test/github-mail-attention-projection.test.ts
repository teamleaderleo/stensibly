import { describe, expect, test } from "bun:test";
import { compileCurrentGitHubMailAttention } from "../src/github-mail-attention-projection.ts";
import type {
  AdmittedGitHubTerminalStatusObservation,
  GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import { sha256, stableJson } from "../src/github-provider-validation.ts";

const repository = "teamleaderleo/stensibly";
const currentHead = "a".repeat(40);
const staleHead = "b".repeat(40);
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "attn_1491_exact_head",
  handle: "STN-INCIDENT:1491EXACT",
  project: "stensibly",
  repository,
  pullRequestNumber: 1491,
  currentHeadRevision: currentHead,
  continuesFromThreadId: null,
};

function terminal(revision: string): AdmittedGitHubTerminalStatusObservation {
  const semantics = {
    version: 1 as const,
    provider: "github" as const,
    sourceSchema: "check_run" as const,
    repository,
    pullRequestNumber: 1491,
    revision,
    providerObjectId: "8808",
    conclusion: "failure" as const,
    sourceTime: "2026-08-15T06:50:00.000Z",
    containsRawContent: false as const,
  };
  return {
    ...semantics,
    observationId: `github-mail-terminal:check_run:${revision[0]}`,
    deliveryId: `delivery-${revision[0]}`,
    semanticFingerprint: sha256(stableJson(semantics)),
  };
}

describe("current GitHub mail attention projection", () => {
  test("accepts terminal status for the exact current PR head", () => {
    expect(compileCurrentGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: terminal(currentHead) },
    })).toMatchObject({
      currentHeadRevision: currentHead,
      attentionClass: "incident",
      reason: "ci_failed",
      mailAction: "update",
    });
  });

  test("rejects a late terminal status from an older head even when GitHub names the same PR", () => {
    expect(() => compileCurrentGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: terminal(staleHead) },
    })).toThrow("stale pull request revision");
  });
});
