import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryFullName,
} from "../src/github-repository-write-admission.ts";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
} from "../src/repository-write-fence.ts";

const invalidRepositories = [
  "teamleaderleo/.",
  "teamleaderleo/..",
] as const;

describe("GitHub repository-write repository segment admission", () => {
  test("rejects repository dot segments in the shared admission", () => {
    for (const repositoryFullName of invalidRepositories) {
      expect(() => admitGitHubRepositoryFullName(repositoryFullName)).toThrow(
        "GitHub repository write identity is invalid",
      );
    }
  });

  test("preserves the durable fence rejection taxonomy", () => {
    for (const repositoryFullName of invalidRepositories) {
      let thrown: unknown;
      try {
        prepareRepositoryWrite({
          version: 1,
          repositoryFullName,
          path: "docs/dot-segment.md",
          operation: "create_file",
          targetRef: "feature/dot-segment",
          expectedParentSha: "a".repeat(40),
        }, {
          version: 1,
          repositoryFullName,
          targetRef: "feature/dot-segment",
          defaultBranch: "main",
          authorityId: "authority_dot_segment",
          authorityGeneration: 1,
          defaultBranchApprovalId: null,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RepositoryWriteFenceError);
      expect(thrown).toMatchObject({
        code: "invalid_repository_full_name",
        disposition: "rejected",
        retry: "do_not_retry",
      });
    }
  });

  test("rejects before repository token or fetch access", async () => {
    for (const repositoryFullName of invalidRepositories) {
      let tokenCalls = 0;
      let fetchCalls = 0;
      const adapter = new GitHubRestRepositoryWriteAdapter({
        tokenProvider: {
          async getRepositoryContentsToken() {
            tokenCalls += 1;
            return {
              token: "must-not-mint",
              expiresAt: "2026-08-05T16:00:00.000Z",
            };
          },
        },
        fetch: (async () => {
          fetchCalls += 1;
          return Response.json({ message: "must not fetch" }, { status: 500 });
        }) as unknown as typeof fetch,
      });

      await expect(adapter.getRefHead({
        repositoryFullName,
        targetRef: "main",
      })).rejects.toThrow("GitHub repository identity is invalid");
      expect(tokenCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    }
  });
});
