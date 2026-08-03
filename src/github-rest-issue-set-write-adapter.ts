import {
  withGitHubProviderResponseDeadline,
} from "./github-provider-bounded-response.js";
import {
  GitHubRestIssueSetWriteAdapter as GitHubRestIssueSetWriteAdapterBase,
  type GitHubRestIssueSetWriteAdapterOptions as GitHubRestIssueSetWriteAdapterBaseOptions,
} from "./github-rest-issue-set-write-adapter-base.js";

export interface GitHubRestIssueSetWriteAdapterOptions
  extends GitHubRestIssueSetWriteAdapterBaseOptions {
  providerResponseDeadlineMs?: number;
}

/**
 * Public set-write adapter with one optional total provider-response deadline.
 * The settled provider implementation remains in the private base module.
 */
export class GitHubRestIssueSetWriteAdapter
  extends GitHubRestIssueSetWriteAdapterBase
{
  constructor(options: GitHubRestIssueSetWriteAdapterOptions) {
    const { providerResponseDeadlineMs, ...baseOptions } = options;
    const wrappedFetch = providerResponseDeadlineMs === undefined
      ? baseOptions.fetch
      : withGitHubProviderResponseDeadline(
        baseOptions.fetch ?? globalThis.fetch,
        providerResponseDeadlineMs,
      );
    super({
      ...baseOptions,
      ...(wrappedFetch ? { fetch: wrappedFetch } : {}),
    });
  }
}
