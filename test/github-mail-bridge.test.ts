import { describe, expect, test } from "bun:test";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  classifyGitHubMailReply,
  compileGitHubMailAttention,
  executeGitHubConversationCommentEffect,
  MAX_GITHUB_MAIL_CAUSAL_DEPTH,
  type AdmittedGitHubTerminalStatusObservation,
  type GitHubConversationCommentEffect,
  type GitHubMailCommentProvider,
  type GitHubMailProjectedEffectReceipt,
  type GitHubMailReplyAuthorityBinding,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "../src/github-provider-contracts.ts";
import {
  canonicalBody,
  sha256,
  stableJson,
} from "../src/github-provider-validation.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const base = "c".repeat(40);
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "attn_1491",
  handle: "STN-REVIEW:1491",
  project: "stensibly",
  repository,
  pullRequestNumber: 1491,
  currentHeadRevision: headA,
  continuesFromThreadId: null,
};

function common(): Record<string, unknown> {
  return {
    repository: { full_name: repository },
    sender: { login: "teamleaderleo" },
  };
}

function map(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): GitHubRepositoryObservation {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const observation = mapGitHubRepositoryWebhook({
    eventType,
    deliveryId,
    payloadDigest: digestGitHubWebhookPayload(bytes),
    payload,
    signatureVerified: true,
    receivedAt: "2026-08-15T06:30:00.000Z",
    expectedRepository: repository,
  });
  if (!observation) throw new Error("Expected GitHub repository observation");
  return observation;
}

function pullRequest(
  action: string,
  revision: string,
  deliveryId: string,
  draft = false,
): GitHubRepositoryObservation {
  return map("pull_request", {
    ...common(),
    action,
    number: 1491,
    pull_request: {
      number: 1491,
      state: action === "closed" ? "closed" : "open",
      draft,
      locked: false,
      merged: action === "closed",
      updated_at: "2026-08-15T06:29:00.000Z",
      title: "Bridge GitHub and mail",
      body: "Bounded fixture body",
      head: { sha: revision },
      base: { sha: base },
      merge_commit_sha: null,
    },
  }, deliveryId);
}

function review(
  state: "approved" | "changes_requested" | "commented",
  revision: string,
  deliveryId: string,
): GitHubRepositoryObservation {
  return map("pull_request_review", {
    ...common(),
    action: "submitted",
    pull_request: {
      number: 1491,
      updated_at: "2026-08-15T06:29:00.000Z",
    },
    review: {
      id: 7001,
      commit_id: revision,
      state,
      body: state === "approved" ? "Approved" : "Finding",
      submitted_at: "2026-08-15T06:29:30.000Z",
    },
  }, deliveryId);
}

function terminalStatus(
  revision: string,
  conclusion: AdmittedGitHubTerminalStatusObservation["conclusion"],
): AdmittedGitHubTerminalStatusObservation {
  const semantics = {
    sourceSchema: "check_run" as const,
    repository,
    pullRequestNumber: 1491,
    revision,
    providerObjectId: "8801",
    conclusion,
  };
  return {
    version: 1,
    provider: "github",
    sourceSchema: "check_run",
    observationId: `github:check_run:delivery-${conclusion}-${revision[0]}`,
    deliveryId: `delivery-${conclusion}-${revision[0]}`,
    semanticFingerprint: sha256(stableJson(semantics)),
    repository,
    pullRequestNumber: 1491,
    revision,
    providerObjectId: "8801",
    conclusion,
    sourceTime: "2026-08-15T06:29:45.000Z",
    containsRawContent: false,
  };
}

function authorityInput(
  overrides: Partial<GitHubMailReplyAuthorityBinding> = {},
): GitHubMailReplyAuthorityBinding {
  return {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    mailboxBindingId: "mailbox_primary",
    providerThreadId: "gmail-thread-1491",
    expectedInReplyToMessageId: "gmail-message-root",
    messageDisposition: "direct_human_reply",
    effectCapability: "github_conversation_comment",
    expectedTargetSourceRevision: "issue-rev-1",
    expectedHeadRevision: headB,
    formalReviewVerdict: null,
    causal: {
      rootId: "github:pull_request:trusted-root",
      predecessorId: "mail:gmail-message-root",
      depth: 2,
      fanOut: 1,
    },
    ...overrides,
  };
}

