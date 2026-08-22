import type {
  GitHubMailAttentionDecision,
  GitHubMailAttentionReason,
} from "./github-mail-bridge-core.js";
import type { MailSourceReference } from "./mail-outbound-envelope.js";
import type { PublishMailThreadCommand } from "./mail-outbound-service.js";
import {
  parseMailThreadHandle,
  type MailThreadClass,
} from "./mail-thread-contract.js";

export type CompiledGitHubMailMaterial = Omit<
  PublishMailThreadCommand,
  "workspace" | "project" | "mailbox" | "continuationRoute" | "continuesFromHandle"
>;

interface ReasonCopy {
  readonly whatChanged: (decision: GitHubMailAttentionDecision) => string;
  readonly attentionReason: string;
  readonly nextAction: string;
  readonly resolutionCondition: string;
  readonly blocker: string | null;
}

const reasonCopy: Record<GitHubMailAttentionReason, ReasonCopy | null> = {
  pr_opened: reviewCopy("opened"),
  pr_reopened: reviewCopy("reopened"),
  pr_review_ready: {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} is ready for review.`,
    attentionReason: "The tracked candidate entered review-ready state.",
    nextAction: "Refresh the pull request head, reviews, and required checks, then perform the eligible exact-head review.",
    resolutionCondition: "A current-head review verdict is recorded or the candidate changes or is superseded.",
    blocker: null,
  },
  formal_review_approved: {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} received an approving formal review.`,
    attentionReason: "The tracked candidate received an approving review verdict.",
    nextAction: "Refresh the current head, reviews, checks, and merge state, then continue integration under current project policy.",
    resolutionCondition: "The candidate merges, closes, is superseded, or a newer review changes the disposition.",
    blocker: null,
  },
  formal_review_changes_requested: {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} received a changes-requested review.`,
    attentionReason: "The tracked candidate has an explicit repair request.",
    nextAction: "Refresh the current head and review findings, then repair or supersede the candidate before requesting a fresh review.",
    resolutionCondition: "The requested changes are addressed and a fresh current-head review disposition is recorded.",
    blocker: "Current review requests changes on the tracked candidate.",
  },
  formal_review_commented: {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} received a formal review comment.`,
    attentionReason: "The tracked candidate received new formal review evidence.",
    nextAction: "Refresh the current review and candidate head, determine whether the review changes the next action, and continue under project policy.",
    resolutionCondition: "The review evidence is incorporated into the current candidate disposition or superseded by newer evidence.",
    blocker: null,
  },
  ci_failed: {
    whatChanged: (decision) => `Required CI reported a blocking failure for pull request #${decision.pullRequestNumber}.`,
    attentionReason: "A terminal GitHub status is failing for the tracked candidate.",
    nextAction: "Refresh the exact current head and failing checks, diagnose the failure, then repair and verify through the project's normal path.",
    resolutionCondition: "Required checks on the current candidate become acceptable or the candidate is superseded.",
    blocker: "Required CI is failing on the observed candidate.",
  },
  projected_comment_conflict: {
    whatChanged: (decision) => `Projected GitHub comment evidence conflicted for pull request #${decision.pullRequestNumber}.`,
    attentionReason: "A returning GitHub observation disagrees with the recorded projected effect.",
    nextAction: "Refresh the current GitHub object and provider-effect evidence, reconcile the conflict, and do not replay the effect blindly.",
    resolutionCondition: "The projected effect is reconciled to one exact GitHub outcome or explicitly superseded.",
    blocker: "Provider-effect reconciliation is required before another equivalent effect.",
  },
  pr_closed: terminalCopy("closed without merge"),
  pr_merged: terminalCopy("merged"),
  pr_head_changed: null,
  conversation_comment_observed: null,
  inline_review_finding_observed: null,
  ci_terminal_non_success: null,
  ci_succeeded: null,
  projected_comment_reconciled: null,
  routine_github_activity: null,
};

export function compileGitHubMailMaterial(
  decision: GitHubMailAttentionDecision,
): Readonly<CompiledGitHubMailMaterial> | null {
  if (decision.version !== 1) {
    throw new RangeError("GitHub mail attention decision version is unsupported");
  }
  if (
    decision.mailAction === "quiet"
    || decision.deduped
    || decision.loopSuppressed
    || decision.requiresMaterialityDecision
  ) {
    return null;
  }

  const copy = reasonCopy[decision.reason];
  if (copy === null) return null;
  const sourceObject = `github:${decision.repository}#${decision.pullRequestNumber}`;
  const references: readonly MailSourceReference[] = Object.freeze([]);
  const result: CompiledGitHubMailMaterial = {
    threadClass: threadClassFromHandle(decision.handle),
    sourceIdentity: sourceObject,
    canonicalSubject: `${decision.repository} PR #${decision.pullRequestNumber}`,
    sourceFingerprint: decision.materialFingerprint,
    whatChanged: copy.whatChanged(decision),
    attentionReason: copy.attentionReason,
    nextAction: copy.nextAction,
    sourceObject,
    sourceRevision: decision.currentHeadRevision,
    blocker: copy.blocker,
    resolutionCondition: copy.resolutionCondition,
    threadState: decision.mailAction === "resolve" ? "resolved" : "open",
    references,
  };
  return Object.freeze(result);
}

function reviewCopy(action: "opened" | "reopened"): ReasonCopy {
  return {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} ${action} as a review candidate.`,
    attentionReason: "A tracked non-draft candidate is available for review.",
    nextAction: "Refresh the pull request head, reviews, and required checks, then take the eligible review or integration action under current project policy.",
    resolutionCondition: "The candidate receives a current-head disposition, changes materially, closes, or is superseded.",
    blocker: null,
  };
}

function terminalCopy(outcome: "merged" | "closed without merge"): ReasonCopy {
  return {
    whatChanged: (decision) => `Pull request #${decision.pullRequestNumber} ${outcome}.`,
    attentionReason: "The tracked pull request reached a terminal repository state.",
    nextAction: "Refresh the owning work item and repository state, then continue or resolve the lane from current durable facts.",
    resolutionCondition: `The tracked pull request lifecycle is ${outcome}.`,
    blocker: null,
  };
}

function threadClassFromHandle(handle: string): MailThreadClass {
  const parsed = parseMailThreadHandle(handle);
  if (parsed.startsWith("STN-HANDOFF:")) return "handoff";
  if (parsed.startsWith("STN-REVIEW:")) return "review";
  if (parsed.startsWith("STN-DECISION:")) return "decision";
  return "incident";
}
