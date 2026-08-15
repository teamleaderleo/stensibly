import { describe, expect, test } from "bun:test";
import {
  classifyGitHubMailReply,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import { consumeExistingGitHubFormalReviewProposal } from "../src/github-mail-existing-formal-review.ts";

const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "STN-REVIEW:EXIST1",
  handle: "STN-REVIEW:EXIST1",
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  pullRequestNumber: 777,
  currentHeadRevision: "1111111111111111111111111111111111111111",
  continuesFromThreadId: null,
};

describe("existing #1491 formal-review proposal consumption", () => {
  test("preserves exact APPROVE reply/effect identities without reclassification", () => {
    const existing = classifyGitHubMailReply({
      thread,
      provider: "gmail",
      mailboxBindingId: "gmail:primary",
      providerThreadId: "gmail-thread-existing",
      providerMessageId: "gmail-message-existing",
      inReplyToMessageId: "gmail-parent-existing",
      replyClass: "mail.github_review_proposal",
      body: "Approved after exact review.",
      expectedTargetSourceRevision:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      expectedHeadRevision: thread.currentHeadRevision,
      formalReviewVerdict: "APPROVE",
      causal: {
        rootId: "github:pull_request:existing-root",
        predecessorId: "stn-mail-existing",
        depth: 1,
        fanOut: 1,
      },
    });
    if (existing.effect?.kind !== "github_formal_review") {
      throw new Error("expected existing formal review effect");
    }

    const consumed = consumeExistingGitHubFormalReviewProposal(existing);
    expect(consumed.replyId).toBe(existing.replyId);
    expect(consumed.replyFingerprint).toBe(existing.replyFingerprint);
    expect(consumed.effect.effectId).toBe(existing.effect.effectId);
    expect(consumed.effect.sourceMailReplyId).toBe(existing.effect.sourceMailReplyId);
    expect(consumed.effect.verdict).toBe("APPROVE");
    expect(consumed.effect.causal).toEqual(existing.effect.causal);
  });

  test("rejects ordinary Conversation-comment admissions", () => {
    const ordinary = classifyGitHubMailReply({
      thread,
      provider: "gmail",
      mailboxBindingId: "gmail:primary",
      providerThreadId: "gmail-thread-comment",
      providerMessageId: "gmail-message-comment",
      inReplyToMessageId: "gmail-parent-comment",
      replyClass: "mail.github_comment_proposal",
      body: "Conversation residue.",
      expectedTargetSourceRevision:
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      expectedHeadRevision: thread.currentHeadRevision,
      causal: {
        rootId: "github:pull_request:comment-root",
        predecessorId: "stn-mail-comment",
        depth: 1,
        fanOut: 1,
      },
    });
    expect(() => consumeExistingGitHubFormalReviewProposal(ordinary))
      .toThrow("not a typed GitHub formal-review proposal");
  });
});
