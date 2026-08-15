import { describe, expect, test } from "bun:test";
import {
  classifyGitHubMailReply,
  type GitHubMailReplyAuthorityBinding,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import {
  classifyGitHubFormalReviewMailReply,
  type GitHubMailFormalReviewAuthorityBinding,
} from "../src/github-mail-formal-review-projection.ts";

const head = "a".repeat(40);
const source = `sha256:${"b".repeat(64)}`;
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "STN-REVIEW:M7K4",
  handle: "STN-REVIEW:M7K4",
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  pullRequestNumber: 1517,
  currentHeadRevision: head,
  continuesFromThreadId: null,
};
const causal = {
  rootId: "github:pull_request:trusted-root",
  predecessorId: "mail:parent-1517",
  depth: 1,
  fanOut: 0,
};

function commentAuthority(
  overrides: Partial<GitHubMailReplyAuthorityBinding> = {},
): GitHubMailReplyAuthorityBinding {
  return {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    mailboxBindingId: "gmail:operator",
    expectedMailboxAddress: "operator@example.com",
    providerThreadId: "gmail-thread-1517",
    expectedInReplyToMessageId: "mail-parent-1517",
    messageDisposition: "direct_human_reply",
    effectCapability: "github_conversation_comment",
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    formalReviewVerdict: null,
    causal,
    ...overrides,
  };
}

function commentInput(overrides: Record<string, unknown> = {}) {
  return {
    thread,
    provider: "gmail" as const,
    mailboxBindingId: "gmail:operator",
    providerThreadId: "gmail-thread-1517",
    providerMessageId: "mail-reply-1517",
    inReplyToMessageId: "mail-parent-1517",
    replyClass: "mail.github_comment_proposal" as const,
    body: "Bound harmless conversation comment.",
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    causal,
    authority: commentAuthority(),
    ...overrides,
  };
}

function formalAuthority(
  overrides: Partial<GitHubMailFormalReviewAuthorityBinding> = {},
): GitHubMailFormalReviewAuthorityBinding {
  return {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    mailboxBindingId: "gmail:operator",
    expectedMailboxAddress: "operator@example.com",
    providerThreadId: "gmail-thread-1517",
    expectedInReplyToMessageId: "mail-parent-1517",
    messageDisposition: "direct_human_reply",
    effectCapability: "github_formal_review",
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    formalReviewVerdict: "COMMENT",
    causal,
    ...overrides,
  };
}

function formalInput(overrides: Record<string, unknown> = {}) {
  return {
    thread,
    provider: "gmail" as const,
    mailboxBindingId: "gmail:operator",
    providerThreadId: "gmail-thread-1517",
    providerMessageId: "mail-review-1517",
    inReplyToMessageId: "mail-parent-1517",
    replyClass: "mail.github_review_proposal" as const,
    body: "Bound harmless formal review comment.",
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    formalReviewVerdict: "COMMENT" as const,
    causal,
    authority: formalAuthority(),
    ...overrides,
  };
}

describe("exact mailbox authority composition", () => {
  test("ordinary comment exact replay is idempotent and alias authority drift conflicts", () => {
    const first = classifyGitHubMailReply(commentInput());
    expect(first.effect).toMatchObject({
      kind: "github_conversation_comment",
      repository: "teamleaderleo/stensibly",
      pullRequestNumber: 1517,
    });
    const replay = classifyGitHubMailReply(commentInput({ previousAdmission: first }));
    expect(replay.replay).toBe(true);
    expect(replay.effect?.effectId).toBe(first.effect?.effectId);

    expect(() => classifyGitHubMailReply(commentInput({
      previousAdmission: first,
      authority: commentAuthority({ expectedMailboxAddress: "operator+other@example.com" }),
    }))).toThrow("replayed with changed semantics");
  });

  test("formal COMMENT uses the same mailbox authority and rejects alias drift on replay", () => {
    const first = classifyGitHubFormalReviewMailReply(formalInput());
    expect(first.effect).toMatchObject({
      kind: "github_formal_review",
      verdict: "COMMENT",
      repository: "teamleaderleo/stensibly",
      pullRequestNumber: 1517,
    });
    const replay = classifyGitHubFormalReviewMailReply(formalInput({ previousAdmission: first }));
    expect(replay.replay).toBe(true);
    expect(replay.effect.effectId).toBe(first.effect.effectId);

    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      previousAdmission: first,
      authority: formalAuthority({ expectedMailboxAddress: "operator+review@example.com" }),
    }))).toThrow("changed formal-review semantics");
  });

  test("missing exact destination fails closed before either effect is created", () => {
    const comment = commentAuthority() as GitHubMailReplyAuthorityBinding & {
      expectedMailboxAddress?: string;
    };
    delete comment.expectedMailboxAddress;
    expect(() => classifyGitHubMailReply(commentInput({ authority: comment })))
      .toThrow("exact server-owned mailbox destination");

    const formal = formalAuthority() as GitHubMailFormalReviewAuthorityBinding & {
      expectedMailboxAddress?: string;
    };
    delete formal.expectedMailboxAddress;
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({ authority: formal })))
      .toThrow("exact server-owned mailbox destination");
  });

  test("same provider message cannot replay onto a different canonical repository target", () => {
    const first = classifyGitHubMailReply(commentInput());
    expect(() => classifyGitHubMailReply(commentInput({
      previousAdmission: first,
      thread: { ...thread, repository: "teamleaderleo/other-project" },
    }))).toThrow("replayed with changed semantics");
  });
});