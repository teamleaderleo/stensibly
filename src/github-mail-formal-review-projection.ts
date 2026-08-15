import {
  GITHUB_MAIL_BRIDGE_VERSION,
  MAX_GITHUB_MAIL_CAUSAL_DEPTH,
  MAX_GITHUB_MAIL_CAUSAL_FAN_OUT,
  MAX_GITHUB_MAIL_REPLY_BYTES,
  type GitHubMailAttentionDecision,
  type GitHubMailBridgeSignal,
  type GitHubMailCausalContext,
  type GitHubMailEffectCapability,
  type GitHubMailMessageDisposition,
  type GitHubMailProjectedEffectReceipt,
  type GitHubMailThreadBinding,
} from "./github-mail-bridge.js";
import { compileCurrentGitHubMailAttention } from "./github-mail-attention-projection.js";
import {
  GitHubPullRequestReviewPendingReconciliationError,
  GitHubPullRequestReviewProviderService,
  prepareGitHubPullRequestReviewProviderBody,
  type GitHubPullRequestReviewAction,
  type GitHubPullRequestReviewDispatchReceipt,
  type GitHubPullRequestReviewState,
} from "./github-pull-request-review-provider.js";
import type { GitHubProviderRequestContext } from "./github-provider-contracts.js";
import {
  evaluateGitHubOutboundText,
  type GitHubExternalContactAuthority,
  type GitHubOutboundTextPolicy,
  type GitHubOutboundTextReceipt,
} from "./github-outbound-text-policy.js";
import {
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

const credentialShapedMailTextPattern = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/iu;

export interface GitHubMailFormalReviewAuthorityBinding {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly threadId: string;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly expectedInReplyToMessageId: string;
  readonly messageDisposition: GitHubMailMessageDisposition;
  readonly effectCapability: GitHubMailEffectCapability;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string;
  readonly formalReviewVerdict: GitHubPullRequestReviewAction;
  readonly causal: GitHubMailCausalContext;
}

export interface GitHubMailFormalReviewInput {
  readonly thread: GitHubMailThreadBinding;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly inReplyToMessageId: string;
  readonly replyClass: "mail.github_review_proposal";
  readonly body: string;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string;
  readonly formalReviewVerdict: GitHubPullRequestReviewAction;
  readonly causal: GitHubMailCausalContext;
  readonly authority?: GitHubMailFormalReviewAuthorityBinding;
  readonly previousAdmission?: GitHubMailFormalReviewAdmission;
}

export interface GitHubMailFormalReviewProposal {
  readonly kind: "github_formal_review";
  readonly effectId: string;
  readonly threadId: string;
  readonly sourceMailReplyId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string;
  readonly verdict: GitHubPullRequestReviewAction;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly providerExecution: "typed_review_provider_required";
  readonly causal: GitHubMailCausalContext;
}

export interface GitHubMailFormalReviewAdmission {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly replyId: string;
  readonly threadId: string;
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly inReplyToMessageId: string;
  readonly replyClass: "mail.github_review_proposal";
  readonly semantic: "formal_review_proposal";
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly replyFingerprint: string;
  readonly authorityFingerprint: string;
  readonly messageDisposition: GitHubMailMessageDisposition;
  readonly effectCapability: "github_formal_review";
  readonly replay: boolean;
  readonly effect: GitHubMailFormalReviewProposal;
  readonly containsRawMailBody: false;
}

export interface GitHubMailProjectedFormalReviewReceipt {
  readonly version: typeof GITHUB_MAIL_BRIDGE_VERSION;
  readonly effectId: string;
  readonly threadId: string;
  readonly sourceMailReplyId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly expectedHeadRevision: string;
  readonly verdict: GitHubPullRequestReviewAction;
  readonly visibleBodySha256: string;
  readonly visibleBodyByteLength: number;
  readonly providerBodySha256: string;
  readonly providerBodyByteLength: number;
  readonly webhookBodyRevisionSha256: string;
  readonly providerReviewId: string | null;
  readonly providerReviewState: GitHubPullRequestReviewState | null;
  readonly state: GitHubPullRequestReviewDispatchReceipt["state"];
  readonly providerReceipt: GitHubPullRequestReviewDispatchReceipt;
  readonly outboundTextReceipt: GitHubOutboundTextReceipt;
  readonly causal: GitHubMailCausalContext;
  readonly receiptFingerprint: string;
}

export type GitHubMailFormalReviewAttentionReason =
  | "projected_review_reconciled"
  | "projected_review_conflict";

export type GitHubMailAttentionWithFormalReviews = Omit<
  GitHubMailAttentionDecision,
  "reason"
> & {
  readonly reason:
    | GitHubMailAttentionDecision["reason"]
    | GitHubMailFormalReviewAttentionReason;
};

/**
 * Formal-review-specific mail admission. Target repository/PR, provider ancestry,
 * exact head, verdict, and causal lineage come from a server-owned authority
 * binding. Mail body and visible sender data remain evidence only.
 */
export function classifyGitHubFormalReviewMailReply(
  input: GitHubMailFormalReviewInput,
): GitHubMailFormalReviewAdmission {
  const thread = validateThread(input.thread);
  if (input.replyClass !== "mail.github_review_proposal") {
    throw new RangeError("Formal review admission requires mail.github_review_proposal");
  }
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
  const authority = validateFormalReviewAuthority({
    authority: input.authority,
    thread,
    provider,
    mailboxBindingId,
    providerThreadId,
    inReplyToMessageId,
  });
  const visibleBody = exactMailBody(input.body);
  const canonical = canonicalBody(visibleBody);
  if (credentialShapedMailTextPattern.test(canonical)) {
    throw new RangeError("Mail formal review body contains credential-shaped text");
  }
  const bodySha256 = sha256(canonical);
  const bodyByteLength = byteLength(canonical);
  const expectedTargetSourceRevision = authority.binding.expectedTargetSourceRevision;
  const expectedHeadRevision = authority.binding.expectedHeadRevision;
  const verdict = authority.binding.formalReviewVerdict;
  if (
    input.expectedTargetSourceRevision !== expectedTargetSourceRevision
    || input.expectedHeadRevision.toLowerCase() !== expectedHeadRevision
    || input.formalReviewVerdict !== verdict
    || stableJson(validateCausal(input.causal)) !== stableJson(authority.binding.causal)
  ) {
    throw new RangeError("Mail formal review semantics cannot override server-owned authority");
  }
  if ((verdict === "REQUEST_CHANGES" || verdict === "COMMENT") && !canonical) {
    throw new RangeError(`${verdict} GitHub review proposal requires a body`);
  }
  const causal = authority.binding.causal;
  const replyFingerprint = fingerprintCanonicalRequest({
    provider,
    mailboxBindingId,
    providerThreadId,
    providerMessageId,
    inReplyToMessageId,
    threadId: thread.threadId,
    replyClass: input.replyClass,
    bodySha256,
    bodyByteLength,
    expectedTargetSourceRevision,
    expectedHeadRevision,
    formalReviewVerdict: verdict,
    authorityFingerprint: authority.fingerprint,
  });
  const replyId = `stn-mail-reply:${digestSuffix(fingerprintCanonicalRequest({
    provider,
    mailboxBindingId,
    providerMessageId,
  }))}`;

  let replay = false;
  if (
    input.previousAdmission
    && input.previousAdmission.providerMessageId === providerMessageId
  ) {
    if (input.previousAdmission.replyFingerprint !== replyFingerprint) {
      throw new RangeError(
        "Mail provider message identity was replayed with changed formal-review semantics",
      );
    }
    replay = true;
  }

  const nextCausal = deriveCausalEffect(causal, replyId);
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
    authorityFingerprint: authority.fingerprint,
  });
  const effect: GitHubMailFormalReviewProposal = deepFreeze({
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
  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    replyId,
    threadId: thread.threadId,
    provider,
    mailboxBindingId,
    providerThreadId,
    providerMessageId,
    inReplyToMessageId,
    replyClass: "mail.github_review_proposal",
    semantic: "formal_review_proposal",
    bodySha256,
    bodyByteLength,
    replyFingerprint,
    authorityFingerprint: authority.fingerprint,
    messageDisposition: authority.binding.messageDisposition,
    effectCapability: "github_formal_review",
    replay,
    effect,
    containsRawMailBody: false,
  });
}

