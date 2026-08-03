import { describe, expect, test } from "bun:test";
import {
  admitGitHubBranchRef,
} from "../src/github-repository-write-admission.ts";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fullRefs = [
  "refs/remotes/origin/main",
  "refs/tags/v1",
  "refs/pull/123/head",
] as const;

describe("GitHub repository-write full ref admission", () => {
  test("rejects caller-selected full ref namespaces in the shared policy", () => {
    for (const ref of fullRefs) {
      expect(() => admitGitHubBranchRef(ref)).toThrow(
        "GitHub repository write identity is invalid",
      );
    }
  });

  test("rejects full refs before repository token or fetch access", async () => {
    for (const targetRef of fullRefs) {
      let tokenCalls = 0;
      let fetchCalls = 0;
      const adapter = new GitHubRestRepositoryWriteAdapter({
        tokenProvider: {
          async getRepositoryContentsToken() {
            tokenCalls += 1;
            return {
              token: "must-not-mint",
              expiresAt: "2026-08-03T22:00:00.000Z",
            };
          },
        },
        fetch: (async () => {
          fetchCalls += 1;
          return Response.json({ message: "must not fetch" }, { status: 500 });
        }) as typeof fetch,
      });

      await expect(adapter.getRefHead({
        repositoryFullName,
        targetRef,
      })).rejects.toThrow("GitHub target branch is invalid");
      expect(tokenCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    }
  });

  test("preserves an ordinary slash-containing branch name", () => {
    expect(admitGitHubBranchRef("feature/review")).toBe("feature/review");
  });
});
