import { describe, expect, test } from "bun:test";
import {
  classifyGitHubFormalReviewMailReply,
  compileCurrentGitHubMailAttentionWithFormalReviews,
  executeGovernedGitHubMailFormalReviewProjection,
  GitHubMailFormalReviewOutboundTextRejectedError,
  type GitHubMailFormalReviewAdmission,
  type GitHubMailFormalReviewAuthorityBinding,
  type GitHubMailFormalReviewInput,
  type GitHubMailProjectedFormalReviewReceipt,
} from "../src/github-mail-formal-review-projection.ts";
import {
  classifyGitHubMailReply,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import {
  GitHubPullRequestReviewProviderService,
  prepareGitHubPullRequestReviewProviderBody,
  type GitHubPullRequestReviewDispatchReceipt,
} from "../src/github-pull-request-review-provider.ts";
import { mapGitHubRepositoryWebhook } from "../src/github-repository-observation.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const head = "1111111111111111111111111111111111111111";
const source = `sha256:${"2".repeat(64)}`;
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "STN-REVIEW:FORMAL1",
  handle: "STN-REVIEW:FORMAL1",
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  pullRequestNumber: 777,
  currentHeadRevision: head,
  continuesFromThreadId: null,
};
const causal = {
  rootId: "github:pull_request:delivery-root",
  predecessorId: "stn-mail-root",
  depth: 2,
  fanOut: 1,
};

type FormalInputOverrides = Partial<Omit<GitHubMailFormalReviewInput, "authority">> & {
  authority?: GitHubMailFormalReviewAuthorityBinding | null;
};

function formalAuthority(
  overrides: Partial<GitHubMailFormalReviewAuthorityBinding> = {},
): GitHubMailFormalReviewAuthorityBinding {
  return {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    mailboxBindingId: "gmail:primary",
    providerThreadId: "gmail-thread-777",
    expectedInReplyToMessageId: "gmail-message-parent",
    messageDisposition: "direct_human_reply",
    effectCapability: "github_formal_review",
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    formalReviewVerdict: "COMMENT",
    causal,
    ...overrides,
  };
}

function formalInput(overrides: FormalInputOverrides = {}): GitHubMailFormalReviewInput {
  const verdict = overrides.formalReviewVerdict ?? "COMMENT";
  const causalValue = overrides.causal ?? causal;
  const expectedTarget = overrides.expectedTargetSourceRevision ?? source;
  const expectedHead = overrides.expectedHeadRevision ?? head;
  const providerThreadId = overrides.providerThreadId ?? "gmail-thread-777";
  const inReplyToMessageId = overrides.inReplyToMessageId ?? "gmail-message-parent";
  const authority = overrides.authority === undefined
    ? formalAuthority({
        providerThreadId,
        expectedInReplyToMessageId: inReplyToMessageId,
        expectedTargetSourceRevision: expectedTarget,
        expectedHeadRevision: expectedHead,
        formalReviewVerdict: verdict,
        causal: causalValue,
      })
    : overrides.authority;
  return {
    thread: overrides.thread ?? thread,
    provider: overrides.provider ?? "gmail",
    mailboxBindingId: overrides.mailboxBindingId ?? "gmail:primary",
    providerThreadId,
    providerMessageId: overrides.providerMessageId ?? "gmail-message-777",
    inReplyToMessageId,
    replyClass: "mail.github_review_proposal",
    body: overrides.body ?? "Formal review: exact typed COMMENT residue.",
    expectedTargetSourceRevision: expectedTarget,
    expectedHeadRevision: expectedHead,
    formalReviewVerdict: verdict,
    causal: causalValue,
    authority: authority as GitHubMailFormalReviewAuthorityBinding | undefined,
    previousAdmission: overrides.previousAdmission,
  };
}