/**
 * Governed mail -> formal GitHub review seam. Outbound text policy evaluates
 * the exact provider-facing bytes (including the hidden replay marker) before
 * the typed provider separately rechecks binding, current PR/head and authority.
 */
export async function executeGovernedGitHubMailFormalReviewProjection(input: {
  readonly thread: GitHubMailThreadBinding;
  readonly admission: GitHubMailFormalReviewAdmission;
  readonly provider: GitHubPullRequestReviewProviderService;
  readonly context: GitHubProviderRequestContext;
  readonly body: string;
  readonly workspace: string;
  readonly authorityGeneration: number;
  readonly outboundPolicy: GitHubOutboundTextPolicy;
  readonly externalContactAuthority: GitHubExternalContactAuthority | null;
  readonly previousReceipt?: GitHubMailProjectedFormalReviewReceipt;
}): Promise<GitHubMailProjectedFormalReviewReceipt> {
  const thread = validateThread(input.thread);
  const admission = input.admission;
  const effect = admission.effect;
  assertAdmissionBinding(thread, admission);
  const repository = normalizeGitHubRepository(effect.repository);
  if (
    normalizeGitHubRepository(input.context.repository) !== repository
    || input.context.project !== thread.project
  ) {
    throw new RangeError("GitHub formal review provider context does not match the STN thread");
  }
  const canonical = canonicalBody(exactMailBody(input.body));
  if (
    sha256(canonical) !== effect.bodySha256
    || byteLength(canonical) !== effect.bodyByteLength
  ) {
    throw new RangeError("GitHub formal review body changed after mail admission");
  }
  const prepared = prepareGitHubPullRequestReviewProviderBody(
    effect.effectId,
    canonical,
  );
  const [owner, repositoryName] = repository.split("/");
  if (!owner || !repositoryName) {
    throw new RangeError("GitHub formal review repository identity is invalid");
  }
  const outboundTextReceipt = evaluateGitHubOutboundText({
    workspace: input.workspace,
    project: input.context.project,
    destination: { owner, repository: repositoryName },
    surface: "review",
    operationRef: effect.effectId,
    authorityGeneration: input.authorityGeneration,
    fields: [{ name: "body", text: prepared.providerBody }],
    policy: input.outboundPolicy,
    externalContactAuthority: input.externalContactAuthority,
  });
  if (outboundTextReceipt.decision !== "allow") {
    throw new GitHubMailFormalReviewOutboundTextRejectedError(outboundTextReceipt);
  }

  try {
    const providerReceipt = await input.provider.submitReview({
      ...input.context,
      effectId: effect.effectId,
      pullRequestNumber: effect.pullRequestNumber,
      expectedTargetSourceRevision: effect.expectedTargetSourceRevision,
      expectedHeadRevision: effect.expectedHeadRevision,
      action: effect.verdict,
      body: canonical,
      ...(input.previousReceipt
        ? { previousReceipt: input.previousReceipt.providerReceipt }
        : {}),
    });
    return projectedReceipt(
      effect,
      providerReceipt,
      outboundTextReceipt,
    );
  } catch (error) {
    if (error instanceof GitHubPullRequestReviewPendingReconciliationError) {
      throw new GitHubMailFormalReviewPendingReconciliationError(
        projectedReceipt(effect, error.receipt, outboundTextReceipt),
      );
    }
    throw error;
  }
}

