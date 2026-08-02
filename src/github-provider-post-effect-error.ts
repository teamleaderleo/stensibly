export class GitHubProviderPostEffectError extends Error {
  readonly providerRequestId: string | null;

  constructor(providerRequestId: string | null) {
    super(
      "GitHub provider effect requires reconciliation after verification failed",
    );
    this.name = "GitHubProviderPostEffectError";
    this.providerRequestId = providerRequestId;
  }
}
