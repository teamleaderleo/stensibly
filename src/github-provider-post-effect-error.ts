const providerRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const credentialShapedRequestIdPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

export class GitHubProviderPostEffectError extends Error {
  readonly providerRequestId: string | null;

  constructor(providerRequestId: unknown) {
    super(
      "GitHub provider effect requires reconciliation after verification failed",
    );
    this.name = "GitHubProviderPostEffectError";
    this.providerRequestId = admittedProviderRequestId(providerRequestId);
  }
}

function admittedProviderRequestId(value: unknown): string | null {
  return typeof value === "string"
      && providerRequestIdPattern.test(value)
      && !credentialShapedRequestIdPattern.test(value)
    ? value
    : null;
}