/**
 * Integration-facing attention compiler that reconciles a returned formal
 * review before falling back to #1491's ordinary attention path. Exact return
 * stays in the same STN causal chain and remains quiet; a matching provider
 * review ID with changed state/head/body becomes an incident.
 */
export function compileCurrentGitHubMailAttentionWithFormalReviews(input: {
  readonly thread: GitHubMailThreadBinding;
  readonly signal: GitHubMailBridgeSignal;
  readonly priorMaterialFingerprint?: string | null;
  readonly projectedCommentEffects?: readonly GitHubMailProjectedEffectReceipt[];
  readonly projectedFormalReviews?: readonly GitHubMailProjectedFormalReviewReceipt[];
}): GitHubMailAttentionWithFormalReviews {
  const thread = validateThread(input.thread);
  if (
    input.signal.kind === "repository_observation"
    && input.signal.observation.eventType === "pull_request_review"
  ) {
    const observation = input.signal.observation;
    const reviewId = typeof observation.facts.reviewId === "string"
      ? observation.facts.reviewId
      : null;
    if (reviewId) {
      const receipt = (input.projectedFormalReviews ?? []).find(
        (candidate) => candidate.providerReviewId === reviewId,
      );
      if (receipt) {
        return dedupeFormalReviewDecision(
          reconcileReturningFormalReview(thread, observation, receipt),
          input.priorMaterialFingerprint ?? null,
        );
      }
    }
  }
  return compileCurrentGitHubMailAttention({
    thread,
    signal: input.signal,
    ...(input.priorMaterialFingerprint === undefined
      ? {}
      : { priorMaterialFingerprint: input.priorMaterialFingerprint }),
    ...(input.projectedCommentEffects
      ? { projectedEffects: input.projectedCommentEffects }
      : {}),
  });
}

