import type { GitHubIssueContext } from "./github-issue-context.js";
import type {
  GitHubIssueComment,
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import {
  boundedBody,
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
  positiveInteger,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { parseMailThreadHandle } from "./mail-thread-contract.js";

export const GITHUB_MAIL_BRIDGE_VERSION = 1 as const;
export const MAX_GITHUB_MAIL_CAUSAL_DEPTH = 8;
export const MAX_GITHUB_MAIL_CAUSAL_FAN_OUT = 4;
export const MAX_GITHUB_MAIL_REPLY_BYTES = 64 * 1024;

export const githubMailReplyClasses = [
  "mail.note",
  "mail.handoff",
  "mail.review_finding",
  "mail.answer",
  "mail.acknowledgement",
  "mail.github_comment_proposal",
  "mail.github_review_proposal",
] as const;

export const githubMailEffectCapabilities = [
  "coordination_only",
  "github_conversation_comment",
  "github_formal_review",
] as const;

export const githubMailMessageDispositions = [
  "direct_human_reply",
  "automatic",
  "bounce",
  "forwarded",
] as const;

export type GitHubMailReplyClass = typeof githubMailReplyClasses[number];
export type GitHubFormalReviewVerdict = "APPROVE" | "REQUEST_CHANGES";
export type GitHubMailEffectCapability = typeof githubMailEffectCapabilities[number];
export type GitHubMailMessageDisposition = typeof githubMailMessageDispositions[number];

const credentialShapedMailTextPattern = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/iu;

export interface GitHubMailThreadBinding {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly threadId: string;
  readonly handle: string;
  readonly project: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly currentHeadRevision: string | null;
  readonly continuesFromThreadId: string | null;
}

export interface GitHubMailCausalContext {
  readonly rootId: string;
  readonly predecessorId: string | null;
  readonly depth: number;
  readonly fanOut: number;
}

/**
 * Server-owned binding for an effect-bearing mail reply. Visible sender text,
 * quoted body content, attachment names, and arbitrary mail headers are absent
 * by design; they can contribute evidence but never provider-operation authority.
 */
export interface GitHubMailReplyAuthorityBinding {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly threadId: string;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly expectedInReplyToMessageId: string;
  readonly messageDisposition: GitHubMailMessageDisposition;
  readonly effectCapability: GitHubMailEffectCapability;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string | null;
  readonly formalReviewVerdict: GitHubFormalReviewVerdict | null;
  readonly causal: GitHubMailCausalContext;
}

export type GitHubTerminalStatusConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "neutral"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure";

/**
 * Bridge-local normalized terminal status input. The webhook ingress can grow
 * these event families independently; this contract keeps #1491's materiality
 * and loop semantics pure and provider-body-free.
 */
export interface AdmittedGitHubTerminalStatusObservation {
  readonly version: 1;
  readonly provider: "github";
  readonly sourceSchema:
    | "check_run"
    | "check_suite"
    | "workflow_run"
    | "deployment_status";
  readonly observationId: string;
  readonly deliveryId: string;
  readonly semanticFingerprint: string;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly revision: string;
  readonly providerObjectId: string;
  readonly conclusion: GitHubTerminalStatusConclusion;
  readonly sourceTime: string;
  readonly containsRawContent: false;
}

export type GitHubMailBridgeSignal =
  | {
    readonly kind: "repository_observation";
    readonly observation: GitHubRepositoryObservation;
  }
  | {
    readonly kind: "terminal_status";
    readonly observation: AdmittedGitHubTerminalStatusObservation;
  };

export type GitHubMailAttentionReason =
  | "pr_opened"
  | "pr_reopened"
  | "pr_review_ready"
  | "pr_head_changed"
  | "pr_closed"
  | "pr_merged"
  | "formal_review_approved"
  | "formal_review_changes_requested"
  | "formal_review_commented"
  | "conversation_comment_observed"
  | "inline_review_finding_observed"
  | "ci_failed"
  | "ci_terminal_non_success"
  | "ci_succeeded"
  | "projected_comment_reconciled"
  | "projected_comment_conflict"
  | "routine_github_activity";

export interface GitHubMailAttentionDecision {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly threadId: string;
  readonly handle: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly currentHeadRevision: string | null;
  readonly sourceObservationId: string;
  readonly sourceSemanticFingerprint: string;
  readonly repositorySemantic:
    | "pr_lifecycle"
    | "conversation_comment"
    | "formal_review"
    | "inline_review_finding"
    | "terminal_status"
    | "projected_effect_reconciliation"
    | "other";
  readonly attentionClass: "none" | "review" | "incident";
  readonly mailAction: "quiet" | "update" | "resolve";
  readonly reason: GitHubMailAttentionReason;
  readonly requiresMaterialityDecision: boolean;
  readonly returningEffectId: string | null;
  readonly loopSuppressed: boolean;
  readonly deduped: boolean;
  readonly materialFingerprint: string;
}

export interface GitHubMailReplyInput {
  readonly thread: GitHubMailThreadBinding;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly inReplyToMessageId: string;
  readonly replyClass: GitHubMailReplyClass;
  readonly body: string;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string | null;
  readonly formalReviewVerdict?: GitHubFormalReviewVerdict;
  readonly causal: GitHubMailCausalContext;
  readonly authority?: GitHubMailReplyAuthorityBinding;
  readonly previousAdmission?: GitHubMailReplyAdmission;
}

export interface GitHubConversationCommentEffect {
  readonly kind: "github_conversation_comment";
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly threadId: string;
  readonly sourceMailReplyId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string | null;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly webhookBodyRevisionSha256: string;
  readonly causal: GitHubMailCausalContext;
}

export interface GitHubFormalReviewEffectProposal {
  readonly kind: "github_formal_review";
  readonly effectId: string;
  readonly threadId: string;
  readonly sourceMailReplyId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string;
  readonly verdict: GitHubFormalReviewVerdict;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly providerExecution: "typed_review_provider_required";
  readonly causal: GitHubMailCausalContext;
}

export type GitHubMailReplyEffect =
  | GitHubConversationCommentEffect
  | GitHubFormalReviewEffectProposal;

export interface GitHubMailReplyAdmission {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly replyId: string;
  readonly threadId: string;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly inReplyToMessageId: string;
  readonly replyClass: GitHubMailReplyClass;
  readonly semantic:
    | "private_coordination"
    | "conversation_comment_proposal"
    | "formal_review_proposal";
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly replyFingerprint: string;
  readonly authorityFingerprint: string | null;
  readonly messageDisposition: GitHubMailMessageDisposition | null;
  readonly effectCapability: GitHubMailEffectCapability | null;
  readonly replay: boolean;
  readonly effect: GitHubMailReplyEffect | null;
  readonly containsRawMailBody: false;
}

export interface GitHubMailCommentProvider {
  getIssue(
    input: GitHubProviderRequestContext & { issueNumber: number },
  ): Promise<GitHubIssueContext>;
  addIssueComment(
    input: GitHubProviderRequestContext & {
      issueNumber: number;
      body: string;
      idempotencyKey: string;
    },
  ): Promise<GitHubProviderReceipt>;
}

export interface GitHubMailProjectedEffectReceipt {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly effectId: string;
  readonly threadId: string;
  readonly sourceMailReplyId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly providerReceiptId: string;
  readonly providerRequestId: string | null;
  readonly providerCommentId: string;
  readonly providerCommentSourceRevision: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly webhookBodyRevisionSha256: string;
  readonly state: "succeeded";
  readonly causal: GitHubMailCausalContext;
  readonly receiptFingerprint: string;
}

export function compileGitHubMailAttention(input: {
  thread: GitHubMailThreadBinding;
  signal: GitHubMailBridgeSignal;
  priorMaterialFingerprint?: string | null;
  projectedEffects?: readonly GitHubMailProjectedEffectReceipt[];
}): GitHubMailAttentionDecision {
  const thread = validateThread(input.thread);
  const projectedEffects = input.projectedEffects ?? [];

  if (input.signal.kind === "repository_observation") {
    const observation = input.signal.observation;
    assertRepositoryMatch(thread.repository, observation.repository);
    const returning = reconcileReturningObservation(
      thread,
      observation,
      projectedEffects,
    );
    if (returning) {
      return applyDedupe(returning, input.priorMaterialFingerprint ?? null);
    }
    return applyDedupe(
      compileRepositoryObservation(thread, observation),
      input.priorMaterialFingerprint ?? null,
    );
  }

  const observation = validateTerminalStatus(input.signal.observation);
  assertRepositoryMatch(thread.repository, observation.repository);
  if (
    observation.pullRequestNumber !== null
    && observation.pullRequestNumber !== thread.pullRequestNumber
  ) {
    throw new RangeError("GitHub terminal status belongs to another pull request");
  }
  if (
    observation.pullRequestNumber === null
    && thread.currentHeadRevision !== null
    && observation.revision !== thread.currentHeadRevision
  ) {
    throw new RangeError("GitHub terminal status belongs to another candidate revision");
  }
  const failed = observation.conclusion === "failure"
    || observation.conclusion === "timed_out"
    || observation.conclusion === "action_required"
    || observation.conclusion === "startup_failure";
  const successful = observation.conclusion === "success";
  return applyDedupe(
    decision({
      thread,
      sourceObservationId: observation.observationId,
      sourceSemanticFingerprint: observation.semanticFingerprint,
      repositorySemantic: "terminal_status",
      attentionClass: failed ? "incident" : "none",
      mailAction: failed ? "update" : "quiet",
      reason: failed
        ? "ci_failed"
        : successful
        ? "ci_succeeded"
        : "ci_terminal_non_success",
      requiresMaterialityDecision: false,
      returningEffectId: null,
      loopSuppressed: false,
      currentHeadRevision: observation.revision,
    }),
    input.priorMaterialFingerprint ?? null,
  );
}

export function classifyGitHubMailReply(
  input: GitHubMailReplyInput,
): GitHubMailReplyAdmission {
  const thread = validateThread(input.thread);
  const provider = input.provider;
  if (provider !== "gmail" && provider !== "outlook") {
    throw new RangeError("Mail provider is unsupported");
  }
  const mailboxBindingId = identity(input.mailboxBindingId, "Mailbox binding ID", 240);
  const providerThreadId = identity(input.providerThreadId, "Provider mail thread ID", 512);
  const providerMessageId = identity(input.providerMessageId, "Provider mail message ID", 512);
  const inReplyToMessageId = identity(
    input.inReplyToMessageId,
    "Provider mail parent message ID",
    512,
  );
  const replyClass = closedValue(
    input.replyClass,
    githubMailReplyClasses,
    "Mail reply class",
  );
  const body = boundedBody(input.body, "Mail reply body", MAX_GITHUB_MAIL_REPLY_BYTES);
  const effectBearing = replyClass === "mail.github_comment_proposal"
    || replyClass === "mail.github_review_proposal";
  const authority = effectBearing
    ? validateReplyAuthority({
        authority: input.authority,
        thread,
        provider,
        mailboxBindingId,
        providerThreadId,
        inReplyToMessageId,
        replyClass,
      })
    : null;
  const expectedTargetSourceRevision = authority
    ? authority.binding.expectedTargetSourceRevision
    : identity(
        input.expectedTargetSourceRevision,
        "Expected GitHub target source revision",
        512,
      );
  const expectedHeadRevision = authority
    ? authority.binding.expectedHeadRevision
    : input.expectedHeadRevision === null
    ? null
    : fullRevision(input.expectedHeadRevision, "Expected pull request head revision");
  const causal = authority ? authority.binding.causal : validateCausal(input.causal);
  const formalReviewVerdict = authority?.binding.formalReviewVerdict
    ?? input.formalReviewVerdict
    ?? null;
  if (
    authority
    && input.formalReviewVerdict !== undefined
    && input.formalReviewVerdict !== authority.binding.formalReviewVerdict
  ) {
    throw new RangeError("Mail body semantics cannot change the authorized formal review verdict");
  }
  const canonical = canonicalBody(body);
  if (effectBearing && credentialShapedMailTextPattern.test(canonical)) {
    throw new RangeError("Mail reply effect body contains credential-shaped text");
  }
  const bodySha256 = sha256(canonical);
  const bodyByteLength = Buffer.byteLength(canonical, "utf8");
  const replyFingerprint = fingerprintCanonicalRequest({
    provider,
    mailboxBindingId,
    providerThreadId,
    providerMessageId,
    inReplyToMessageId,
    threadId: thread.threadId,
    replyClass,
    bodySha256,
    bodyByteLength,
    expectedTargetSourceRevision,
    expectedHeadRevision,
    formalReviewVerdict,
    authorityFingerprint: authority?.fingerprint ?? null,
  });
  const replyId = `stn-mail-reply:${digestSuffix(fingerprintCanonicalRequest({
    provider,
    mailboxBindingId,
    providerMessageId,
  }))}`;

  let replay = false;
  const previous = input.previousAdmission;
  if (previous && previous.providerMessageId === providerMessageId) {
    if (previous.replyFingerprint !== replyFingerprint) {
      throw new RangeError(
        "Mail provider message identity was replayed with changed semantics",
      );
    }
    replay = true;
  }

  let semantic: GitHubMailReplyAdmission["semantic"] = "private_coordination";
  let effect: GitHubMailReplyEffect | null = null;

  if (replyClass === "mail.github_comment_proposal") {
    const nextCausal = deriveCausalEffect(causal, replyId);
    semantic = "conversation_comment_proposal";
    const effectIdentity = fingerprintCanonicalRequest({
      kind: "github_conversation_comment",
      threadId: thread.threadId,
      sourceMailReplyId: replyId,
      repository: thread.repository,
      pullRequestNumber: thread.pullRequestNumber,
      expectedTargetSourceRevision,
      expectedHeadRevision,
      bodySha256,
      bodyByteLength,
      authorityFingerprint: authority!.fingerprint,
    });
    const effectId = `stn-gh-comment:${digestSuffix(effectIdentity)}`;
    effect = deepFreeze({
      kind: "github_conversation_comment",
      effectId,
      idempotencyKey: effectId,
      threadId: thread.threadId,
      sourceMailReplyId: replyId,
      repository: thread.repository,
      pullRequestNumber: thread.pullRequestNumber,
      expectedTargetSourceRevision,
      expectedHeadRevision,
      bodySha256,
      bodyByteLength,
      webhookBodyRevisionSha256: sha256(stableJson({
        present: true,
        content: canonical,
      })),
      causal: nextCausal,
    });
  } else if (replyClass === "mail.github_review_proposal") {
    const nextCausal = deriveCausalEffect(causal, replyId);
    semantic = "formal_review_proposal";
    if (expectedHeadRevision === null) {
      throw new RangeError("Formal GitHub review proposals require an exact head revision");
    }
    const verdict = closedValue(
      formalReviewVerdict,
      ["APPROVE", "REQUEST_CHANGES"] as const,
      "Formal GitHub review verdict",
    );
    const effectIdentity = fingerprintCanonicalRequest({
      kind: "github_formal_review",
      threadId: thread.threadId,
      sourceMailReplyId: replyId,
      repository: thread.repository,
      pullRequestNumber: thread.pullRequestNumber,
      expectedTargetSourceRevision,
      expectedHeadRevision,
      verdict,
      bodySha256,
      bodyByteLength,
      authorityFingerprint: authority!.fingerprint,
    });
    effect = deepFreeze({
      kind: "github_formal_review",
      effectId: `stn-gh-review:${digestSuffix(effectIdentity)}`,
      threadId: thread.threadId,
      sourceMailReplyId: replyId,
      repository: thread.repository,
      pullRequestNumber: thread.pullRequestNumber,
      expectedTargetSourceRevision,
      expectedHeadRevision,
      verdict,
      bodySha256,
      bodyByteLength,
      providerExecution: "typed_review_provider_required",
      causal: nextCausal,
    });
  } else if (input.formalReviewVerdict !== undefined) {
    throw new RangeError(
      "Formal GitHub review verdicts belong only to mail.github_review_proposal",
    );
  }

  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    replyId,
    threadId: thread.threadId,
    provider,
    mailboxBindingId,
    providerThreadId,
    providerMessageId,
    inReplyToMessageId,
    replyClass,
    semantic,
    bodySha256,
    bodyByteLength,
    replyFingerprint,
    authorityFingerprint: authority?.fingerprint ?? null,
    messageDisposition: authority?.binding.messageDisposition ?? null,
    effectCapability: authority?.binding.effectCapability ?? null,
    replay,
    effect,
    containsRawMailBody: false,
  });
}

