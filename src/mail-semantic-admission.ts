import {
  classifyGitHubMailReply,
  type GitHubFormalReviewVerdict,
  type GitHubMailCausalContext,
  type GitHubMailReplyAdmission,
  type GitHubMailReplyClass,
  type GitHubMailReplyEffect,
  type GitHubMailThreadBinding,
} from "./github-mail-bridge.js";
import { admitGmailSemanticMessage, type AdmittedGmailMessageDisposition } from "./gmail-semantic-message-admission.js";
import type { GmailSemanticMessageSource } from "./gmail-semantic-message-client.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { freezeMailboxBinding } from "./mail-provider.js";

export const MAIL_SEMANTIC_ADMISSION_VERSION = 1 as const;

/** Content-free structural contract implemented by #1511 after its durable CAS. */
export interface PostCommitMaterialMailboxObservation {
  readonly observationId: string;
  readonly semanticFingerprint: string;
  readonly provider: string;
  readonly eventType: string;
  readonly providerCursor: string;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly wakeEligible: boolean;
  readonly loopDisposition: string;
  readonly containsRawContent: boolean;
  readonly grantsAuthority: boolean;
}

export type TrustedMailEffectCapability =
  | "coordination_only"
  | "github_conversation_comment"
  | "github_formal_review";

/**
 * Server-owned consumer binding. Every routing/authority field comes from durable
 * Stensibly/provider state. Visible mail headers and body prose contribute zero fields.
 */
export interface CanonicalMailReplyBindingCandidate {
  readonly version: 1;
  readonly provider: "gmail";
  readonly mailboxBindingId: string;
  readonly expectedMailboxAddress: string;
  readonly providerThreadId: string;
  readonly expectedInReplyToProviderMessageId: string;
  readonly expectedInReplyToRfcMessageId: string;
  readonly thread: GitHubMailThreadBinding;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string | null;
  readonly causal: GitHubMailCausalContext;
  readonly effectCapability: TrustedMailEffectCapability;
  readonly formalReviewVerdict: GitHubFormalReviewVerdict | null;
}

export interface CanonicalMailReplyBindingResolver {
  resolve(input: {
    provider: "gmail";
    mailboxBindingId: string;
    providerThreadId: string;
  }): Promise<readonly CanonicalMailReplyBindingCandidate[]>;
}

export interface MailSemanticAdmissionStore {
  get(input: {
    provider: "gmail";
    mailboxBindingId: string;
    providerMessageId: string;
  }): Promise<MailSemanticAdmissionEvidence | null>;
  admit(evidence: MailSemanticAdmissionEvidence): Promise<{
    duplicate: boolean;
    evidence: MailSemanticAdmissionEvidence;
  }>;
}

export interface MailSemanticAdmissionEvidence {
  readonly version: typeof MAIL_SEMANTIC_ADMISSION_VERSION;
  readonly admissionId: string;
  readonly admissionFingerprint: string;
  readonly sourceObservationId: string;
  readonly sourceObservationFingerprint: string;
  readonly provider: "gmail";
  readonly mailboxBindingId: string;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly threadId: string;
  readonly handle: string;
  readonly project: string;
  readonly replyClass: GitHubMailReplyClass;
  readonly semantic: GitHubMailReplyAdmission["semantic"];
  readonly replyId: string;
  readonly replyFingerprint: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly messageContentFingerprint: string;
  readonly quotedAncestrySha256: string | null;
  readonly quotedAncestryByteLength: number;
  readonly visibleFromSha256: string | null;
  readonly recipientCount: number;
  readonly currentHandleCount: number;
  readonly quotedHandleCount: number;
  readonly messageDisposition: AdmittedGmailMessageDisposition;
  readonly effectCapability: TrustedMailEffectCapability;
  readonly authorityFingerprint: string;
  readonly effect: GitHubMailReplyEffect | null;
  readonly effectRequestSuppressed: boolean;
  readonly containsCredentialShapedCurrentReply: boolean;
  readonly humanIdentityEstablished: false;
  readonly grantsAuthority: false;
  readonly grantsResponsibility: false;
  readonly grantsApproval: false;
  readonly providerDispatchAuthorized: false;
  readonly containsRawMailBody: false;
  readonly containsQuotedMailBody: false;
  readonly attachmentsAdmitted: false;
}