function providerReceipt(
  admission: GitHubMailFormalReviewAdmission,
  body: string,
  state: GitHubPullRequestReviewDispatchReceipt["state"] = "succeeded",
): GitHubPullRequestReviewDispatchReceipt {
  const prepared = prepareGitHubPullRequestReviewProviderBody(
    admission.effect.effectId,
    body,
  );
  const withoutFingerprint = {
    version: 1 as const,
    id: "ghreview_receipt_test",
    effectId: admission.effect.effectId,
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    pullRequestNumber: 777,
    action: admission.effect.verdict,
    expectedTargetSourceRevision: source,
    expectedHeadRevision: head,
    visibleBodySha256: prepared.visibleBodySha256,
    visibleBodyByteLength: prepared.visibleBodyByteLength,
    providerBodySha256: prepared.providerBodySha256,
    providerBodyByteLength: prepared.providerBodyByteLength,
    webhookBodyRevisionSha256: prepared.webhookBodyRevisionSha256,
    connectionId: "ghconn_test",
    installationId: "12345",
    bindingId: "ghbind_test",
    attachmentId: "patt_test",
    attachmentSnapshotSha256: `sha256:${"3".repeat(64)}`,
    capabilityGrantId: "grant_review",
    approvalId: null,
    providerReviewId: state === "pending_reconciliation" ? null : "9876",
    providerReviewState: state === "pending_reconciliation" ? null : "commented" as const,
    providerRequestId: state === "pending_reconciliation" ? null : "request-9876",
    state,
    createdAt: "2026-08-15T06:45:00.000Z",
    updatedAt: "2026-08-15T06:45:01.000Z",
    verification: state === "pending_reconciliation"
      ? { state: "pending" as const, checkedAt: "2026-08-15T06:45:01.000Z", commitSha: null }
      : { state: "passed" as const, checkedAt: "2026-08-15T06:45:01.000Z", commitSha: head },
    recovery: state === "pending_reconciliation"
      ? { nextAction: "reconcile_exact_review" as const }
      : { nextAction: "none" as const },
  };
  return {
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  };
}

function projectedReceipt(
  admission: GitHubMailFormalReviewAdmission,
): GitHubMailProjectedFormalReviewReceipt {
  const p = providerReceipt(admission, formalInput().body);
  const outbound = {
    schemaVersion: 1 as const,
    workspace: "default",
    project: "stensibly",
    destination: {
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
    },
    surface: "review" as const,
    operationRef: admission.effect.effectId,
    authorityGeneration: 1,
    externalContactAuthorityFingerprint: null,
    externalContactAuthorityGeneration: null,
    policyFingerprint: `sha256:${"4".repeat(64)}`,
    payloadFingerprint: `sha256:${"5".repeat(64)}`,
    fields: [{
      name: "body",
      textSha256: `sha256:${"6".repeat(64)}`,
      byteLength: p.providerBodyByteLength,
      lineCount: 3,
    }],
    referenceCounts: {
      total: 0,
      controlled: 0,
      authorized: 0,
      rejected: 0,
      omittedDiagnostics: 0,
    },
    diagnostics: [],
    decision: "allow" as const,
    providerDispatchAuthorized: false as const,
    receiptFingerprint: `sha256:${"7".repeat(64)}`,
  };
  const withoutFingerprint = {
    version: 1 as const,
    effectId: admission.effect.effectId,
    threadId: admission.effect.threadId,
    sourceMailReplyId: admission.effect.sourceMailReplyId,
    repository: admission.effect.repository,
    pullRequestNumber: admission.effect.pullRequestNumber,
    expectedHeadRevision: admission.effect.expectedHeadRevision,
    verdict: admission.effect.verdict,
    visibleBodySha256: p.visibleBodySha256,
    visibleBodyByteLength: p.visibleBodyByteLength,
    providerBodySha256: p.providerBodySha256,
    providerBodyByteLength: p.providerBodyByteLength,
    webhookBodyRevisionSha256: p.webhookBodyRevisionSha256,
    providerReviewId: p.providerReviewId,
    providerReviewState: p.providerReviewState,
    state: p.state,
    providerReceipt: p,
    outboundTextReceipt: outbound,
    causal: admission.effect.causal,
  };
  return {
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  };
}

