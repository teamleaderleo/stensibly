import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;

describe("GitHub set-write early response body settlement", () => {
  test("cancels definitive rejected response bodies without awaiting cancellation", async () => {
    const observed = earlyResponse({ status: 422, requestId: "REQ-EARLY-422" });
    const outcome = await boundedOutcome(addLabels(adapterFor(observed.response)));

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("Expected provider rejection");
    expect(outcome.error).toBeInstanceOf(GitHubProviderRejectedError);
    expect(outcome.error).toMatchObject({ code: "github_provider_request_rejected" });
    expect(observed.cancelCalled()).toBe(true);
  });

  test("cancels retryable response bodies while retaining admitted request identity", async () => {
    for (const status of [408, 429, 503]) {
      const requestId = `REQ-EARLY-${status}`;
      const observed = earlyResponse({ status, requestId });
      const outcome = await boundedOutcome(addLabels(adapterFor(observed.response)));

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("Expected retryable ambiguity");
      expect(outcome.error).toBeInstanceOf(GitHubProviderPostEffectError);
      expect(outcome.error).toMatchObject({ providerRequestId: requestId });
      expect(observed.cancelCalled()).toBe(true);
    }
  });

  test("cancels retryable response bodies without manufacturing request identity", async () => {
    const observed = earlyResponse({ status: 503, requestId: null });
    const outcome = await boundedOutcome(addLabels(adapterFor(observed.response)));

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("Expected transport ambiguity");
    expect(outcome.error).not.toBeInstanceOf(GitHubProviderPostEffectError);
    expect((outcome.error as Error).message).toBe(
      "GitHub add issue labels outcome requires reconciliation",
    );
    expect(observed.cancelCalled()).toBe(true);
  });

  test("cancels successful response bodies missing admissible request identity", async () => {
    for (const requestId of [null, "credential github_pat_invalid"] as const) {
      const observed = earlyResponse({ status: 200, requestId });
      const outcome = await boundedOutcome(addLabels(adapterFor(observed.response)));

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("Expected missing-identity ambiguity");
      expect(outcome.error).not.toBeInstanceOf(GitHubProviderPostEffectError);
      expect((outcome.error as Error).message).toBe(
        "GitHub add issue labels succeeded without an admissible exact response; reconcile before retry",
      );
      expect((outcome.error as Error).message).not.toContain(requestId ?? "missing");
      expect(observed.cancelCalled()).toBe(true);
    }
  });
});

function earlyResponse(input: { status: number; requestId: string | null }) {
  let cancelCalled = false;
  const cancel = () => {
    cancelCalled = true;
    return new Promise<void>(() => {});
  };
  const headers = new Headers({ "content-type": "application/json" });
  if (input.requestId !== null) headers.set("x-github-request-id", input.requestId);
  return {
    response: {
      ok: input.status >= 200 && input.status < 300,
      status: input.status,
      headers,
      body: { cancel },
    } as unknown as Response,
    cancelCalled: () => cancelCalled,
  };
}

async function boundedOutcome(promise: Promise<unknown>) {
  return await Promise.race([
    promise.then(
      (value) => ({ kind: "fulfilled" as const, value, error: null }),
      (error: unknown) => ({ kind: "rejected" as const, value: null, error }),
    ),
    new Promise<{ kind: "timeout"; value: null; error: null }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout", value: null, error: null }), 250);
    }),
  ]);
}

function adapterFor(response: Response): GitHubRestIssueSetWriteAdapter {
  return new GitHubRestIssueSetWriteAdapter({
    tokenProvider: {
      async getInstallationToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-03T11:00:00.000Z",
        };
      },
    },
    fetch: (async () => response) as unknown as typeof fetch,
  });
}

function addLabels(adapter: GitHubRestIssueSetWriteAdapter) {
  return adapter.addIssueLabels({
    repositoryFullName,
    issueNumber,
    labels: ["area:github"],
    idempotencyKey: "early-response-body-settlement",
  });
}