export async function executeGitHubConversationCommentEffect(input: {
  provider: GitHubMailCommentProvider;
  context: GitHubProviderRequestContext;
  effect: GitHubConversationCommentEffect;
  body: string;
}): Promise<GitHubMailProjectedEffectReceipt> {
  const effect = input.effect;
  const repository = normalizeGitHubRepository(effect.repository);
  if (normalizeGitHubRepository(input.context.repository) !== repository) {
    throw new RangeError("GitHub comment effect context targets another repository");
  }
  const body = boundedBody(input.body, "GitHub conversation comment", MAX_GITHUB_MAIL_REPLY_BYTES);
  const canonical = canonicalBody(body);
  const bodySha256 = sha256(canonical);
  const bodyByteLength = Buffer.byteLength(canonical, "utf8");
  const webhookBodyRevisionSha256 = sha256(stableJson({
    present: true,
    content: canonical,
  }));
  if (
    bodySha256 !== effect.bodySha256
    || bodyByteLength !== effect.bodyByteLength
    || webhookBodyRevisionSha256 !== effect.webhookBodyRevisionSha256
  ) {
    throw new RangeError("GitHub comment effect body changed after classification");
  }

  const current = await input.provider.getIssue({
    ...input.context,
    issueNumber: effect.pullRequestNumber,
  });
  if (
    current.reference.repositoryFullName !== repository
    || current.reference.number !== effect.pullRequestNumber
  ) {
    throw new RangeError("GitHub comment effect current target identity changed");
  }
  if (current.sourceRevision !== effect.expectedTargetSourceRevision) {
    throw new RangeError("GitHub comment effect target changed after mail admission");
  }

  const providerReceipt = await input.provider.addIssueComment({
    ...input.context,
    issueNumber: effect.pullRequestNumber,
    body: canonical,
    idempotencyKey: effect.idempotencyKey,
  });
  const comment = exactSucceededComment(providerReceipt, effect);
  if (
    comment.bodyRevision.sha256 !== bodySha256
    || comment.bodyRevision.byteLength !== bodyByteLength
  ) {
    throw new RangeError("GitHub provider comment receipt disagrees with projected bytes");
  }

  const withoutFingerprint = {
    version: GITHUB_MAIL_BRIDGE_VERSION,
    effectId: effect.effectId,
    threadId: effect.threadId,
    sourceMailReplyId: effect.sourceMailReplyId,
    repository,
    pullRequestNumber: effect.pullRequestNumber,
    providerReceiptId: providerReceipt.id,
    providerRequestId: providerReceipt.providerRequestId,
    providerCommentId: comment.id,
    providerCommentSourceRevision: comment.sourceRevision,
    bodySha256,
    bodyByteLength,
    webhookBodyRevisionSha256,
    state: "succeeded" as const,
    causal: effect.causal,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function compileRepositoryObservation(
  thread: GitHubMailThreadBinding,
  observation: GitHubRepositoryObservation,
): GitHubMailAttentionDecision {
  const relationPr = observation.relationships.pullRequestNumber;
  if (relationPr !== null && relationPr !== thread.pullRequestNumber) {
    throw new RangeError("GitHub observation belongs to another pull request");
  }

  if (observation.eventType === "pull_request") {
    const revision = observation.relationships.revision;
    if (observation.action === "synchronize") {
      return decision({
        thread,
        sourceObservationId: observation.observationId,
        sourceSemanticFingerprint: observation.semanticFingerprint,
        repositorySemantic: "pr_lifecycle",
        attentionClass: "none",
        mailAction: "quiet",
        reason: "pr_head_changed",
        requiresMaterialityDecision: false,
        returningEffectId: null,
        loopSuppressed: false,
        currentHeadRevision: revision,
      });
    }
    if (observation.action === "opened" || observation.action === "reopened") {
      const draft = observation.facts.draft === true;
      return decision({
        thread,
        sourceObservationId: observation.observationId,
        sourceSemanticFingerprint: observation.semanticFingerprint,
        repositorySemantic: "pr_lifecycle",
        attentionClass: draft ? "none" : "review",
        mailAction: draft ? "quiet" : "update",
        reason: observation.action === "opened" ? "pr_opened" : "pr_reopened",
        requiresMaterialityDecision: false,
        returningEffectId: null,
        loopSuppressed: false,
        currentHeadRevision: revision,
      });
    }
    if (observation.action === "ready_for_review") {
      return decision({
        thread,
        sourceObservationId: observation.observationId,
        sourceSemanticFingerprint: observation.semanticFingerprint,
        repositorySemantic: "pr_lifecycle",
        attentionClass: "review",
        mailAction: "update",
        reason: "pr_review_ready",
        requiresMaterialityDecision: false,
        returningEffectId: null,
        loopSuppressed: false,
        currentHeadRevision: revision,
      });
    }
    if (observation.action === "closed") {
      const merged = observation.facts.merged === true;
      return decision({
        thread,
        sourceObservationId: observation.observationId,
        sourceSemanticFingerprint: observation.semanticFingerprint,
        repositorySemantic: "pr_lifecycle",
        attentionClass: "none",
        mailAction: "resolve",
        reason: merged ? "pr_merged" : "pr_closed",
        requiresMaterialityDecision: false,
        returningEffectId: null,
        loopSuppressed: false,
        currentHeadRevision: revision,
      });
    }
  }

  if (
    observation.eventType === "pull_request_review"
    && observation.action === "submitted"
  ) {
    const state = observation.facts.state;
    const reason = state === "approved"
      ? "formal_review_approved"
      : state === "changes_requested"
      ? "formal_review_changes_requested"
      : "formal_review_commented";
    return decision({
      thread,
      sourceObservationId: observation.observationId,
      sourceSemanticFingerprint: observation.semanticFingerprint,
      repositorySemantic: "formal_review",
      attentionClass: "review",
      mailAction: "update",
      reason,
      requiresMaterialityDecision: false,
      returningEffectId: null,
      loopSuppressed: false,
      currentHeadRevision: observation.relationships.revision
        ?? thread.currentHeadRevision,
    });
  }

  if (
    observation.eventType === "issue_comment"
    && observation.relationships.pullRequestNumber === thread.pullRequestNumber
  ) {
    return decision({
      thread,
      sourceObservationId: observation.observationId,
      sourceSemanticFingerprint: observation.semanticFingerprint,
      repositorySemantic: "conversation_comment",
      attentionClass: "none",
      mailAction: "quiet",
      reason: "conversation_comment_observed",
      requiresMaterialityDecision: true,
      returningEffectId: null,
      loopSuppressed: false,
      currentHeadRevision: thread.currentHeadRevision,
    });
  }

  if (observation.eventType === "pull_request_review_comment") {
    return decision({
      thread,
      sourceObservationId: observation.observationId,
      sourceSemanticFingerprint: observation.semanticFingerprint,
      repositorySemantic: "inline_review_finding",
      attentionClass: "review",
      mailAction: "update",
      reason: "inline_review_finding_observed",
      requiresMaterialityDecision: true,
      returningEffectId: null,
      loopSuppressed: false,
      currentHeadRevision: observation.relationships.revision
        ?? thread.currentHeadRevision,
    });
  }

  return decision({
    thread,
    sourceObservationId: observation.observationId,
    sourceSemanticFingerprint: observation.semanticFingerprint,
    repositorySemantic: "other",
    attentionClass: "none",
    mailAction: "quiet",
    reason: "routine_github_activity",
    requiresMaterialityDecision: false,
    returningEffectId: null,
    loopSuppressed: false,
    currentHeadRevision: observation.relationships.revision
      ?? thread.currentHeadRevision,
  });
}

function reconcileReturningObservation(
  thread: GitHubMailThreadBinding,
  observation: GitHubRepositoryObservation,
  effects: readonly GitHubMailProjectedEffectReceipt[],
): GitHubMailAttentionDecision | null {
  if (
    observation.eventType !== "issue_comment"
    || observation.relationships.pullRequestNumber !== thread.pullRequestNumber
    || observation.relationships.commentId === null
  ) {
    return null;
  }
  const effect = effects.find((candidate) =>
    candidate.threadId === thread.threadId
    && candidate.repository === thread.repository
    && candidate.pullRequestNumber === thread.pullRequestNumber
    && candidate.providerCommentId === observation.relationships.commentId
  );
  if (!effect) return null;
  const bodyRevision = observation.contentRevisions.find(
    (revision) => revision.name === "comment_body",
  );
  const exact = observation.action === "created"
    && bodyRevision?.present === true
    && bodyRevision.sha256 === effect.webhookBodyRevisionSha256
    && bodyRevision.byteLength === effect.bodyByteLength;
  return decision({
    thread,
    sourceObservationId: observation.observationId,
    sourceSemanticFingerprint: observation.semanticFingerprint,
    repositorySemantic: "projected_effect_reconciliation",
    attentionClass: exact ? "none" : "incident",
    mailAction: exact ? "quiet" : "update",
    reason: exact ? "projected_comment_reconciled" : "projected_comment_conflict",
    requiresMaterialityDecision: false,
    returningEffectId: effect.effectId,
    loopSuppressed: exact,
    currentHeadRevision: thread.currentHeadRevision,
  });
}

function decision(input: {
  thread: GitHubMailThreadBinding;
  sourceObservationId: string;
  sourceSemanticFingerprint: string;
  repositorySemantic: GitHubMailAttentionDecision["repositorySemantic"];
  attentionClass: GitHubMailAttentionDecision["attentionClass"];
  mailAction: GitHubMailAttentionDecision["mailAction"];
  reason: GitHubMailAttentionReason;
  requiresMaterialityDecision: boolean;
  returningEffectId: string | null;
  loopSuppressed: boolean;
  currentHeadRevision: string | null;
}): GitHubMailAttentionDecision {
  const materialFingerprint = fingerprintCanonicalRequest({
    threadId: input.thread.threadId,
    repository: input.thread.repository,
    pullRequestNumber: input.thread.pullRequestNumber,
    repositorySemantic: input.repositorySemantic,
    attentionClass: input.attentionClass,
    mailAction: input.mailAction,
    reason: input.reason,
    currentHeadRevision: input.currentHeadRevision,
    returningEffectId: input.returningEffectId,
  });
  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId: input.thread.threadId,
    handle: input.thread.handle,
    repository: input.thread.repository,
    pullRequestNumber: input.thread.pullRequestNumber,
    currentHeadRevision: input.currentHeadRevision,
    sourceObservationId: input.sourceObservationId,
    sourceSemanticFingerprint: input.sourceSemanticFingerprint,
    repositorySemantic: input.repositorySemantic,
    attentionClass: input.attentionClass,
    mailAction: input.mailAction,
    reason: input.reason,
    requiresMaterialityDecision: input.requiresMaterialityDecision,
    returningEffectId: input.returningEffectId,
    loopSuppressed: input.loopSuppressed,
    deduped: false,
    materialFingerprint,
  });
}

