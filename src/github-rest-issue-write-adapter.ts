import {
  withGitHubProviderResponseDeadline,
} from "./github-provider-bounded-response.js";
import {
  GitHubRestIssueWriteAdapter as GitHubRestIssueWriteAdapterBase,
  type GitHubRestIssueWriteAdapterOptions as GitHubRestIssueWriteAdapterBaseOptions,
} from "./github-rest-issue-write-adapter-base.js";

export interface GitHubRestIssueWriteAdapterOptions
  extends GitHubRestIssueWriteAdapterBaseOptions {
  providerResponseDeadlineMs?: number;
}

/**
 * Public issue-write adapter with one optional total provider-response
 * deadline. The settled provider implementation remains in the private base
 * module.
 */
export class GitHubRestIssueWriteAdapter
  extends GitHubRestIssueWriteAdapterBase
{
  constructor(options: GitHubRestIssueWriteAdapterOptions) {
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
