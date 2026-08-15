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
 * Integration-facing #1491 attention seam. Terminal execution/deployment
 * signals are candidate-revision facts, so a thread with a current PR head
 * accepts them only for that exact head. PR synchronize observations still
 * flow through the lower-level compiler because they are how the head moves.
 */
export function compileCurrentGitHubMailAttention(
  input: CurrentGitHubMailAttentionInput,
): GitHubMailAttentionDecision {
  if (
    input.signal.kind === "terminal_status"
    && input.thread.currentHeadRevision !== null
    && input.signal.observation.revision.toLowerCase()
      !== input.thread.currentHeadRevision.toLowerCase()
  ) {
    throw new RangeError(
      "GitHub terminal status belongs to a stale pull request revision",
    );
  }
  return compileGitHubMailAttention(input);
}