describe("formal GitHub review mail classification", () => {
  test("COMMENT remains a formal review semantic while ordinary conversation comment stays separate", () => {
    const formal = classifyGitHubFormalReviewMailReply(formalInput());
    expect(formal.semantic).toBe("formal_review_proposal");
    expect(formal.effect.kind).toBe("github_formal_review");
    expect(formal.effect.verdict).toBe("COMMENT");
    expect(formal.authorityFingerprint).toMatch(/^sha256:/);

    const conversation = classifyGitHubMailReply({
      thread,
      provider: "gmail",
      mailboxBindingId: "gmail:primary",
      providerThreadId: "gmail-thread-777",
      providerMessageId: "gmail-message-comment",
      inReplyToMessageId: "gmail-message-parent",
      replyClass: "mail.github_comment_proposal",
      body: "Conversation-tab residue.",
      expectedTargetSourceRevision: source,
      expectedHeadRevision: head,
      causal,
      authority: {
        version: 1,
        threadId: thread.threadId,
        provider: "gmail",
        mailboxBindingId: "gmail:primary",
        providerThreadId: "gmail-thread-777",
        expectedInReplyToMessageId: "gmail-message-parent",
        messageDisposition: "direct_human_reply",
        effectCapability: "github_conversation_comment",
        expectedTargetSourceRevision: source,
        expectedHeadRevision: head,
        formalReviewVerdict: null,
        causal,
      },
    });
    expect(conversation.semantic).toBe("conversation_comment_proposal");
    expect(conversation.effect?.kind).toBe("github_conversation_comment");
  });

  test("changed verdict or body creates a new exact formal-review effect identity", () => {
    const comment = classifyGitHubFormalReviewMailReply(formalInput());
    const approve = classifyGitHubFormalReviewMailReply(formalInput({
      providerMessageId: "gmail-message-approve",
      formalReviewVerdict: "APPROVE",
    }));
    const changedBody = classifyGitHubFormalReviewMailReply(formalInput({
      providerMessageId: "gmail-message-body-change",
      body: "Changed formal review prose.",
    }));
    expect(approve.effect.effectId).not.toBe(comment.effect.effectId);
    expect(changedBody.effect.effectId).not.toBe(comment.effect.effectId);
  });

  test("same provider mail identity cannot be replayed with changed verdict/body", () => {
    const first = classifyGitHubFormalReviewMailReply(formalInput());
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      formalReviewVerdict: "APPROVE",
      previousAdmission: first,
    }))).toThrow("changed formal-review semantics");
  });

  test("server-owned authority blocks forwards, stale ancestry, operation spoofing, and credential text", () => {
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      authority: null,
    }))).toThrow("server-owned authority binding");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      authority: formalAuthority({ messageDisposition: "forwarded" }),
    }))).toThrow("cannot authorize a formal GitHub review");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      authority: formalAuthority({ expectedInReplyToMessageId: "gmail-message-old" }),
    }))).toThrow("does not match the observed provider reply");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      authority: formalAuthority({ effectCapability: "github_conversation_comment" }),
    }))).toThrow("cannot authorize a formal GitHub review");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      body: `Authorization: Bearer ${"a".repeat(40)}`,
    }))).toThrow("credential-shaped text");
  });

  test("mail-supplied verdict, head, target revision, and causal IDs cannot override trusted authority", () => {
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      formalReviewVerdict: "APPROVE",
      authority: formalAuthority({ formalReviewVerdict: "COMMENT" }),
    }))).toThrow("cannot override server-owned authority");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      expectedHeadRevision: "3".repeat(40),
      authority: formalAuthority(),
    }))).toThrow("cannot override server-owned authority");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      expectedTargetSourceRevision: `sha256:${"4".repeat(64)}`,
      authority: formalAuthority(),
    }))).toThrow("cannot override server-owned authority");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      causal: { rootId: "mail:spoofed", predecessorId: null, depth: 0, fanOut: 0 },
      authority: formalAuthority(),
    }))).toThrow("cannot override server-owned authority");
  });

  test("causal depth and fan-out remain bounded", () => {
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      causal: { ...causal, depth: 8 },
    }))).toThrow("causal depth budget is exhausted");
    expect(() => classifyGitHubFormalReviewMailReply(formalInput({
      causal: { ...causal, fanOut: 4 },
    }))).toThrow("causal fan-out budget is exhausted");
  });
});

describe("governed formal review projection", () => {
  test("STN thread mismatch refuses before provider execution", async () => {
    const admission = classifyGitHubFormalReviewMailReply(formalInput());
    let calls = 0;
    const fakeProvider = {
      async submitReview() {
        calls += 1;
        return providerReceipt(admission, formalInput().body);
      },
    } as unknown as GitHubPullRequestReviewProviderService;
    const wrongThread = { ...thread, pullRequestNumber: 778 };
    await expect(executeGovernedGitHubMailFormalReviewProjection({
      thread: wrongThread,
      admission,
      provider: fakeProvider,
      context: { ...formalContext(), repository: "teamleaderleo/stensibly" },
      body: formalInput().body,
      workspace: "default",
      authorityGeneration: 1,
      outboundPolicy: controlledPolicy(),
      externalContactAuthority: null,
    })).rejects.toThrow("another STN target");
    expect(calls).toBe(0);
  });

  test("uncontrolled cross-repository prose is rejected before provider execution", async () => {
    const body = "Please compare external-owner/external-repo#42 before accepting.";
    const admission = classifyGitHubFormalReviewMailReply(formalInput({ body }));
    let calls = 0;
    const fakeProvider = {
      async submitReview() {
        calls += 1;
        return providerReceipt(admission, body);
      },
    } as unknown as GitHubPullRequestReviewProviderService;
    await expect(executeGovernedGitHubMailFormalReviewProjection({
      thread,
      admission,
      provider: fakeProvider,
      context: formalContext(),
      body,
      workspace: "default",
      authorityGeneration: 1,
      outboundPolicy: controlledPolicy(),
      externalContactAuthority: null,
    })).rejects.toBeInstanceOf(GitHubMailFormalReviewOutboundTextRejectedError);
    expect(calls).toBe(0);
  });
});