/** Field-compatible with the post-#1541 public #1491 authority wrapper. */
export interface TrustedBridgeAuthorityBinding {
  readonly version: 1;
  readonly threadId: string;
  readonly provider: "gmail";
  readonly mailboxBindingId: string;
  readonly expectedMailboxAddress: string;
  readonly providerThreadId: string;
  readonly expectedInReplyToMessageId: string;
  readonly messageDisposition: AdmittedGmailMessageDisposition;
  readonly effectCapability: TrustedMailEffectCapability;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string | null;
  readonly formalReviewVerdict: GitHubFormalReviewVerdict | null;
  readonly causal: GitHubMailCausalContext;
}

export class MailSemanticAdmissionService {
  readonly #bindings: CanonicalMailReplyBindingResolver;
  readonly #messages: GmailSemanticMessageSource;
  readonly #store: MailSemanticAdmissionStore;

  constructor(input: {
    bindings: CanonicalMailReplyBindingResolver;
    messages: GmailSemanticMessageSource;
    store: MailSemanticAdmissionStore;
  }) {
    if (!input.bindings || typeof input.bindings.resolve !== "function") {
      throw new RangeError("Mail semantic binding resolver is required");
    }
    if (!input.messages || typeof input.messages.fetchAdmittedMessage !== "function") {
      throw new RangeError("Mail semantic message source is required");
    }
    if (!input.store || typeof input.store.get !== "function" || typeof input.store.admit !== "function") {
      throw new RangeError("Mail semantic admission store is required");
    }
    this.#bindings = input.bindings;
    this.#messages = input.messages;
    this.#store = input.store;
  }

  async admitMaterialGmailObservation(input: {
    mailboxBindingId: string;
    observation: PostCommitMaterialMailboxObservation;
  }): Promise<{ replay: boolean; evidence: MailSemanticAdmissionEvidence }> {
    const mailboxBindingId = identity(input.mailboxBindingId, "Mailbox binding ID", 240);
    const observation = materialObservation(input.observation);
    const providerMessageId = providerIdentity(observation.providerMessageId, "Provider message ID");
    const providerThreadId = providerIdentity(observation.providerThreadId, "Provider thread ID");

    // Routing is resolved before any message content is fetched.
    const candidates = await this.#bindings.resolve({
      provider: "gmail",
      mailboxBindingId,
      providerThreadId,
    });
    if (!Array.isArray(candidates) || candidates.length !== 1) {
      throw new MailSemanticAdmissionError(
        Array.isArray(candidates) && candidates.length === 0
          ? "MAIL_SEMANTIC_BINDING_NOT_FOUND"
          : "MAIL_SEMANTIC_BINDING_AMBIGUOUS",
      );
    }
    const binding = canonicalBinding(candidates[0]!, mailboxBindingId, providerThreadId);

    // Fetch exactly the one durable provider message selected by the observation.
    const rawMessage = await this.#messages.fetchAdmittedMessage({
      accountBinding: mailboxBindingId,
      providerMessageId,
      expectedProviderThreadId: providerThreadId,
    });
    const message = admitGmailSemanticMessage(rawMessage, {
      providerMessageId,
      providerThreadId,
      expectedInReplyToRfcMessageId: binding.expectedInReplyToRfcMessageId,
    });
    const authority = trustedAuthority(binding, message.messageDisposition);
    const authorityFingerprint = bindingAuthorityFingerprint(
      binding,
      message.messageDisposition,
      providerMessageId,
    );

    const previous = await this.#store.get({
      provider: "gmail",
      mailboxBindingId,
      providerMessageId,
    });
    if (previous) {
      if (
        previous.mailboxBindingId !== mailboxBindingId
        || previous.providerMessageId !== providerMessageId
        || previous.providerThreadId !== providerThreadId
      ) {
        throw new MailSemanticAdmissionError("MAIL_SEMANTIC_PRIOR_IDENTITY_CONFLICT");
      }
      if (previous.messageContentFingerprint !== message.messageContentFingerprint) {
        throw new MailSemanticAdmissionError("MAIL_SEMANTIC_PROVIDER_CONTENT_CONFLICT");
      }
      if (
        previous.threadId !== binding.thread.threadId
        || previous.authorityFingerprint !== authorityFingerprint
      ) {
        throw new MailSemanticAdmissionError("MAIL_SEMANTIC_REPLAY_BINDING_CONFLICT");
      }
      return Object.freeze({ replay: true, evidence: previous });
    }

    const request = semanticRequest(
      message.currentReply,
      message.messageDisposition,
      binding.effectCapability,
      message.containsCredentialShapedCurrentReply,
    );
    const classifierInput = {
      thread: binding.thread,
      provider: "gmail" as const,
      mailboxBindingId,
      providerThreadId,
      providerMessageId,
      inReplyToMessageId: binding.expectedInReplyToProviderMessageId,
      replyClass: request.replyClass,
      body: request.body,
      expectedTargetSourceRevision: binding.expectedTargetSourceRevision,
      expectedHeadRevision: binding.expectedHeadRevision,
      ...(request.replyClass === "mail.github_review_proposal" && binding.formalReviewVerdict !== null
        ? { formalReviewVerdict: binding.formalReviewVerdict }
        : {}),
      causal: binding.causal,
      ...(effectBearing(request.replyClass) ? { authority } : {}),
    };
    const classified = classifyGitHubMailReply(classifierInput);
    if (
      classified.threadId !== binding.thread.threadId
      || classified.providerMessageId !== providerMessageId
      || classified.providerThreadId !== providerThreadId
      || classified.mailboxBindingId !== mailboxBindingId
    ) {
      throw new MailSemanticAdmissionError("MAIL_SEMANTIC_CLASSIFIER_IDENTITY_DRIFT");
    }
    if (request.effectRequestSuppressed && classified.effect !== null) {
      throw new MailSemanticAdmissionError("MAIL_SEMANTIC_SUPPRESSED_EFFECT_ESCAPED");
    }

    const evidence = buildEvidence({
      observation,
      mailboxBindingId,
      binding,
      message,
      classified,
      authorityFingerprint,
      effectRequestSuppressed: request.effectRequestSuppressed,
    });
    const stored = await this.#store.admit(evidence);
    if (stored.evidence.admissionFingerprint !== evidence.admissionFingerprint) {
      throw new MailSemanticAdmissionError("MAIL_SEMANTIC_DURABLE_ADMISSION_CONFLICT");
    }
    return Object.freeze({ replay: stored.duplicate, evidence: stored.evidence });
  }
}

