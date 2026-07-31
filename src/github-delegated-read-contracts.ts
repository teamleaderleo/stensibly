import {
  boundedText,
  stableJson,
} from "./github-provider-validation.js";

export const githubDelegatedReadContractToolNames = [
  "get_repo",
  "fetch_file",
  "get_pr_info",
  "get_pr_diff",
  "list_pull_request_review_threads",
  "get_commit_combined_status",
  "fetch_commit_workflow_runs",
  "fetch_workflow_run_jobs",
  "fetch_workflow_job_steps",
  "fetch_workflow_job_logs",
] as const;

export type GitHubDelegatedReadContractTool =
  typeof githubDelegatedReadContractToolNames[number];

const supportedTools = new Set<string>(githubDelegatedReadContractToolNames);
const repositorySelectorKeys = new Set([
  "repository",
  "repository_full_name",
  "repository_id",
  "repository_url",
  "repo_full_name",
  "owner",
  "repo",
  "repo_name",
]);

/**
 * Validates the exact caller-controlled arguments for the initial delegated-read release.
 * Repository identity is supplied separately by the accepted Stensibly binding.
 */
export function parseGitHubDelegatedReadArguments(
  tool: string,
  input: unknown,
): Record<string, unknown> {
  const name = canonicalGitHubDelegatedReadTool(tool);
  if (!supportedTools.has(name)) {
    throw new GitHubDelegatedReadContractError(
      `GitHub delegated read ${name} has no enabled input contract`,
    );
  }
  const value = jsonObject(input, "GitHub delegated arguments");
  for (const key of Object.keys(value)) {
    if (repositorySelectorKeys.has(key)) {
      throw new GitHubDelegatedReadContractError(
        `GitHub delegated argument ${key} cannot override the accepted repository binding`,
      );
    }
  }

  switch (name as GitHubDelegatedReadContractTool) {
    case "get_repo":
      exactKeys(value, []);
      return boundedArguments({});
    case "fetch_file":
      exactKeys(value, ["path", "ref"]);
      return boundedArguments({
        path: repositoryPath(value.path),
        ref: commitSha(value.ref),
      });
    case "get_pr_info":
    case "list_pull_request_review_threads":
      exactKeys(value, ["pr_number"]);
      return boundedArguments({
        pr_number: positiveInteger(value.pr_number, "GitHub pull request number"),
      });
    case "get_pr_diff":
      exactKeys(value, ["pr_number", "format"]);
      return boundedArguments({
        pr_number: positiveInteger(value.pr_number, "GitHub pull request number"),
        ...(value.format === undefined ? {} : { format: diffFormat(value.format) }),
      });
    case "get_commit_combined_status":
    case "fetch_commit_workflow_runs":
      exactKeys(value, ["commit_sha"]);
      return boundedArguments({ commit_sha: commitSha(value.commit_sha) });
    case "fetch_workflow_run_jobs":
      exactKeys(value, ["run_id"]);
      return boundedArguments({
        run_id: positiveInteger(value.run_id, "GitHub workflow run ID"),
      });
    case "fetch_workflow_job_steps":
    case "fetch_workflow_job_logs":
      exactKeys(value, ["job_id"]);
      return boundedArguments({
        job_id: positiveInteger(value.job_id, "GitHub workflow job ID"),
      });
  }
  throw new GitHubDelegatedReadContractError(
    `GitHub delegated read ${name} has no executable input contract`,
  );
}

export function canonicalGitHubDelegatedReadTool(value: unknown): string {
  const exact = exactAsciiText(value, "GitHub delegated tool name", 128);
  const normalized = exact.toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(normalized)) {
    throw new GitHubDelegatedReadContractError(
      "GitHub delegated tool name is invalid",
    );
  }
  return normalized;
}

export function supportsGitHubDelegatedReadContract(tool: string): boolean {
  try {
    return supportedTools.has(canonicalGitHubDelegatedReadTool(tool));
  } catch {
    return false;
  }
}

export class GitHubDelegatedReadContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubDelegatedReadContractError";
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubDelegatedReadContractError(`${label} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GitHubDelegatedReadContractError(`${label} must be a plain JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GitHubDelegatedReadContractError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const canonical = boundedText(key, `${label} key`, 128);
    if (canonical !== key) {
      throw new GitHubDelegatedReadContractError(`${label} keys must be canonical`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new GitHubDelegatedReadContractError(
        `${label} field ${key} must be an enumerable data property`,
      );
    }
    const nested = descriptor.value;
    if (
      nested === undefined
      || typeof nested === "function"
      || typeof nested === "symbol"
      || typeof nested === "bigint"
      || (typeof nested === "number" && !Number.isFinite(nested))
    ) {
      throw new GitHubDelegatedReadContractError(`${label} contains a non-JSON value`);
    }
    result[key] = nested;
  }
  return result;
}

function boundedArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (Buffer.byteLength(stableJson(value), "utf8") > 16 * 1024) {
    throw new GitHubDelegatedReadContractError(
      "GitHub delegated arguments exceed 16384 UTF-8 bytes",
    );
  }
  return Object.freeze(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new GitHubDelegatedReadContractError(
        `GitHub delegated argument ${key} is unsupported`,
      );
    }
  }
}

function repositoryPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new GitHubDelegatedReadContractError(
      "GitHub repository file path must be a string",
    );
  }
  const path = value.replace(/\\/g, "/");
  if (
    path !== value
    || !path
    || path.startsWith("/")
    || path.endsWith("/")
    || Buffer.byteLength(path, "utf8") > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new GitHubDelegatedReadContractError(
      "GitHub repository file path must be a canonical relative path",
    );
  }
  return path;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string") {
    throw new GitHubDelegatedReadContractError("GitHub commit SHA must be a string");
  }
  if (value !== value.trim() || !/^[A-Fa-f0-9]{40}$/.test(value)) {
    throw new GitHubDelegatedReadContractError(
      "GitHub commit SHA must contain exactly 40 hexadecimal characters without surrounding whitespace",
    );
  }
  return value.toLowerCase();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubDelegatedReadContractError(`${label} must be a positive integer`);
  }
  return value;
}

function diffFormat(value: unknown): "diff" | "patch" {
  if (value !== "diff" && value !== "patch") {
    throw new GitHubDelegatedReadContractError(
      "GitHub pull request diff format must be diff or patch",
    );
  }
  return value;
}

function exactAsciiText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new GitHubDelegatedReadContractError(`${label} must be a string`);
  }
  if (!value || value.length > maximum || !/^[\x20-\x7e]+$/.test(value)) {
    throw new GitHubDelegatedReadContractError(
      `${label} must use 1 to ${maximum} exact printable ASCII characters`,
    );
  }
  if (value !== value.trim()) {
    throw new GitHubDelegatedReadContractError(
      `${label} must not contain surrounding whitespace`,
    );
  }
  return value;
}
