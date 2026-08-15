import { describe, expect, test } from "bun:test";
import {
  classifyGitHubMailReply,
  compileGitHubMailAttention,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";

const revision = "a".repeat(40);

function thread(handle: string): GitHubMailThreadBinding {
  return {
    version: 1,
    threadId: "mail_thread_1508",
    handle,
    project: "stensibly",
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 1490,
    currentHeadRevision: revision,
    continuesFromThreadId: null,
  };
}

function reply(handle: string) {
  return {
    thread: thread(handle),
    provider: "outlook" as const,
    mailboxBindingId: "outlook_operator_primary",
    providerThreadId: "AAQk_conversation_1508",
    providerMessageId: "AAMk_message_1508",
    inReplyToMessageId: "AAMk_parent_1508",
    replyClass: "mail.github_comment_proposal" as const,
    body: "Continue the exact current checkpoint.",
    expectedTargetSourceRevision: "issue-revision-1508",
    expectedHeadRevision: revision,
    causal: {
      rootId: "mail-1508-root",
      predecessorId: null,
      depth: 0,
      fanOut: 0,
    },
  };
}

describe("GitHub mail canonical STN handle admission", () => {
  test("uses the shared eye-safe handle grammar", () => {
    const admitted = compileGitHubMailAttention({
      thread: thread("stn-handoff:k8r4"),
      signal: {
        kind: "terminal_status",
        observation: {
          version: 1,
          provider: "github",
          sourceSchema: "check_run",
          observationId: "github-observation-1508",
          deliveryId: "github-delivery-1508",
          semanticFingerprint: "sha256:" + "b".repeat(64),
          repository: "teamleaderleo/stensibly",
          pullRequestNumber: 1490,
          revision,
          providerObjectId: "check-run-1508",
          conclusion: "success",
          sourceTime: "2026-08-15T07:40:00.000Z",
          containsRawContent: false,
        },
      },
    });
    expect(admitted.handle).toBe("STN-HANDOFF:K8R4");
  });

  test("rejects eye-confusing and overlong handles before effect authority classification", () => {
    for (const invalid of ["STN-HANDOFF:O0O0", "STN-HANDOFF:ABCDEFGH2"]) {
      expect(() => classifyGitHubMailReply(reply(invalid)))
        .toThrow("STN mail handle is invalid");
    }
  });
});