function applyDedupe(
  value: GitHubMailAttentionDecision,
  priorMaterialFingerprint: string | null,
): GitHubMailAttentionDecision {
  if (priorMaterialFingerprint !== value.materialFingerprint) return value;
  return deepFreeze({ ...value, mailAction: "quiet" as const, deduped: true });
}

function validateThread(input: GitHubMailThreadBinding): GitHubMailThreadBinding {
  if (input.version !== GITHUB_MAIL_BRIDGE_VERSION) {
    throw new RangeError("GitHub mail thread binding version is unsupported");
  }
  const threadId = identity(input.threadId, "STN thread ID", 240);
  const handle = parseMailThreadHandle(input.handle);
  const project = identity(input.project, "Project", 80);
  const repository = normalizeGitHubRepository(input.repository);
  const pullRequestNumber = positiveInteger(
    input.pullRequestNumber,
    "GitHub pull request number",
  );
  const currentHeadRevision = input.currentHeadRevision === null
    ? null
    : fullRevision(input.currentHeadRevision, "Current pull request head revision");
  const continuesFromThreadId = input.continuesFromThreadId === null
    ? null
    : identity(input.continuesFromThreadId, "Parent STN thread ID", 240);
  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId,
    handle,
    project,
    repository,
    pullRequestNumber,
    currentHeadRevision,
    continuesFromThreadId,
  });
}