export class GitHubMailFormalReviewPendingReconciliationError extends Error {
  readonly name = "GitHubMailFormalReviewPendingReconciliationError";
  constructor(readonly receipt: GitHubMailProjectedFormalReviewReceipt) {
    super("GitHub mail formal review requires reconciliation before another provider dispatch");
  }
}

export class GitHubMailFormalReviewOutboundTextRejectedError extends Error {
  readonly name = "GitHubMailFormalReviewOutboundTextRejectedError";
  constructor(readonly receipt: GitHubOutboundTextReceipt) {
    super("GitHub mail formal review was rejected by outbound text policy");
  }
}

function projectedReceipt(
  effect: GitHubMailFormalReviewProposal,
  providerReceipt: GitHubPullRequestReviewDispatchReceipt,
  outboundTextReceipt: GitHubOutboundTextReceipt,
): GitHubMailProjectedFormalReviewReceipt {
  if (
    providerReceipt.effectId !== effect.effectId
    || providerReceipt.repositoryFullName !== effect.repository
    || providerReceipt.pullRequestNumber !== effect.pullRequestNumber
    || providerReceipt.action !== effect.verdict
    || providerReceipt.expectedHeadRevision !== effect.expectedHeadRevision
    || providerReceipt.visibleBodySha256 !== effect.bodySha256
    || providerReceipt.visibleBodyByteLength !== effect.bodyByteLength
  ) {
    throw new RangeError("GitHub formal review provider receipt disagrees with the mail effect");
  }
  const withoutFingerprint = {
    version: GITHUB_MAIL_BRIDGE_VERSION,
    effectId: effect.effectId,
    threadId: effect.threadId,
    sourceMailReplyId: effect.sourceMailReplyId,
    repository: effect.repository,
    pullRequestNumber: effect.pullRequestNumber,
    expectedHeadRevision: effect.expectedHeadRevision,
    verdict: effect.verdict,
    visibleBodySha256: providerReceipt.visibleBodySha256,
    visibleBodyByteLength: providerReceipt.visibleBodyByteLength,
    providerBodySha256: providerReceipt.providerBodySha256,
    providerBodyByteLength: providerReceipt.providerBodyByteLength,
    webhookBodyRevisionSha256: providerReceipt.webhookBodyRevisionSha256,
    providerReviewId: providerReceipt.providerReviewId,
    providerReviewState: providerReceipt.providerReviewState,
    state: providerReceipt.state,
    providerReceipt,
    outboundTextReceipt,
    causal: effect.causal,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function reconcileReturningFormalReview(
  thread: GitHubMailThreadBinding,
  observation: Extract<
    GitHubMailBridgeSignal,
    { kind: "repository_observation" }
  >["observation"],
  receipt: GitHubMailProjectedFormalReviewReceipt,
): GitHubMailAttentionWithFormalReviews {
  const reviewBody = observation.contentRevisions.find(
    (revision) => revision.name === "review_body",
  );
  const expectedState = reviewState(receipt.verdict);
  const exact = observation.action === "submitted"
    && receipt.threadId === thread.threadId
    && receipt.repository === thread.repository
    && receipt.pullRequestNumber === thread.pullRequestNumber
    && observation.repository === thread.repository
    && observation.relationships.pullRequestNumber === thread.pullRequestNumber
    && observation.relationships.revision === receipt.expectedHeadRevision
    && observation.facts.reviewId === receipt.providerReviewId
    && observation.facts.state === expectedState
    && reviewBody?.present === true
    && reviewBody.sha256 === receipt.webhookBodyRevisionSha256
    && reviewBody.byteLength === receipt.providerBodyByteLength;
  const reason: GitHubMailFormalReviewAttentionReason = exact
    ? "projected_review_reconciled"
    : "projected_review_conflict";
  const materialFingerprint = fingerprintCanonicalRequest({
    threadId: thread.threadId,
    repository: thread.repository,
    pullRequestNumber: thread.pullRequestNumber,
    repositorySemantic: "projected_effect_reconciliation",
    attentionClass: exact ? "none" : "incident",
    mailAction: exact ? "quiet" : "update",
    reason,
    currentHeadRevision: thread.currentHeadRevision,
    returningEffectId: receipt.effectId,
  });
  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId: thread.threadId,
    handle: thread.handle,
    repository: thread.repository,
    pullRequestNumber: thread.pullRequestNumber,
    currentHeadRevision: thread.currentHeadRevision,
    sourceObservationId: observation.observationId,
    sourceSemanticFingerprint: observation.semanticFingerprint,
    repositorySemantic: "projected_effect_reconciliation",
    attentionClass: exact ? "none" : "incident",
    mailAction: exact ? "quiet" : "update",
    reason,
    requiresMaterialityDecision: false,
    returningEffectId: receipt.effectId,
    loopSuppressed: exact,
    deduped: false,
    materialFingerprint,
  });
}

