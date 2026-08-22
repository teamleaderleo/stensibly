import {
  compileGitHubMailAttention,
  type GitHubMailAttentionDecision,
  type GitHubMailBridgeSignal,
  type GitHubMailProjectedEffectReceipt,
  type GitHubMailThreadBinding,
} from "./github-mail-bridge.js";

export interface CurrentGitHubMailAttentionInput {
  readonly thread: GitHubMailThreadBinding;
  readonly signal: GitHubMailBridgeSignal;
  readonly priorMaterialFingerprint?: string | null;
  readonly projectedEffects?: readonly GitHubMailProjectedEffectReceipt[];
}

/**
 * Integration-facing #1491 attention seam. Exact-revision execution and formal
 * review evidence must still belong to the current PR head. PR synchronize
 * observations flow through the lower-level compiler because they are how the
 * head itself moves.
 */
export function compileCurrentGitHubMailAttention(
  input: CurrentGitHubMailAttentionInput,
): GitHubMailAttentionDecision {
  if (
    input.thread.currentHeadRevision !== null
    && input.signal.kind === "terminal_status"
    && input.signal.observation.revision.toLowerCase()
      !== input.thread.currentHeadRevision.toLowerCase()
  ) {
    throw new RangeError(
      "GitHub terminal status belongs to a stale pull request revision",
    );
  }
  if (
    input.thread.currentHeadRevision !== null
    && input.signal.kind === "repository_observation"
    && input.signal.observation.eventType === "pull_request_review"
    && input.signal.observation.relationships.revision !== null
    && input.signal.observation.relationships.revision.toLowerCase()
      !== input.thread.currentHeadRevision.toLowerCase()
  ) {
    throw new RangeError(
      "GitHub formal review belongs to a stale pull request revision",
    );
  }
  return compileGitHubMailAttention(input);
}
