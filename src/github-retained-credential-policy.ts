const realisticRetainedCredentialPattern =
  /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,231}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

/**
 * Returns true when retained public identity text contains one realistic
 * credential family. The detector is intentionally anywhere-in-text and does
 * not require a delimiter before the credential prefix.
 */
export function containsRealisticRetainedCredential(value: string): boolean {
  return realisticRetainedCredentialPattern.test(value);
}
