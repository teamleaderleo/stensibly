import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;

describe("GitHub set-write adapter request identity", () => {
  test("carries the admitted mutation request ID when its internal readback fails", async () => {
    let mutationCalls = 0;
    let readCalls = 0;
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: {
        async getInstallationToken(input) {
          return {
            token: `token-${"issues" in input ? input.issues : input.permission.access}`,
            expiresAt: "2026-08-03T02:00:00.000Z",
          };
        },
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
          mutationCalls += 1;
          return Response.json([{ name: "area:github" }], {
            headers: { "x-github-request-id": "REQ-SET-INTERNAL" },
          });
        }
        if (method === "GET" && url.endsWith(`/issues/${issueNumber}`)) {
          readCalls += 1;
          return Response.json({ message: "verification unavailable" }, {
            status: 503,
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as typeof fetch,
    });

    try {
      await adapter.addIssueLabels({
        repositoryFullName,
        issueNumber,
        labels: ["area:github"],
        idempotencyKey: "adapter-request-id-retention",
      });
      throw new Error("Expected post-effect ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
      expect((error as GitHubProviderPostEffectError).providerRequestId).toBe(
        "REQ-SET-INTERNAL",
      );
      expect((error as Error).message).toBe(
        "GitHub provider effect requires reconciliation after verification failed",
      );
    }
    expect(mutationCalls).toBe(1);
    expect(readCalls).toBe(1);
  });
});