function materialObservation(input: PostCommitMaterialMailboxObservation): PostCommitMaterialMailboxObservation {
  if (
    !input
    || input.provider !== "gmail"
    || input.containsRawContent !== false
    || input.grantsAuthority !== false
    || input.wakeEligible !== true
    || input.loopDisposition !== "ordinary"
    || (input.eventType !== "mail.message.created" && input.eventType !== "mail.scope.added")
  ) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_OBSERVATION_NOT_MATERIAL");
  }
  identity(input.observationId, "Observation ID", 512);
  sha(input.semanticFingerprint, "Observation fingerprint");
  identity(input.providerCursor, "Provider cursor", 256);
  timestamp(input.observedAt, "Observation time");
  timestamp(input.receivedAt, "Receipt time");
  return input;
}

function canonicalBinding(
  input: CanonicalMailReplyBindingCandidate,
  mailboxBindingId: string,
  providerThreadId: string,
): CanonicalMailReplyBindingCandidate {
  if (
    input.version !== 1
    || input.provider !== "gmail"
    || input.mailboxBindingId !== mailboxBindingId
    || input.providerThreadId !== providerThreadId
  ) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_BINDING_IDENTITY_MISMATCH");
  }
  const mailbox = freezeMailboxBinding({
    provider: "gmail",
    accountBinding: mailboxBindingId,
    mailboxAddress: input.expectedMailboxAddress,
  });
  identity(input.expectedInReplyToProviderMessageId, "Expected parent message ID", 512);
  rfcMessageId(input.expectedInReplyToRfcMessageId);
  identity(input.expectedTargetSourceRevision, "Expected target source revision", 512);
  if (input.expectedHeadRevision !== null && !/^[a-f0-9]{40}$/u.test(input.expectedHeadRevision)) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_HEAD_REVISION_INVALID");
  }
  if (input.expectedHeadRevision !== input.thread.currentHeadRevision) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_BINDING_HEAD_DRIFT");
  }
  if (
    input.effectCapability !== "coordination_only"
    && input.effectCapability !== "github_conversation_comment"
    && input.effectCapability !== "github_formal_review"
  ) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_EFFECT_CAPABILITY_INVALID");
  }
  if (
    (input.effectCapability === "github_formal_review") !== (input.formalReviewVerdict !== null)
    || (input.effectCapability !== "coordination_only" && input.expectedHeadRevision === null)
  ) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_REVIEW_BINDING_INVALID");
  }
  return Object.freeze({ ...input, expectedMailboxAddress: mailbox.mailboxAddress });
}

