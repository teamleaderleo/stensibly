import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
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
    getRepositoryContentsToken(input) {
      return provider.getInstallationToken({
        repositoryFullName: input.repositoryFullName,
        permission: {
          name: "contents",
          access: input.access,
        },
      });
    },
  });
}