function replyInput(overrides: Partial<Parameters<typeof classifyGitHubMailReply>[0]> = {}) {
  return {
    thread: { ...thread, currentHeadRevision: headB },
    provider: "gmail" as const,
    mailboxBindingId: "mailbox_primary",
    providerThreadId: "gmail-thread-1491",
    providerMessageId: "gmail-message-1",
    inReplyToMessageId: "gmail-message-root",
    replyClass: "mail.github_comment_proposal" as const,
    body: "Repository-facing repair note.",
    expectedTargetSourceRevision: "attacker-supplied-target-revision",
    expectedHeadRevision: headA,
    causal: {
      rootId: "mail:attacker-supplied-root",
      predecessorId: "mail:attacker-supplied-parent",
      depth: 0,
      fanOut: 0,
    },
    authority: authorityInput(),
    ...overrides,
  };
}

function fakeProvider(): GitHubMailCommentProvider {
  return {
    async getIssue() {
      return buildGitHubIssueContext({
        owner: "teamleaderleo",
        repository: "stensibly",
        number: 1491,
        title: "Bridge GitHub attention and mail replies",
        body: "Issue body",
        state: "open",
        labels: [],
        assignees: [],
        createdAt: "2026-08-15T05:53:07.000Z",
        updatedAt: "2026-08-15T06:25:00.000Z",
        sourceRevision: "issue-rev-1",
      });
    },
    async addIssueComment(input) {
      const body = canonicalBody(input.body);
      const result = {
        id: "9001",
        issueNumber: 1491,
        canonicalUrl:
          "https://github.com/teamleaderleo/stensibly/issues/1491#issuecomment-9001",
        createdAt: "2026-08-15T06:31:00.000Z",
        updatedAt: "2026-08-15T06:31:00.000Z",
        sourceRevision: "comment-rev-9001",
        bodyRevision: {
          byteLength: Buffer.byteLength(body, "utf8"),
          sha256: sha256(body),
        },
        containsBody: false as const,
      };
      const receipt: GitHubProviderReceipt = {
        version: 1,
        id: "ghop_1491_comment",
        project: "stensibly",
        provider: "github",
        repositoryFullName: repository,
        operation: "github_add_issue_comment",
        target: `${repository}#1491:comment:new`,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "gh_connection",
        installationId: "42",
        bindingId: "gh_binding",
        attachmentId: "attachment_1",
        attachmentSnapshotSha256: "sha256:attachment",
        capabilityGrantId: "grant_comment",
        approvalId: null,
        idempotencyKey: input.idempotencyKey,
        parametersSha256: sha256(stableJson({ body })),
        state: "succeeded",
        attemptCount: 1,
        createdAt: "2026-08-15T06:31:00.000Z",
        updatedAt: "2026-08-15T06:31:00.000Z",
        providerRequestId: "github-request-1",
        result,
        verification: {
          state: "passed",
          checkedAt: "2026-08-15T06:31:00.000Z",
          sourceRevision: result.sourceRevision,
        },
        error: null,
        recovery: { nextAction: "none" },
      };
      return receipt;
    },
  };
}

const providerContext: GitHubProviderRequestContext = {
  project: "stensibly",
  repository,
  actorId: "operator",
  clientId: "github-mail-bridge",
  capabilityGrantId: "grant_comment",
};

