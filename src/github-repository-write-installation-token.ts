import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  admitGitHubRepositoryFullName,
} from "./github-repository-write-admission.js";
import type {
  GitHubRepositoryWriteTokenProvider,
} from "./github-rest-repository-write-adapter.js";

/**
 * Narrows the standard GitHub App installation-token provider to the exact
 * contents permission required by native repository-file reads and writes.
 */
export function repositoryWriteInstallationTokenProvider(
  provider: GitHubInstallationTokenProvider,
): GitHubRepositoryWriteTokenProvider {
  return Object.freeze({
    getRepositoryContentsToken(
      input: Parameters<
        GitHubRepositoryWriteTokenProvider["getRepositoryContentsToken"]
      >[0],
    ) {
      const repositoryFullName = exactRepository(input.repositoryFullName);
      return provider.getInstallationToken({
        repositoryFullName,
        permission: {
          name: "contents",
          access: input.access,
        },
      });
    },
  });
}

function exactRepository(value: unknown): string {
  try {
    return admitGitHubRepositoryFullName(value);
  } catch {
    throw new RangeError("GitHub repository identity is invalid");
  }
}
