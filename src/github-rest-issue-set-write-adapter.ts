import {
  withGitHubProviderResponseReadTimeout,
} from "./github-provider-bounded-response.js";
import {
  GitHubRestIssueSetWriteAdapter as GitHubRestIssueSetWriteAdapterBase,
  type GitHubRestIssueSetWriteAdapterOptions as GitHubRestIssueSetWriteAdapterBaseOptions,
} from "./github-rest-issue-set-write-adapter-base.js";

export interface GitHubRestIssueSetWriteAdapterOptions
  extends GitHubRestIssueSetWriteAdapterBaseOptions {
  responseReadTimeoutMs?: number;
}

/**
 * Public set-write adapter with one optional bounded response-body deadline.
 * The settled provider implementation remains in the private base module.
 */
export class GitHubRestIssueSetWriteAdapter
  extends GitHubRestIssueSetWriteAdapterBase
{
  constructor(options: GitHubRestIssueSetWriteAdapterOptions) {
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