function trustedAuthority(
  binding: CanonicalMailReplyBindingCandidate,
  messageDisposition: AdmittedGmailMessageDisposition,
): TrustedBridgeAuthorityBinding {
  return Object.freeze({
    version: 1 as const,
    threadId: binding.thread.threadId,
    provider: "gmail" as const,
    mailboxBindingId: binding.mailboxBindingId,
    expectedMailboxAddress: binding.expectedMailboxAddress,
    providerThreadId: binding.providerThreadId,
    expectedInReplyToMessageId: binding.expectedInReplyToProviderMessageId,
    messageDisposition,
    effectCapability: binding.effectCapability,
    expectedTargetSourceRevision: binding.expectedTargetSourceRevision,
    expectedHeadRevision: binding.expectedHeadRevision,
    formalReviewVerdict: binding.formalReviewVerdict,
    causal: binding.causal,
  });
}

function bindingAuthorityFingerprint(
  binding: CanonicalMailReplyBindingCandidate,
  messageDisposition: AdmittedGmailMessageDisposition,
  providerMessageId: string,
): string {
  return fingerprintCanonicalRequest({
    version: 1,
    threadId: binding.thread.threadId,
    handle: binding.thread.handle,
    project: binding.thread.project,
    repository: binding.thread.repository,
    pullRequestNumber: binding.thread.pullRequestNumber,
    provider: "gmail",
    mailboxBindingId: binding.mailboxBindingId,
    expectedMailboxAddress: binding.expectedMailboxAddress,
    providerThreadId: binding.providerThreadId,
    providerMessageId,
    expectedInReplyToProviderMessageId: binding.expectedInReplyToProviderMessageId,
    expectedInReplyToRfcMessageId: binding.expectedInReplyToRfcMessageId,
    messageDisposition,
    effectCapability: binding.effectCapability,
    expectedTargetSourceRevision: binding.expectedTargetSourceRevision,
    expectedHeadRevision: binding.expectedHeadRevision,
    formalReviewVerdict: binding.formalReviewVerdict,
    causal: binding.causal,
  });
}

function semanticRequest(
  currentReply: string,
  disposition: AdmittedGmailMessageDisposition,
  capability: TrustedMailEffectCapability,
  containsCredential: boolean,
): { replyClass: GitHubMailReplyClass; body: string; effectRequestSuppressed: boolean } {
  const trimmed = currentReply.trim();
  const lines = trimmed.split("\n");
  const first = lines[0]!.trim();
  const lower = first.toLowerCase();
  let requested: GitHubMailReplyClass;
  let body = trimmed;

  if (lower === "mail.github_comment_proposal") {
    requested = "mail.github_comment_proposal";
    body = markedBody(lines.slice(1), ["github-body:", "comment-body:"]);
  } else if (lower === "mail.github_review_proposal") {
    requested = "mail.github_review_proposal";
    body = markedBody(lines.slice(1), ["review-body:", "github-body:"]);
  } else if (/^ack(?:nowledged)?[.!]?$/iu.test(first)) {
    requested = "mail.acknowledgement";
  } else if (/^handoff\s*:/iu.test(first)) {
    requested = "mail.handoff";
  } else if (/^review[ _-]?finding\s*:/iu.test(first)) {
    requested = "mail.review_finding";
  } else if (/^answer\s*:/iu.test(first)) {
    requested = "mail.answer";
  } else {
    requested = "mail.note";
  }

  if (disposition !== "direct_human_reply") {
    return Object.freeze({
      replyClass: "mail.note" as const,
      body: trimmed,
      effectRequestSuppressed: effectBearing(requested),
    });
  }
  const allowed = requested === "mail.github_comment_proposal"
    ? capability === "github_conversation_comment"
    : requested === "mail.github_review_proposal"
      ? capability === "github_formal_review"
      : true;
  if (effectBearing(requested) && (!allowed || containsCredential)) {
    return Object.freeze({
      replyClass: "mail.note" as const,
      body: trimmed,
      effectRequestSuppressed: true,
    });
  }
  return Object.freeze({
    replyClass: requested,
    body: body.trim() || trimmed,
    effectRequestSuppressed: false,
  });
}

