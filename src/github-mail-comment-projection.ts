import {
  executeGitHubConversationCommentEffect,
  type GitHubConversationCommentEffect,
  type GitHubMailCommentProvider,
  type GitHubMailProjectedEffectReceipt,
} from "./github-mail-bridge.js";
import type {
  GitHubProviderRequestContext,
  GitHubPullRequestResult,
} from "./github-provider-contracts.js";
import {
  evaluateGitHubOutboundText,
  type GitHubExternalContactAuthority,
  type GitHubOutboundTextPolicy,
  type GitHubOutboundTextReceipt,
} from "./github-outbound-text-policy.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubMailPullRequestProvider extends GitHubMailCommentProvider {
  getPullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestResult>;
}

export interface GovernedGitHubMailCommentProjectionInput {
  readonly provider: GitHubMailPullRequestProvider;
  readonly context: GitHubProviderRequestContext;
  readonly effect: GitHubConversationCommentEffect;
  readonly body: string;
  readonly workspace: string;
  readonly authorityGeneration: number;
  readonly outboundPolicy: GitHubOutboundTextPolicy;
  readonly externalContactAuthority: GitHubExternalContactAuthority | null;
}

export interface GovernedGitHubMailCommentProjectionReceipt {
  readonly version: 1;
  readonly outboundTextReceipt: GitHubOutboundTextReceipt;
  readonly providerEffectReceipt: GitHubMailProjectedEffectReceipt;
}

/**
 * The public #1491 GitHub-comment projection seam. The outbound-text policy
 * evaluates the exact bytes first; provider dispatch remains separately gated
 * by the existing GitHub capability, binding, idempotency, and readback path.
 */
export async function executeGovernedGitHubMailCommentProjection(
  input: GovernedGitHubMailCommentProjectionInput,
): Promise<GovernedGitHubMailCommentProjectionReceipt> {
  const repository = normalizeGitHubRepository(input.effect.repository);
  if (normalizeGitHubRepository(input.context.repository) !== repository) {
    throw new RangeError("GitHub mail projection context targets another repository");
  }
  const [owner, repositoryName] = repository.split("/");
  if (!owner || !repositoryName) {
    throw new RangeError("GitHub mail projection repository identity is invalid");
  }

  const outboundTextReceipt = evaluateGitHubOutboundText({
    workspace: input.workspace,
    project: input.context.project,
    destination: { owner, repository: repositoryName },
    surface: "comment",
    operationRef: input.effect.effectId,
    authorityGeneration: input.authorityGeneration,
    fields: [{ name: "body", text: input.body }],
    policy: input.outboundPolicy,
    externalContactAuthority: input.externalContactAuthority,
  });
  if (outboundTextReceipt.decision !== "allow") {
    throw new GitHubMailOutboundTextRejectedError(outboundTextReceipt);
  }

  const currentPullRequest = await input.provider.getPullRequest({
    repositoryFullName: repository,
    pullRequestNumber: input.effect.pullRequestNumber,
  });
  if (currentPullRequest.number !== input.effect.pullRequestNumber) {
    throw new RangeError("GitHub mail projection current pull request identity changed");
  }
  if (
    input.effect.expectedHeadRevision !== null
    && currentPullRequest.headSha !== input.effect.expectedHeadRevision
  ) {
    throw new GitHubMailStaleHeadError(
      input.effect.expectedHeadRevision,
      currentPullRequest.headSha,
    );
  }

  const providerEffectReceipt = await executeGitHubConversationCommentEffect({
    provider: input.provider,
    context: input.context,
    effect: input.effect,
    body: input.body,
  });
  return Object.freeze({
    version: 1 as const,
    outboundTextReceipt,
    providerEffectReceipt,
  });
}

export class GitHubMailOutboundTextRejectedError extends Error {
  readonly name = "GitHubMailOutboundTextRejectedError";
  constructor(readonly receipt: GitHubOutboundTextReceipt) {
    super("GitHub mail comment projection was rejected by outbound text policy");
  }
}

export class GitHubMailStaleHeadError extends Error {
  readonly name = "GitHubMailStaleHeadError";
  readonly recoveryAction = "refresh_mail_handoff_before_retry" as const;

  constructor(
    readonly expectedHeadRevision: string,
    readonly currentHeadRevision: string,
  ) {
    super("GitHub pull request head changed after mail admission");
  }
}
