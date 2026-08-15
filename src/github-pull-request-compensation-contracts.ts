import type { GitHubPullRequestResult } from "./github-provider-contracts.js";

export type GitHubPullRequestCompensationObservation = Omit<
  GitHubPullRequestResult,
  "state"
> & {
  state: "open" | "closed";
};

export interface GitHubPullRequestCompensationAdapter {
  getPullRequestForCompensation(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestCompensationObservation>;
  closePullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    idempotencyKey: string;
  }): Promise<{
    pullRequest: GitHubPullRequestCompensationObservation;
    providerRequestId: string;
  }>;
}

export class GitHubPullRequestCompensationProviderRejectedError extends Error {
  readonly code = "github_pull_request_compensation_provider_rejected";

  constructor() {
    super("GitHub rejected pull-request close compensation before an ambiguous effect");
    this.name = "GitHubPullRequestCompensationProviderRejectedError";
  }
}