function validateReplyAuthority(input: {
  authority: GitHubMailReplyAuthorityBinding | undefined;
  thread: GitHubMailThreadBinding;
  provider: "gmail" | "outlook";
  mailboxBindingId: string;
  providerThreadId: string;
  inReplyToMessageId: string;
  replyClass: GitHubMailReplyClass;
}): { binding: GitHubMailReplyAuthorityBinding; fingerprint: string } {
  const raw = input.authority;
  if (!raw || raw.version !== GITHUB_MAIL_BRIDGE_VERSION) {
    throw new RangeError("Effect-bearing mail replies require a server-owned authority binding");
  }
  const threadId = identity(raw.threadId, "Authorized STN thread ID", 240);
  const provider = closedValue(raw.provider, ["gmail", "outlook"] as const, "Authorized mail provider");
  const mailboxBindingId = identity(raw.mailboxBindingId, "Authorized mailbox binding ID", 240);
  const providerThreadId = identity(raw.providerThreadId, "Authorized provider mail thread ID", 512);
  const expectedInReplyToMessageId = identity(
    raw.expectedInReplyToMessageId,
    "Authorized provider mail parent message ID",
    512,
  );
  const messageDisposition = closedValue(
    raw.messageDisposition,
    githubMailMessageDispositions,
    "Mail message disposition",
  );
  const effectCapability = closedValue(
    raw.effectCapability,
    githubMailEffectCapabilities,
    "Mail effect capability",
  );
  const expectedTargetSourceRevision = identity(
    raw.expectedTargetSourceRevision,
    "Authorized GitHub target source revision",
    512,
  );
  const expectedHeadRevision = raw.expectedHeadRevision === null
    ? null
    : fullRevision(raw.expectedHeadRevision, "Authorized pull request head revision");
  const formalReviewVerdict = raw.formalReviewVerdict === null
    ? null
    : closedValue(
        raw.formalReviewVerdict,
        ["APPROVE", "REQUEST_CHANGES"] as const,
        "Authorized formal GitHub review verdict",
      );
  const causal = validateCausal(raw.causal);

  if (
    threadId !== input.thread.threadId
    || provider !== input.provider
    || mailboxBindingId !== input.mailboxBindingId
    || providerThreadId !== input.providerThreadId
    || expectedInReplyToMessageId !== input.inReplyToMessageId
  ) {
    throw new RangeError("Mail reply authority binding does not match the observed provider reply");
  }
  if (messageDisposition !== "direct_human_reply") {
    throw new RangeError("Automatic, bounce, and forwarded mail cannot authorize GitHub effects");
  }
  const requiredCapability = input.replyClass === "mail.github_comment_proposal"
    ? "github_conversation_comment"
    : "github_formal_review";
  if (effectCapability !== requiredCapability) {
    throw new RangeError("Mail text cannot select a GitHub provider operation outside its authority binding");
  }
  if (expectedHeadRevision === null || expectedHeadRevision !== input.thread.currentHeadRevision) {
    throw new RangeError("Mail effect authority is stale for the current pull request head");
  }
  if (effectCapability === "github_formal_review" && formalReviewVerdict === null) {
    throw new RangeError("Formal review authority requires an explicit trusted verdict");
  }
  if (effectCapability !== "github_formal_review" && formalReviewVerdict !== null) {
    throw new RangeError("Conversation-comment authority cannot carry a formal review verdict");
  }

  const binding = deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId,
    provider,
    mailboxBindingId,
    providerThreadId,
    expectedInReplyToMessageId,
    messageDisposition,
    effectCapability,
    expectedTargetSourceRevision,
    expectedHeadRevision,
    formalReviewVerdict,
    causal,
  });
  return deepFreeze({
    binding,
    fingerprint: fingerprintCanonicalRequest(binding),
  });
}

