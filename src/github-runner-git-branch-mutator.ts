import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitObjectId,
} from "./github-repository-write-admission.js";

export type GitHubRunnerGitMutationOutcome =
  | "accepted"
  | "lease_conflict"
  | "ambiguous"
  | "rejected";

export interface GitHubRunnerGitMutationResult {
  attemptId: string;
  outcome: GitHubRunnerGitMutationOutcome;
  code: string | null;
}

/**
 * Executes one bounded Git command on a runner that already has authenticated
 * access to the exact repository checkout/remote. Implementations must return
 * closed outcome codes only: stdout, stderr, credentials, and provider prose do
 * not cross this boundary.
 */
export interface GitHubRunnerGitCommandExecutor {
  executeGitMutation(input: {
    repositoryFullName: string;
    idempotencyKey: string;
    args: readonly string[];
  }): Promise<GitHubRunnerGitMutationResult>;
}

export interface GitHubRunnerGitBranchMutator {
  deleteBranchExact(input: {
    repositoryFullName: string;
    targetRef: string;
    expectedOldSha: string;
    idempotencyKey: string;
  }): Promise<GitHubRunnerGitMutationResult>;
  restoreBranchExact(input: {
    repositoryFullName: string;
    targetRef: string;
    recordedSha: string;
    idempotencyKey: string;
  }): Promise<GitHubRunnerGitMutationResult>;
}

/**
 * Runner-backed branch ref mutation. Explicit force-with-lease expectations are
 * the concurrency primitive; there is no REST read-then-delete path here.
 */
export class DefaultGitHubRunnerGitBranchMutator
  implements GitHubRunnerGitBranchMutator {
  readonly #executor: GitHubRunnerGitCommandExecutor;

  constructor(executor: GitHubRunnerGitCommandExecutor) {
    this.#executor = executor;
  }

  async deleteBranchExact(input: {
    repositoryFullName: string;
    targetRef: string;
    expectedOldSha: string;
    idempotencyKey: string;
  }): Promise<GitHubRunnerGitMutationResult> {
    const repositoryFullName = admitGitHubRepositoryFullName(input.repositoryFullName);
    const targetRef = exactHeadRef(input.targetRef);
    const expectedOldSha = admitGitObjectId(input.expectedOldSha);
    const idempotencyKey = exactIdentifier(input.idempotencyKey, "Runner Git idempotency key", 240);
    return admitResult(await this.#executor.executeGitMutation({
      repositoryFullName,
      idempotencyKey,
      args: Object.freeze([
        "push",
        "--porcelain",
        `--force-with-lease=${targetRef}:${expectedOldSha}`,
        "origin",
        `:${targetRef}`,
      ]),
    }));
  }

  async restoreBranchExact(input: {
    repositoryFullName: string;
    targetRef: string;
    recordedSha: string;
    idempotencyKey: string;
  }): Promise<GitHubRunnerGitMutationResult> {
    const repositoryFullName = admitGitHubRepositoryFullName(input.repositoryFullName);
    const targetRef = exactHeadRef(input.targetRef);
    const recordedSha = admitGitObjectId(input.recordedSha);
    const idempotencyKey = exactIdentifier(input.idempotencyKey, "Runner Git idempotency key", 240);
    return admitResult(await this.#executor.executeGitMutation({
      repositoryFullName,
      idempotencyKey,
      args: Object.freeze([
        "push",
        "--porcelain",
        `--force-with-lease=${targetRef}:`,
        "origin",
        `${recordedSha}:${targetRef}`,
      ]),
    }));
  }
}

export function exactHeadRef(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("refs/heads/")) {
    throw new RangeError("GitHub branch compensation target ref is invalid");
  }
  const branch = admitGitHubBranchRef(value.slice("refs/heads/".length));
  return `refs/heads/${branch}`;
}

function admitResult(value: unknown): GitHubRunnerGitMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Runner Git mutation result is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\u0000") !== ["attemptId", "code", "outcome"].sort().join("\u0000")) {
    throw new RangeError("Runner Git mutation result is invalid");
  }
  const attemptId = exactIdentifier(record.attemptId, "Runner Git attempt ID", 240);
  if (![
    "accepted",
    "lease_conflict",
    "ambiguous",
    "rejected",
  ].includes(String(record.outcome))) {
    throw new RangeError("Runner Git mutation outcome is invalid");
  }
  const code = record.code === null
    ? null
    : exactIdentifier(record.code, "Runner Git outcome code", 120);
  return Object.freeze({
    attemptId,
    outcome: record.outcome as GitHubRunnerGitMutationOutcome,
    code,
  });
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
