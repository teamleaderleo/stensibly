const defaultOnHostedGitHubCapabilityKeys = new Set<string>([
  "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
  "STENSIBLY_GITHUB_DELEGATED_READS_ENABLED",
  "STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED",
]);

const hostedGitHubProviderConfigurationKeys = [
  "STENSIBLY_GITHUB_APP_ID",
  "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
  "STENSIBLY_GITHUB_INSTALLATION_ID",
  "STENSIBLY_GITHUB_PROVIDER_PROJECT",
  "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
  "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
  "STENSIBLY_GITHUB_API_BASE_URL",
] as const;

export function exactBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key];
  if (value === undefined || value === "") {
    return defaultOnHostedGitHubCapabilityKeys.has(key)
      && hasHostedGitHubProviderConfigurationSignal(env);
  }
  if (value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${key} must be exact true or false`);
}

function hasHostedGitHubProviderConfigurationSignal(
  env: Record<string, string | undefined>,
): boolean {
  return hostedGitHubProviderConfigurationKeys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}