function validateTerminalStatus(
  input: AdmittedGitHubTerminalStatusObservation,
): AdmittedGitHubTerminalStatusObservation {
  if (
    input.version !== 1
    || input.provider !== "github"
    || input.containsRawContent !== false
  ) {
    throw new RangeError("GitHub terminal status observation envelope is invalid");
  }
  const sourceSchema = closedValue(
    input.sourceSchema,
    ["check_run", "check_suite", "workflow_run", "deployment_status"] as const,
    "GitHub terminal status source schema",
  );
  const conclusion = closedValue(
    input.conclusion,
    [
      "success",
      "failure",
      "cancelled",
      "neutral",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ] as const,
    "GitHub terminal status conclusion",
  );
  const repository = normalizeGitHubRepository(input.repository);
  const revision = fullRevision(input.revision, "GitHub terminal status revision");
  const pullRequestNumber = input.pullRequestNumber === null
    ? null
    : positiveInteger(input.pullRequestNumber, "GitHub terminal status pull request number");
  return deepFreeze({
    version: 1,
    provider: "github",
    sourceSchema,
    observationId: identity(input.observationId, "GitHub terminal observation ID", 512),
    deliveryId: identity(input.deliveryId, "GitHub terminal delivery ID", 240),
    semanticFingerprint: shaFingerprint(
      input.semanticFingerprint,
      "GitHub terminal semantic fingerprint",
    ),
    repository,
    pullRequestNumber,
    revision,
    providerObjectId: identity(input.providerObjectId, "GitHub terminal object ID", 240),
    conclusion,
    sourceTime: identity(input.sourceTime, "GitHub terminal source time", 80),
    containsRawContent: false,
  });
}

