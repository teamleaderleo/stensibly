import { describe, expect, test } from "bun:test";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;

describe("GitHub set-write early response cancellation", () => {
  test("cancels every response body before status or request-ID early exit", async () => {
    const cases: Array<{
      name: string;
      status: number;
      requestId: string | null;
      assertError: (error: unknown) => void;
    }> = [
      {
        name: "definitive-422",
        status: 422,
        requestId: "REQ-DEFINITIVE-422",
        assertError(error) {
          expect(error).toBeInstanceOf(GitHubProviderRejectedError);
          expect(error).toMatchObject({
            code: "github_provider_request_rejected",
            message: "GitHub rejected add issue labels",
          });
        },
      },
      {
        name: "retryable-503-with-request-id",
        status: 503,
        requestId: "REQ-RETRYABLE-503",
        assertError(error) {
          expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
          expect(error).toMatchObject({
            providerRequestId: "REQ-RETRYABLE-503",
            message:
              "GitHub provider effect requires reconciliation after verification failed",
          });
        },
      },
      {
        name: "retryable-429-without-request-id",
        status: 429,
        requestId: null,
        assertError(error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            "GitHub add issue labels outcome requires reconciliation",
          );
        },
      },
      {
        name: "successful-response-without-request-id",
        status: 200,
        requestId: null,
        assertError(error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            "GitHub add issue labels succeeded without an admissible exact response; reconcile before retry",
          );
        },
      },
    ];

    for (const candidate of cases) {
      let cancelCalled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => {});
        },
      });
      const headers = new Headers({ "content-type": "application/json" });
      if (candidate.requestId) {
        headers.set("x-github-request-id", candidate.requestId);
      }
      const response = new Response(body, {
        status: candidate.status,
        headers,
      });
      const adapter = new GitHubRestIssueSetWriteAdapter({
        tokenProvider: tokenProvider(),
        fetch: (async () => response) as unknown as typeof fetch,
      });

      const outcome = await Promise.race([
        adapter.addIssueLabels({
          repositoryFullName,
          issueNumber,
          labels: ["area:github"],
          idempotencyKey: `early-response-cancel-${candidate.name}`,
        }).then(
          () => ({ kind: "fulfilled" as const, error: null }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "timeout"; error: null }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout", error: null }), 250);
        }),
      ]);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") {
        throw new Error(`${candidate.name} did not settle through its fixed outcome`);
      }
      candidate.assertError(outcome.error);
      expect(cancelCalled).toBe(true);
    }
  });
});

function tokenProvider() {
  return {
    async getInstallationToken() {
      return {
        token: "installation-token",
        expiresAt: "2026-08-03T12:00:00.000Z",
      };
    },
  };
}