function dedupeFormalReviewDecision(
  decision: GitHubMailAttentionWithFormalReviews,
  priorMaterialFingerprint: string | null,
): GitHubMailAttentionWithFormalReviews {
  if (decision.materialFingerprint !== priorMaterialFingerprint) return decision;
  return deepFreeze({ ...decision, mailAction: "quiet" as const, deduped: true });
}

function assertAdmissionBinding(
  thread: GitHubMailThreadBinding,
  admission: GitHubMailFormalReviewAdmission,
): void {
  const effect = admission.effect;
  if (
    admission.version !== GITHUB_MAIL_BRIDGE_VERSION
    || admission.replyClass !== "mail.github_review_proposal"
    || admission.semantic !== "formal_review_proposal"
    || admission.effectCapability !== "github_formal_review"
    || admission.messageDisposition !== "direct_human_reply"
    || admission.threadId !== thread.threadId
    || effect.threadId !== thread.threadId
    || normalizeGitHubRepository(effect.repository) !== thread.repository
    || effect.pullRequestNumber !== thread.pullRequestNumber
    || effect.expectedHeadRevision !== thread.currentHeadRevision
  ) {
    throw new RangeError("GitHub formal review mail admission is bound to another STN target");
  }
}

function validateFormalReviewAuthority(input: {
  authority: GitHubMailFormalReviewAuthorityBinding | undefined;
  thread: GitHubMailThreadBinding;
  provider: "gmail" | "outlook";
  mailboxBindingId: string;
  providerThreadId: string;
  inReplyToMessageId: string;
}): { binding: GitHubMailFormalReviewAuthorityBinding; fingerprint: string } {
  const raw = input.authority;
  if (!raw || raw.version !== GITHUB_MAIL_BRIDGE_VERSION) {
    throw new RangeError("Formal review mail requires a server-owned authority binding");
  }
  const binding = deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId: identity(raw.threadId, "Authorized STN thread ID", 240),
    provider: raw.provider,
    mailboxBindingId: identity(raw.mailboxBindingId, "Authorized mailbox binding ID", 240),
    providerThreadId: identity(raw.providerThreadId, "Authorized provider mail thread ID", 512),
    expectedInReplyToMessageId: identity(
      raw.expectedInReplyToMessageId,
      "Authorized provider mail parent message ID",
      512,
    ),
    messageDisposition: raw.messageDisposition,
    effectCapability: raw.effectCapability,
    expectedTargetSourceRevision: hash(
      raw.expectedTargetSourceRevision,
      "Authorized GitHub target source revision",
    ),
    expectedHeadRevision: fullRevision(
      raw.expectedHeadRevision,
      "Authorized GitHub pull request head revision",
    ),
    formalReviewVerdict: reviewAction(raw.formalReviewVerdict),
    causal: validateCausal(raw.causal),
  });
  if (binding.provider !== "gmail" && binding.provider !== "outlook") {
    throw new RangeError("Authorized mail provider is invalid");
  }
  if (
    binding.messageDisposition !== "direct_human_reply"
    || binding.effectCapability !== "github_formal_review"
  ) {
    throw new RangeError("Automatic, bounce, forwarded, or coordination-only mail cannot authorize a formal GitHub review");
  }
  if (
    binding.threadId !== input.thread.threadId
    || binding.provider !== input.provider
    || binding.mailboxBindingId !== input.mailboxBindingId
    || binding.providerThreadId !== input.providerThreadId
    || binding.expectedInReplyToMessageId !== input.inReplyToMessageId
  ) {
    throw new RangeError("Formal review authority does not match the observed provider reply");
  }
  if (
    input.thread.currentHeadRevision === null
    || binding.expectedHeadRevision !== input.thread.currentHeadRevision
  ) {
    throw new RangeError("Formal review mail authority is stale for the current pull request head");
  }
  return deepFreeze({
    binding,
    fingerprint: fingerprintCanonicalRequest(binding),
  });
}

