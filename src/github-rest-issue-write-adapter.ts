import {
  withGitHubProviderResponseReadTimeout,
} from "./github-provider-bounded-response.js";
import {
  GitHubRestIssueWriteAdapter as GitHubRestIssueWriteAdapterBase,
  type GitHubRestIssueWriteAdapterOptions as GitHubRestIssueWriteAdapterBaseOptions,
} from "./github-rest-issue-write-adapter-base.js";

export interface GitHubRestIssueWriteAdapterOptions
  extends GitHubRestIssueWriteAdapterBaseOptions {
  responseReadTimeoutMs?: number;
}

/**
 * Public issue-write adapter with one optional bounded response-body deadline.
 * The settled provider implementation remains in the private base module.
 */
export class GitHubRestIssueWriteAdapter
  extends GitHubRestIssueWriteAdapterBase
{
  constructor(options: GitHubRestIssueWriteAdapterOptions) {
    const { responseReadTimeoutMs, ...baseOptions } = options;
    const wrappedFetch = responseReadTimeoutMs === undefined
      ? baseOptions.fetch
      : withGitHubProviderResponseReadTimeout(
        baseOptions.fetch ?? globalThis.fetch,
        responseReadTimeoutMs,
      );
    super({
      ...baseOptions,
      ...(wrappedFetch ? { fetch: wrappedFetch } : {}),
    });
  }
}