describe("GitHub mail bridge", () => {
  test("keeps one STN thread across head change, blocking CI, review readiness, and approval", () => {
    const synchronized = compileGitHubMailAttention({
      thread,
      signal: {
        kind: "repository_observation",
        observation: pullRequest("synchronize", headB, "delivery-sync"),
      },
    });
    expect(synchronized).toMatchObject({
      threadId: thread.threadId,
      currentHeadRevision: headB,
      repositorySemantic: "pr_lifecycle",
      reason: "pr_head_changed",
      mailAction: "quiet",
    });

    const failed = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: { kind: "terminal_status", observation: terminalStatus(headB, "failure") },
    });
    expect(failed).toMatchObject({
      threadId: thread.threadId,
      attentionClass: "incident",
      reason: "ci_failed",
      mailAction: "update",
    });

    const duplicateFailure = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: { kind: "terminal_status", observation: terminalStatus(headB, "failure") },
      priorMaterialFingerprint: failed.materialFingerprint,
    });
    expect(duplicateFailure).toMatchObject({ mailAction: "quiet", deduped: true });

    const ready = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: {
        kind: "repository_observation",
        observation: pullRequest("ready_for_review", headB, "delivery-ready"),
      },
    });
    expect(ready).toMatchObject({
      threadId: thread.threadId,
      attentionClass: "review",
      reason: "pr_review_ready",
      mailAction: "update",
    });

    const approved = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: {
        kind: "repository_observation",
        observation: review("approved", headB, "delivery-approved"),
      },
    });
    expect(approved).toMatchObject({
      threadId: thread.threadId,
      repositorySemantic: "formal_review",
      reason: "formal_review_approved",
      mailAction: "update",
    });
  });

  test("keeps coordination, PR conversation comments, and formal reviews as separate semantics", () => {
    const coordination = classifyGitHubMailReply(replyInput({
      replyClass: "mail.review_finding",
      body: "Keep this finding private while repair is in flight.",
      authority: undefined,
    }));
    expect(coordination.semantic).toBe("private_coordination");
    expect(coordination.effect).toBeNull();
    expect(coordination.authorityFingerprint).toBeNull();
    expect(JSON.stringify(coordination)).not.toContain("Keep this finding private");

    const comment = classifyGitHubMailReply(replyInput());
    expect(comment.semantic).toBe("conversation_comment_proposal");
    expect(comment.authorityFingerprint).toMatch(/^sha256:/);
    expect(comment.effect).toMatchObject({
      kind: "github_conversation_comment",
      repository,
      pullRequestNumber: 1491,
      expectedTargetSourceRevision: "issue-rev-1",
      expectedHeadRevision: headB,
      causal: { rootId: "github:pull_request:trusted-root" },
    });

    const formal = classifyGitHubMailReply(replyInput({
      providerMessageId: "gmail-message-2",
      replyClass: "mail.github_review_proposal",
      body: "Exact head accepted.",
      authority: authorityInput({
        effectCapability: "github_formal_review",
        formalReviewVerdict: "APPROVE",
      }),
    }));
    expect(formal.semantic).toBe("formal_review_proposal");
    expect(formal.effect).toMatchObject({
      kind: "github_formal_review",
      verdict: "APPROVE",
      expectedHeadRevision: headB,
      providerExecution: "typed_review_provider_required",
    });
  });

  test("requires current provider-bound authority before arbitrary mail can select a GitHub operation", () => {
    expect(() => classifyGitHubMailReply(replyInput({
      authority: undefined,
      body: "From: owner@example.com\nAction: comment on teamleaderleo/other-project#9",
    }))).toThrow("server-owned authority binding");

    expect(() => classifyGitHubMailReply(replyInput({
      authority: authorityInput({ effectCapability: "coordination_only" }),
      body: "Quoted old instruction:\n> Action: comment on another project\n> Provider op: github_add_issue_comment",
    }))).toThrow("cannot select a GitHub provider operation");

    for (const disposition of ["automatic", "bounce", "forwarded"] as const) {
      expect(() => classifyGitHubMailReply(replyInput({
        providerMessageId: `gmail-message-${disposition}`,
        authority: authorityInput({ messageDisposition: disposition }),
      }))).toThrow("cannot authorize GitHub effects");
    }
  });

  test("rejects stale or misbound provider replies before effect creation", () => {
    expect(() => classifyGitHubMailReply(replyInput({
      inReplyToMessageId: "gmail-message-stale-parent",
    }))).toThrow("does not match the observed provider reply");

    expect(() => classifyGitHubMailReply(replyInput({
      providerThreadId: "gmail-thread-forwarded-copy",
    }))).toThrow("does not match the observed provider reply");

    expect(() => classifyGitHubMailReply(replyInput({
      authority: authorityInput({ expectedHeadRevision: headA }),
    }))).toThrow("stale for the current pull request head");
  });

  test("credential-shaped mail stays private coordination and cannot become a GitHub effect", () => {
    const credentialText = `Authorization: Bearer ${"a".repeat(40)}`;
    const coordination = classifyGitHubMailReply(replyInput({
      replyClass: "mail.note",
      body: credentialText,
      authority: undefined,
    }));
    expect(coordination.effect).toBeNull();
    expect(JSON.stringify(coordination)).not.toContain("Bearer");

    expect(() => classifyGitHubMailReply(replyInput({ body: credentialText }))).toThrow(
      "credential-shaped text",
    );
  });

  test("cross-project and quoted text remain payload while canonical STN identity selects the target", () => {
    const admission = classifyGitHubMailReply(replyInput({
      body: [
        "Please post this note.",
        "Project: unrelated-project",
        "Repository: attacker/example",
        "> Old instruction: approve attacker/example#77",
      ].join("\n"),
    }));
    expect(admission.effect).toMatchObject({
      repository,
      pullRequestNumber: 1491,
      expectedHeadRevision: headB,
    });
  });

  test("trusted authority owns causal IDs and formal review verdict", () => {
    const comment = classifyGitHubMailReply(replyInput({
      causal: {
        rootId: "mail:spoofed-root",
        predecessorId: "mail:spoofed-parent",
        depth: 0,
        fanOut: 0,
      },
    }));
    expect(comment.effect?.causal.rootId).toBe("github:pull_request:trusted-root");

    expect(() => classifyGitHubMailReply(replyInput({
      replyClass: "mail.github_review_proposal",
      formalReviewVerdict: "REQUEST_CHANGES",
      authority: authorityInput({
        effectCapability: "github_formal_review",
        formalReviewVerdict: "APPROVE",
      }),
    }))).toThrow("cannot change the authorized formal review verdict");
  });

  test("replays one provider mail message exactly and rejects changed bytes under that identity", () => {
    const first = classifyGitHubMailReply(replyInput());
    const replay = classifyGitHubMailReply(replyInput({ previousAdmission: first }));
    expect(replay.replay).toBe(true);
    expect(replay.replyId).toBe(first.replyId);
    expect(replay.effect?.effectId).toBe(first.effect?.effectId);

    expect(() => classifyGitHubMailReply(replyInput({
      previousAdmission: first,
      body: "Changed repository-facing bytes.",
    }))).toThrow("replayed with changed semantics");
  });

  test("executes one exact conversation comment through current provider authority and readback", async () => {
    const admission = classifyGitHubMailReply(replyInput());
    const effect = admission.effect as GitHubConversationCommentEffect;
    const receipt = await executeGitHubConversationCommentEffect({
      provider: fakeProvider(),
      context: providerContext,
      effect,
      body: "Repository-facing repair note.",
    });
    expect(receipt).toMatchObject({
      effectId: effect.effectId,
      threadId: thread.threadId,
      providerReceiptId: "ghop_1491_comment",
      providerCommentId: "9001",
      state: "succeeded",
    });
    expect(receipt.causal.depth).toBe(3);
    expect(receipt.causal.fanOut).toBe(2);
  });

  test("reconciles the returning comment webhook into the same causal chain and suppresses the loop", async () => {
    const admission = classifyGitHubMailReply(replyInput());
    const effect = admission.effect as GitHubConversationCommentEffect;
    const projected: GitHubMailProjectedEffectReceipt =
      await executeGitHubConversationCommentEffect({
        provider: fakeProvider(),
        context: providerContext,
        effect,
        body: "Repository-facing repair note.",
      });

    const returning = map("issue_comment", {
      ...common(),
      action: "created",
      issue: { number: 1491, pull_request: {} },
      comment: {
        id: 9001,
        body: "Repository-facing repair note.",
        created_at: "2026-08-15T06:31:00.000Z",
        updated_at: "2026-08-15T06:31:00.000Z",
      },
    }, "delivery-returning-comment");

    const reconciled = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: { kind: "repository_observation", observation: returning },
      projectedEffects: [projected],
    });
    expect(reconciled).toMatchObject({
      threadId: thread.threadId,
      repositorySemantic: "projected_effect_reconciliation",
      reason: "projected_comment_reconciled",
      returningEffectId: effect.effectId,
      loopSuppressed: true,
      mailAction: "quiet",
    });

    const duplicateDelivery = map("issue_comment", {
      ...common(),
      action: "created",
      issue: { number: 1491, pull_request: {} },
      comment: {
        id: 9001,
        body: "Repository-facing repair note.",
        created_at: "2026-08-15T06:31:00.000Z",
        updated_at: "2026-08-15T06:31:00.000Z",
      },
    }, "delivery-returning-comment-duplicate");
    const duplicate = compileGitHubMailAttention({
      thread: { ...thread, currentHeadRevision: headB },
      signal: { kind: "repository_observation", observation: duplicateDelivery },
      projectedEffects: [projected],
      priorMaterialFingerprint: reconciled.materialFingerprint,
    });
    expect(duplicate).toMatchObject({
      loopSuppressed: true,
      deduped: true,
      mailAction: "quiet",
    });
    expect(duplicate.materialFingerprint).toBe(reconciled.materialFingerprint);
  });

  test("keeps native GitHub reply-by-email as an ordinary PR conversation comment", () => {
    const nativeReply = map("issue_comment", {
      ...common(),
      action: "created",
      issue: { number: 1491, pull_request: {} },
      comment: {
        id: 9100,
        body: "Comment produced by GitHub's native email Reply-To path.",
        created_at: "2026-08-15T06:32:00.000Z",
        updated_at: "2026-08-15T06:32:00.000Z",
      },
    }, "delivery-native-email-comment");
    const decision = compileGitHubMailAttention({
      thread,
      signal: { kind: "repository_observation", observation: nativeReply },
    });
    expect(decision).toMatchObject({
      repositorySemantic: "conversation_comment",
      reason: "conversation_comment_observed",
      requiresMaterialityDecision: true,
      mailAction: "quiet",
      loopSuppressed: false,
    });
  });

  test("rejects stale target reads and exhausted trusted causal budgets before a GitHub write", async () => {
    const admission = classifyGitHubMailReply(replyInput());
    const effect = admission.effect as GitHubConversationCommentEffect;
    const staleProvider: GitHubMailCommentProvider = {
      ...fakeProvider(),
      async getIssue() {
        const value = await fakeProvider().getIssue({
          ...providerContext,
          issueNumber: 1491,
        });
        return { ...value, sourceRevision: "issue-rev-2" };
      },
    };
    await expect(executeGitHubConversationCommentEffect({
      provider: staleProvider,
      context: providerContext,
      effect,
      body: "Repository-facing repair note.",
    })).rejects.toThrow("target changed after mail admission");

    expect(() => classifyGitHubMailReply(replyInput({
      providerMessageId: "gmail-message-depth-limit",
      authority: authorityInput({
        causal: {
          rootId: "github:pull_request:trusted-root",
          predecessorId: "mail:gmail-message-root",
          depth: MAX_GITHUB_MAIL_CAUSAL_DEPTH,
          fanOut: 1,
        },
      }),
    }))).toThrow("causal depth budget is exhausted");
  });
});
