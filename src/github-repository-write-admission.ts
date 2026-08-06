const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|bearer\s+[A-Za-z0-9._~+\/-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

export function containsGitHubRepositoryWriteCredential(
  value: unknown,
): boolean {
  return typeof value === "string" && credentialShapedPattern.test(value);
}

export function admitGitHubRepositoryFullName(value: unknown): string {
  const text = exactAscii(value, 200);
  if (
    text !== text.toLowerCase()
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/u.test(text)
  ) {
    throw invalidAdmission();
  }
  return text;
}

export function admitGitHubBranchRef(value: unknown): string {
  const text = exactAscii(value, 240);
  if (
    text === "@"
    || text === "HEAD"
    || text.startsWith("refs/")
    || text.startsWith("/")
    || text.endsWith("/")
    || text.startsWith("-")
    || text.includes("//")
    || text.includes("..")
    || text.includes("@{")
    || /[~^:?*\[\\\s]/u.test(text)
  ) {
    throw invalidAdmission();
  }
  const segments = text.split("/");
  if (
    segments.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
      || segment.endsWith(".")
      || segment.endsWith(".lock")
    )
  ) {
    throw invalidAdmission();
  }
  return text;
}

export function admitGitHubRepositoryPath(value: unknown): string {
  const text = exactAscii(value, 4_096);
  if (
    text.trim() !== text
    || text.includes("\\")
    || text.startsWith("/")
    || text.endsWith("/")
  ) {
    throw invalidAdmission();
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidAdmission();
  }
  return text;
}

export function admitGitObjectId(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw invalidAdmission();
  }
  return value;
}

export function sameGitObjectFormat(
  first: string,
  ...rest: readonly string[]
): boolean {
  return rest.every((value) => value.length === first.length);
}

function exactAscii(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumBytes
    || !/^[\x20-\x7e]+$/u.test(value)
    || containsGitHubRepositoryWriteCredential(value)
  ) {
    throw invalidAdmission();
  }
  return value;
}

function invalidAdmission(): RangeError {
  return new RangeError("GitHub repository write identity is invalid");
}
