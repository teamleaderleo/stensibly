import { describe, expect, test } from "vitest";
import {
  DefaultGitHubRunnerGitBranchMutator,
  type GitHubRunnerGitCommandExecutor,
} from "../src/github-runner-git-branch-mutator";

const repository = "teamleaderleo/stensibly";
const branchRef = "refs/heads/lark/compensation-fixture";
const sha = "a".repeat(40);

describe("runner Git branch mutator", () => {
  test("deletes only under an explicit exact-old-head lease", async () => {
    const executor = new CapturingExecutor();
    const mutator = new DefaultGitHubRunnerGitBranchMutator(executor);
    const result = await mutator.deleteBranchExact({
      repositoryFullName: repository,
      targetRef: branchRef,
      expectedOldSha: sha,
      idempotencyKey: "delete:one",
    });

    expect(result).toMatchObject({ attemptId: "git-attempt-1", outcome: "accepted" });
    expect(executor.calls).toEqual([{
      repositoryFullName: repository,
      idempotencyKey: "delete:one",
      args: [
        "push",
        "--porcelain",
        `--force-with-lease=${branchRef}:${sha}`,
        "origin",
        `:${branchRef}`,
      ],
    }]);
  });

  test("restores only under an explicit ref-must-be-absent lease", async () => {
    const executor = new CapturingExecutor();
    const mutator = new DefaultGitHubRunnerGitBranchMutator(executor);
    await mutator.restoreBranchExact({
      repositoryFullName: repository,
      targetRef: branchRef,
      recordedSha: sha,
      idempotencyKey: "restore:one",
    });

    expect(executor.calls[0]?.args).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${branchRef}:`,
      "origin",
      `${sha}:${branchRef}`,
    ]);
  });

  test("rejects non-head refs and malformed object IDs before runner execution", async () => {
    const executor = new CapturingExecutor();
    const mutator = new DefaultGitHubRunnerGitBranchMutator(executor);
    await expect(mutator.deleteBranchExact({
      repositoryFullName: repository,
      targetRef: "refs/tags/v1",
      expectedOldSha: sha,
      idempotencyKey: "bad:ref",
    })).rejects.toThrow("target ref is invalid");
    await expect(mutator.restoreBranchExact({
      repositoryFullName: repository,
      targetRef: branchRef,
      recordedSha: "bad",
      idempotencyKey: "bad:sha",
    })).rejects.toThrow("identity is invalid");
    expect(executor.calls).toHaveLength(0);
  });

  test("rejects runner responses carrying any field outside the closed receipt", async () => {
    const executor: GitHubRunnerGitCommandExecutor = {
      executeGitMutation: async () => ({
        attemptId: "git-attempt-1",
        outcome: "accepted",
        code: null,
        stderr: "credential or provider prose must stay runner-local",
      } as any),
    };
    const mutator = new DefaultGitHubRunnerGitBranchMutator(executor);
    await expect(mutator.deleteBranchExact({
      repositoryFullName: repository,
      targetRef: branchRef,
      expectedOldSha: sha,
      idempotencyKey: "closed:receipt",
    })).rejects.toThrow("result is invalid");
  });
});

class CapturingExecutor implements GitHubRunnerGitCommandExecutor {
  readonly calls: Array<{
    repositoryFullName: string;
    idempotencyKey: string;
    args: readonly string[];
  }> = [];

  async executeGitMutation(input: {
    repositoryFullName: string;
    idempotencyKey: string;
    args: readonly string[];
  }) {
    this.calls.push(structuredClone(input));
    return { attemptId: `git-attempt-${this.calls.length}`, outcome: "accepted" as const, code: null };
  }
}