function markedBody(lines: readonly string[], markers: readonly string[]): string {
  for (let index = 0; index < lines.length; index += 1) {
    if (markers.includes(lines[index]!.trim().toLowerCase())) {
      return lines.slice(index + 1).join("\n").trim();
    }
  }
  return lines.join("\n").trim();
}

function buildEvidence(input: {
  observation: PostCommitMaterialMailboxObservation;
  mailboxBindingId: string;
  binding: CanonicalMailReplyBindingCandidate;
  message: ReturnType<typeof admitGmailSemanticMessage>;
  classified: GitHubMailReplyAdmission;
  authorityFingerprint: string;
  effectRequestSuppressed: boolean;
}): MailSemanticAdmissionEvidence {
  const fields = {
    version: MAIL_SEMANTIC_ADMISSION_VERSION,
    admissionId: `mail-semantic:${digest(fingerprintCanonicalRequest({
      provider: "gmail",
      mailboxBindingId: input.mailboxBindingId,
      providerMessageId: input.message.providerMessageId,
    }))}`,
    sourceObservationId: input.observation.observationId,
    sourceObservationFingerprint: input.observation.semanticFingerprint,
    provider: "gmail" as const,
    mailboxBindingId: input.mailboxBindingId,
    providerMessageId: input.message.providerMessageId,
    providerThreadId: input.message.providerThreadId,
    threadId: input.binding.thread.threadId,
    handle: input.binding.thread.handle,
    project: input.binding.thread.project,
    replyClass: input.classified.replyClass,
    semantic: input.classified.semantic,
    replyId: input.classified.replyId,
    replyFingerprint: input.classified.replyFingerprint,
    bodySha256: input.classified.bodySha256,
    bodyByteLength: input.classified.bodyByteLength,
    messageContentFingerprint: input.message.messageContentFingerprint,
    quotedAncestrySha256: input.message.quotedAncestrySha256,
    quotedAncestryByteLength: input.message.quotedAncestryByteLength,
    visibleFromSha256: input.message.visibleFromSha256,
    recipientCount: input.message.recipientCount,
    currentHandleCount: input.message.currentHandleCount,
    quotedHandleCount: input.message.quotedHandleCount,
    messageDisposition: input.message.messageDisposition,
    effectCapability: input.binding.effectCapability,
    authorityFingerprint: input.authorityFingerprint,
    effect: input.classified.effect,
    effectRequestSuppressed: input.effectRequestSuppressed,
    containsCredentialShapedCurrentReply: input.message.containsCredentialShapedCurrentReply,
    humanIdentityEstablished: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
    providerDispatchAuthorized: false as const,
    containsRawMailBody: false as const,
    containsQuotedMailBody: false as const,
    attachmentsAdmitted: false as const,
  };
  return Object.freeze({
    ...fields,
    admissionFingerprint: fingerprintCanonicalRequest(fields),
  });
}

function effectBearing(value: GitHubMailReplyClass): boolean {
  return value === "mail.github_comment_proposal" || value === "mail.github_review_proposal";
}

function providerIdentity(value: string | null, label: string): string {
  if (value === null) throw new MailSemanticAdmissionError("MAIL_SEMANTIC_PROVIDER_IDENTITY_REQUIRED");
  return identity(value, label, 1_024);
}

function identity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new MailSemanticAdmissionError(`MAIL_SEMANTIC_IDENTITY_INVALID:${label}`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new MailSemanticAdmissionError(`MAIL_SEMANTIC_SHA256_INVALID:${label}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) throw new MailSemanticAdmissionError(`MAIL_SEMANTIC_TIMESTAMP_INVALID:${label}`);
  return value;
}

function rfcMessageId(value: unknown): string {
  const text = identity(value, "RFC Message-ID", 320);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(text)) {
    throw new MailSemanticAdmissionError("MAIL_SEMANTIC_RFC_MESSAGE_ID_INVALID");
  }
  return text;
}

function digest(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

export class MailSemanticAdmissionError extends Error {
  readonly name = "MailSemanticAdmissionError";
  constructor(readonly code: string) {
    super(code);
  }
}