describe("returning formal review webhook reconciliation", () => {
  test("exact provider review return stays on the same causal thread and suppresses mail loop", () => {
    const admission = classifyGitHubFormalReviewMailReply(formalInput());
    const receipt = projectedReceipt(admission);
    const providerBody = prepareGitHubPullRequestReviewProviderBody(
      admission.effect.effectId,
      formalInput().body,
    ).providerBody;
    const observation = mapGitHubRepositoryWebhook({
      eventType: "pull_request_review",
      deliveryId: "delivery-review-return",
      payloadDigest: `sha256:${"8".repeat(64)}`,
      signatureVerified: true,
      receivedAt: "2026-08-15T06:46:00.000Z",
      expectedRepository: "teamleaderleo/stensibly",
      payload: {
        action: "submitted",
        repository: { full_name: "teamleaderleo/stensibly" },
        sender: { login: "teamleaderleo" },
        pull_request: {
          number: 777,
          updated_at: "2026-08-15T06:46:00Z",
        },
        review: {
          id: 9876,
          commit_id: head,
          state: "commented",
          body: providerBody,
          submitted_at: "2026-08-15T06:45:59Z",
        },
      },
    });
    if (!observation) throw new Error("missing review observation");
    const decision = compileCurrentGitHubMailAttentionWithFormalReviews({
      thread,
      signal: { kind: "repository_observation", observation },
      projectedFormalReviews: [receipt],
    });
    expect(decision.reason).toBe("projected_review_reconciled");
    expect(decision.repositorySemantic).toBe("projected_effect_reconciliation");
    expect(decision.mailAction).toBe("quiet");
    expect(decision.loopSuppressed).toBe(true);
    expect(decision.returningEffectId).toBe(admission.effect.effectId);
  });

  test("same provider review ID with changed body becomes an incident instead of a loop", () => {
    const admission = classifyGitHubFormalReviewMailReply(formalInput());
    const receipt = projectedReceipt(admission);
    const observation = mapGitHubRepositoryWebhook({
      eventType: "pull_request_review",
      deliveryId: "delivery-review-conflict",
      payloadDigest: `sha256:${"9".repeat(64)}`,
      signatureVerified: true,
      receivedAt: "2026-08-15T06:46:00.000Z",
      expectedRepository: "teamleaderleo/stensibly",
      payload: {
        action: "submitted",
        repository: { full_name: "teamleaderleo/stensibly" },
        sender: { login: "teamleaderleo" },
        pull_request: { number: 777, updated_at: "2026-08-15T06:46:00Z" },
        review: {
          id: 9876,
          commit_id: head,
          state: "commented",
          body: "provider bytes changed",
          submitted_at: "2026-08-15T06:45:59Z",
        },
      },
    });
    if (!observation) throw new Error("missing review observation");
    const decision = compileCurrentGitHubMailAttentionWithFormalReviews({
      thread,
      signal: { kind: "repository_observation", observation },
      projectedFormalReviews: [receipt],
    });
    expect(decision.reason).toBe("projected_review_conflict");
    expect(decision.attentionClass).toBe("incident");
    expect(decision.mailAction).toBe("update");
    expect(decision.loopSuppressed).toBe(false);
  });
});

function formalContext() {
  return {
    project: "stensibly",
    repository: "teamleaderleo/stensibly",
    actorId: "rook",
    clientId: "mail-bridge",
    capabilityGrantId: "grant_review",
  };
}

function controlledPolicy() {
  return {
    version: 1 as const,
    controlledOwners: ["teamleaderleo"],
    controlledRepositories: ["teamleaderleo/stensibly"],
  };
}