function validateCausal(input: GitHubMailCausalContext): GitHubMailCausalContext {
  const rootId = identity(input.rootId, "Causal root ID", 512);
  const predecessorId = input.predecessorId === null
    ? null
    : identity(input.predecessorId, "Causal predecessor ID", 512);
  if (!Number.isSafeInteger(input.depth) || input.depth < 0) {
    throw new RangeError("Causal depth is invalid");
  }
  if (!Number.isSafeInteger(input.fanOut) || input.fanOut < 0) {
    throw new RangeError("Causal fan-out is invalid");
  }
  if (input.depth > MAX_GITHUB_MAIL_CAUSAL_DEPTH) {
    throw new RangeError("GitHub/mail causal depth budget is exhausted");
  }
  if (input.fanOut > MAX_GITHUB_MAIL_CAUSAL_FAN_OUT) {
    throw new RangeError("GitHub/mail causal fan-out budget is exhausted");
  }
  return deepFreeze({ rootId, predecessorId, depth: input.depth, fanOut: input.fanOut });
}

function deriveCausalEffect(
  causal: GitHubMailCausalContext,
  predecessorId: string,
): GitHubMailCausalContext {
  if (causal.depth >= MAX_GITHUB_MAIL_CAUSAL_DEPTH) {
    throw new RangeError("GitHub/mail causal depth budget is exhausted");
  }
  if (causal.fanOut >= MAX_GITHUB_MAIL_CAUSAL_FAN_OUT) {
    throw new RangeError("GitHub/mail causal fan-out budget is exhausted");
  }
  return deepFreeze({
    rootId: causal.rootId,
    predecessorId,
    depth: causal.depth + 1,
    fanOut: causal.fanOut + 1,
  });
}

