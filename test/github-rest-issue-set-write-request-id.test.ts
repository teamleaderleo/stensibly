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
    const adapter = createAdapter((url, method) => {
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
    });

    await expectRequestId(adapter, "REQ-SET-INTERNAL");
    expect(mutationCalls).toBe(1);
    expect(readCalls).toBe(1);
  });

  test("retains request identity for malformed JSON, wrong shape, and effect mismatch", async () => {
    const cases: Array<{
      requestId: string;
      response: () => Response;
    }> = [
      {
        requestId: "REQ-MALFORMED-JSON",
        response: () => new Response("{", {
          status: 200,
          headers: { "x-github-request-id": "REQ-MALFORMED-JSON" },
        }),
      },
      {
        requestId: "REQ-WRONG-SHAPE",
        response: () => Response.json({ labels: [] }, {
          headers: { "x-github-request-id": "REQ-WRONG-SHAPE" },
        }),
      },
      {
        requestId: "REQ-EFFECT-MISMATCH",
        response: () => Response.json([{ name: "other" }], {
          headers: { "x-github-request-id": "REQ-EFFECT-MISMATCH" },
        }),
      },
    ];

    for (const candidate of cases) {
      let reads = 0;
      const adapter = createAdapter((url, method) => {
        if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
          return candidate.response();
        }
        if (method === "GET") reads += 1;
        return Response.json({ message: "unexpected request" }, { status: 500 });
      });
      await expectRequestId(adapter, candidate.requestId);
      expect(reads).toBe(0);
    }
  });

  test("retains request identity for an ambiguous provider 5xx response", async () => {
    const adapter = createAdapter((url, method) => {
      if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
        return Response.json({ message: "provider unavailable" }, {
          status: 503,
          headers: { "x-github-request-id": "REQ-PROVIDER-503" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    await expectRequestId(adapter, "REQ-PROVIDER-503");
  });

  test("keeps request identity absent when the response has no admissible ID", async () => {
    const adapter = createAdapter((url, method) => {
      if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
        return Response.json([{ name: "area:github" }]);
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });

    await expect(adapter.addIssueLabels(input())).rejects.toThrow(
      "succeeded without an admissible exact response",
    );
  });
});

function createAdapter(
  respond: (url: string, method: string) => Response,
): GitHubRestIssueSetWriteAdapter {
  return new GitHubRestIssueSetWriteAdapter({
    tokenProvider: {
      async getInstallationToken(input) {
        return {
          token: `token-${"issues" in input ? input.issues : input.permission.access}`,
          expiresAt: "2026-08-03T02:00:00.000Z",
        };
      },
    },
    fetch: (async (request: RequestInfo | URL, init?: RequestInit) =>
      respond(String(request), init?.method ?? "GET")) as typeof fetch,
  });
}

async function expectRequestId(
  adapter: GitHubRestIssueSetWriteAdapter,
  requestId: string,
): Promise<void> {
  try {
    await adapter.addIssueLabels(input());
    throw new Error("Expected post-effect ambiguity");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
    expect((error as GitHubProviderPostEffectError).providerRequestId).toBe(
      requestId,
    );
    expect((error as Error).message).toBe(
      "GitHub provider effect requires reconciliation after verification failed",
    );
  }
}

function input() {
  return {
    repositoryFullName,
    issueNumber,
    labels: ["area:github"],
    idempotencyKey: "adapter-request-id-retention",
  };
}
