import { describe, expect, test } from "bun:test";
import {
  classifyGitHubMailReply,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import {
  classifyGitHubFormalReviewMailReply,
  type GitHubMailFormalReviewAuthorityBinding,
} from "../src/github-mail-formal-review-projection.ts";
import { parseMailThreadHandle } from "../src/mail-thread-contract.ts";

const head = "b".repeat(40);
const targetRevision = `sha256:${"a".repeat(64)}`;

function thread(handle: string): GitHubMailThreadBinding {
  return {
    version: 1,
    threadId: "attn_1508",
    handle,
    project: "stensibly",
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 1508,
    currentHeadRevision: head,
    continuesFromThreadId: null,
  };
}

const causal = Object.freeze({
  rootId: "github:pull_request:1508",
  predecessorId: "gmail-parent-1508",
  depth: 1,
  fanOut: 1,
});

function formalAuthority(handle: string): GitHubMailFormalReviewAuthorityBinding {
  return {
    version: 1,
    threadId: thread(handle).threadId,
    provider: "gmail",
    mailboxBindingId: "gmail_primary",
    expectedMailboxAddress: "operator@example.com",
    providerThreadId: "gmail-thread-1508",
    expectedInReplyToMessageId: "gmail-parent-1508",
    messageDisposition: "direct_human_reply",
    effectCapability: "github_formal_review",
    expectedTargetSourceRevision: targetRevision,
    expectedHeadRevision: head,
    formalReviewVerdict: "APPROVE",
    causal,
  };
}

function classifyCoordination(handle: string, body: string) {
  return classifyGitHubMailReply({
    thread: thread(handle),
    provider: "gmail",
    mailboxBindingId: "gmail_primary",
    providerThreadId: "gmail-thread-1508",
    providerMessageId: "gmail-message-1508",
    inReplyToMessageId: "gmail-parent-1508",
    replyClass: "mail.note",
    body,
    expectedTargetSourceRevision: targetRevision,
    expectedHeadRevision: head,
    causal,
  });
}

function classifyFormal(handle: string, body: string) {
  return classifyGitHubFormalReviewMailReply({
    thread: thread(handle),
    provider: "gmail",
    mailboxBindingId: "gmail_primary",
    providerThreadId: "gmail-thread-1508",
    providerMessageId: "gmail-review-message-1508",
    inReplyToMessageId: "gmail-parent-1508",
    replyClass: "mail.github_review_proposal",
    body,
    expectedTargetSourceRevision: targetRevision,
    expectedHeadRevision: head,
    formalReviewVerdict: "APPROVE",
    causal,
    authority: formalAuthority(handle),
  });
}

function canonicalError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Mail thread handle is invalid");
    return error as Error;
  }
  throw new Error("expected canonical STN handle rejection");
}

describe("GitHub/mail canonical STN handle integration", () => {
  test("admits the same canonical outbound handles in both bridge paths", () => {
    const handoff = parseMailThreadHandle("STN-HANDOFF:Q7MP");
    const review = parseMailThreadHandle("STN-REVIEW:E5T7");

    const coordination = classifyCoordination(handoff, "Private coordination only.");
    expect(coordination).toMatchObject({
      threadId: "attn_1508",
      semantic: "private_coordination",
      effect: null,
    });

    const formal = classifyFormal(review, "Approved after exact review.");
    expect(formal.effect).toMatchObject({
      kind: "github_formal_review",
      threadId: "attn_1508",
      expectedHeadRevision: head,
      verdict: "APPROVE",
    });
  });

  test("rejects eye-confusing and overlong handles identically before effect classification", () => {
    for (const invalidHandle of [
      "STN-HANDOFF:O0O0",
      "STN-HANDOFF:ABCDEFGH2",
    ]) {
      const direct = canonicalError(() => parseMailThreadHandle(invalidHandle));

      let coordinationBodyReads = 0;
      const coordinationInput: Record<string, unknown> = {
        thread: thread(invalidHandle),
        provider: "gmail",
        mailboxBindingId: "gmail_primary",
        providerThreadId: "gmail-thread-1508",
        providerMessageId: "gmail-invalid-message-1508",
        inReplyToMessageId: "gmail-parent-1508",
        replyClass: "mail.note",
        expectedTargetSourceRevision: targetRevision,
        expectedHeadRevision: head,
        causal,
      };
      Object.defineProperty(coordinationInput, "body", {
        enumerable: true,
        get() {
          coordinationBodyReads += 1;
          throw new Error("body must remain unread");
        },
      });
      const bridge = canonicalError(() =>
        classifyGitHubMailReply(coordinationInput as never)
      );

      const formal = canonicalError(() =>
        classifyGitHubFormalReviewMailReply({
          thread: thread(invalidHandle),
          provider: "gmail",
          mailboxBindingId: "gmail_primary",
          providerThreadId: "gmail-thread-1508",
          providerMessageId: "gmail-invalid-review-message-1508",
          inReplyToMessageId: "gmail-parent-1508",
          replyClass: "mail.github_review_proposal",
          body: "Formal review body remains unclassified.",
          expectedTargetSourceRevision: targetRevision,
          expectedHeadRevision: head,
          formalReviewVerdict: "APPROVE",
          causal,
          authority: formalAuthority("STN-REVIEW:E5T7"),
        })
      );

      expect(bridge.message).toBe(direct.message);
      expect(formal.message).toBe(direct.message);
      expect(coordinationBodyReads).toBe(0);
    }
  });
});