function exactSucceededComment(
  receipt: GitHubProviderReceipt,
  effect: GitHubConversationCommentEffect,
): GitHubIssueComment {
  if (
    receipt.state !== "succeeded"
    || receipt.operation !== "github_add_issue_comment"
    || receipt.repositoryFullName !== effect.repository
    || receipt.target !== `${effect.repository}#${effect.pullRequestNumber}:comment:new`
    || receipt.idempotencyKey !== effect.idempotencyKey
    || receipt.verification.state !== "passed"
    || receipt.result === null
    || !("issueNumber" in receipt.result)
    || !("bodyRevision" in receipt.result)
    || !("id" in receipt.result)
  ) {
    throw new RangeError("GitHub provider receipt is not the projected conversation comment");
  }
  return receipt.result as GitHubIssueComment;
}

function assertRepositoryMatch(expected: string, actual: string): void {
  if (normalizeGitHubRepository(actual) !== normalizeGitHubRepository(expected)) {
    throw new RangeError("GitHub bridge signal belongs to another repository");
  }
}

function fullRevision(value: string, label: string): string {
  const normalized = boundedText(value, label, 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return normalized;
}

function identity(value: string, label: string, maximum: number): string {
  return boundedText(value, label, maximum);
}

function shaFingerprint(value: string, label: string): string {
  const normalized = identity(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function closedValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T;
}

function digestSuffix(fingerprint: string): string {
  return fingerprint.startsWith("sha256:") ? fingerprint.slice(7) : fingerprint;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
