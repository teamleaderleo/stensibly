import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";

export function normalizeGitHubBranchName(
  value: string,
  label = "GitHub branch",
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 240
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/u.test(value)
    || containsRealisticRetainedCredential(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  if (
    value === "@"
    || value === "HEAD"
    || value.startsWith("refs/heads/")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.startsWith("-")
    || value.includes("//")
    || value.includes("..")
    || value.includes("@{")
    || /[~^:?*\[\\\s]/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  if (value.split("/").some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.endsWith(".")
    || segment.endsWith(".lock")
  )) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
