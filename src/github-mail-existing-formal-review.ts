import {
  GITHUB_MAIL_BRIDGE_VERSION,
  type GitHubFormalReviewEffectProposal,
  type GitHubMailReplyAdmission,
} from "./github-mail-bridge.js";
import type {
  GitHubMailFormalReviewAdmission,
  GitHubMailFormalReviewProposal,
} from "./github-mail-formal-review-projection.js";

/**
 * Adapts the original #1491 APPROVE / REQUEST_CHANGES admission into the #1502
 * dispatcher without recomputing either mail reply identity or formal-review
 * effect identity. COMMENT is admitted by the #1502 extension because #1491's
 * original closed verdict family predates formal COMMENT dispatch.
 */
export function consumeExistingGitHubFormalReviewProposal(
  admission: GitHubMailReplyAdmission,
): GitHubMailFormalReviewAdmission {
  if (
    admission.version !== GITHUB_MAIL_BRIDGE_VERSION
    || admission.replyClass !== "mail.github_review_proposal"
    || admission.semantic !== "formal_review_proposal"
    || admission.effect?.kind !== "github_formal_review"
    || admission.authorityFingerprint === null
    || admission.messageDisposition !== "direct_human_reply"
    || admission.effectCapability !== "github_formal_review"
  ) {
    throw new RangeError(
      "Existing mail admission is not a typed GitHub formal-review proposal",
    );
  }
  const effect = exactExistingEffect(admission.effect);
  return deepFreeze({
    version: admission.version,
    replyId: admission.replyId,
    threadId: admission.threadId,
    provider: admission.provider,
    mailboxBindingId: admission.mailboxBindingId,
    providerThreadId: admission.providerThreadId,
    providerMessageId: admission.providerMessageId,
    inReplyToMessageId: admission.inReplyToMessageId,
    replyClass: "mail.github_review_proposal" as const,
    semantic: "formal_review_proposal" as const,
    bodySha256: admission.bodySha256,
    bodyByteLength: admission.bodyByteLength,
    replyFingerprint: admission.replyFingerprint,
    authorityFingerprint: admission.authorityFingerprint,
    messageDisposition: admission.messageDisposition,
    effectCapability: admission.effectCapability,
    replay: admission.replay,
    effect,
    containsRawMailBody: false as const,
  });
}

function exactExistingEffect(
  effect: GitHubFormalReviewEffectProposal,
): GitHubMailFormalReviewProposal {
  if (effect.verdict !== "APPROVE" && effect.verdict !== "REQUEST_CHANGES") {
    throw new RangeError("Existing GitHub formal-review verdict is unsupported");
  }
  return effect;
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