function validateThread(input: GitHubMailThreadBinding): GitHubMailThreadBinding {
  if (input.version !== GITHUB_MAIL_BRIDGE_VERSION) {
    throw new RangeError("GitHub mail thread binding version is unsupported");
  }
  const threadId = identity(input.threadId, "STN thread ID", 240);
  if (!/^STN-(?:HANDOFF|REVIEW|DECISION|INCIDENT):[A-Z0-9]{4,32}$/u.test(input.handle)) {
    throw new RangeError("STN mail handle is invalid");
  }
  const repository = normalizeGitHubRepository(input.repository);
  const pullRequestNumber = positiveInteger(
    input.pullRequestNumber,
    "GitHub pull request number",
  );
  const currentHeadRevision = input.currentHeadRevision === null
    ? null
    : fullRevision(input.currentHeadRevision, "Current pull request head revision");
  return deepFreeze({
    version: GITHUB_MAIL_BRIDGE_VERSION,
    threadId,
    handle: input.handle,
    project: identity(input.project, "Project", 80),
    repository,
    pullRequestNumber,
    currentHeadRevision,
    continuesFromThreadId: input.continuesFromThreadId === null
      ? null
      : identity(input.continuesFromThreadId, "Parent STN thread ID", 240),
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

function reviewAction(value: unknown): GitHubPullRequestReviewAction {
  if (value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT") {
    return value;
  }
  throw new RangeError("Formal GitHub review verdict is invalid");
}

function reviewState(value: GitHubPullRequestReviewAction): GitHubPullRequestReviewState {
  return value === "APPROVE"
    ? "approved"
    : value === "REQUEST_CHANGES"
    ? "changes_requested"
    : "commented";
}

function exactMailBody(value: unknown): string {
  if (typeof value !== "string" || byteLength(value) > MAX_GITHUB_MAIL_REPLY_BYTES) {
    throw new RangeError("Mail formal review body is invalid or oversized");
  }
  return value;
}

function identity(value: string, label: string, maximum: number): string {
  return boundedText(value, label, maximum);
}

function hash(value: string, label: string): string {
  const normalized = identity(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function fullRevision(value: string, label: string): string {
  const normalized = identity(value, label, 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function digestSuffix(fingerprint: string): string {
  return fingerprint.startsWith("sha256:") ? fingerprint.slice(7) : fingerprint;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
