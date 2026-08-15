import { describe, expect, test } from "bun:test";
import {
  classifyGitHubMailReply,
  type GitHubMailReplyAuthorityBinding,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import { consumeExistingGitHubFormalReviewProposal } from "../src/github-mail-existing-formal-review.ts";

const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "STN-REVIEW:E5T7",
  handle: "STN-REVIEW:E5T7",
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  pullRequestNumber: 777,
  currentHeadRevision: "1111111111111111111111111111111111111111",
  continuesFromThreadId: null,
};

function authority(
  input: {
    providerThreadId: string;
    parentMessageId: string;
    targetRevision: string;
    effectCapability: "github_conversation_comment" | "github_formal_review";
    formalReviewVerdict: "APPROVE" | null;
    causalRoot: string;
  },
): GitHubMailReplyAuthorityBinding {
  return {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    mailboxBindingId: "gmail:primary",
    providerThreadId: input.providerThreadId,
    expectedInReplyToMessageId: input.parentMessageId,
    messageDisposition: "direct_human_reply",
    effectCapability: input.effectCapability,
    expectedTargetSourceRevision: input.targetRevision,
    expectedHeadRevision: thread.currentHeadRevision,
    formalReviewVerdict: input.formalReviewVerdict,
    causal: {
      rootId: input.causalRoot,
      predecessorId: input.parentMessageId,
      depth: 1,
      fanOut: 1,
    },
  };
}

describe("existing #1491 formal-review proposal consumption", () => {
  test("preserves exact APPROVE reply/effect identities without reclassification", () => {
    const targetRevision =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const trusted = authority({
      providerThreadId: "gmail-thread-existing",
      parentMessageId: "gmail-parent-existing",
      targetRevision,
      effectCapability: "github_formal_review",
      formalReviewVerdict: "APPROVE",
      causalRoot: "github:pull_request:existing-root",
    });
    const existing = classifyGitHubMailReply({
      thread,
      provider: "gmail",
      mailboxBindingId: "gmail:primary",
      providerThreadId: "gmail-thread-existing",
      providerMessageId: "gmail-message-existing",
      inReplyToMessageId: "gmail-parent-existing",
      replyClass: "mail.github_review_proposal",
      body: "Approved after exact review.",
      expectedTargetSourceRevision: targetRevision,
      expectedHeadRevision: thread.currentHeadRevision,
      formalReviewVerdict: "APPROVE",
      causal: trusted.causal,
      authority: trusted,
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
    const targetRevision =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const trusted = authority({
      providerThreadId: "gmail-thread-comment",
      parentMessageId: "gmail-parent-comment",
      targetRevision,
      effectCapability: "github_conversation_comment",
      formalReviewVerdict: null,
      causalRoot: "github:pull_request:comment-root",
    });
    const ordinary = classifyGitHubMailReply({
      thread,
      provider: "gmail",
      mailboxBindingId: "gmail:primary",
      providerThreadId: "gmail-thread-comment",
      providerMessageId: "gmail-message-comment",
      inReplyToMessageId: "gmail-parent-comment",
      replyClass: "mail.github_comment_proposal",
      body: "Conversation residue.",
      expectedTargetSourceRevision: targetRevision,
      expectedHeadRevision: thread.currentHeadRevision,
      causal: trusted.causal,
      authority: trusted,
    });
    expect(() => consumeExistingGitHubFormalReviewProposal(ordinary))
      .toThrow("not a typed GitHub formal-review proposal");
  });
});
