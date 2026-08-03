import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;

describe("GitHub set-write stream work admission", () => {
  test("stops and cancels excessive zero-byte chunk work", async () => {
    const totalChunks = 10_000;
    let pulls = 0;
    let cancelled = false;
    const response = injectedResponse({
      async read() {
        if (pulls >= totalChunks) return { done: true, value: undefined };
        pulls += 1;
        return { done: false, value: new Uint8Array(0) };
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async () => response) as unknown as typeof fetch,
    });

    await expectPostEffect(adapter.addIssueLabels({
      repositoryFullName,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "bound-zero-byte-chunk-work",
    }));

    expect(pulls).toBeLessThan(totalChunks);
    expect(cancelled).toBe(true);
  });

  test("does not await an attacker-controlled cancellation promise", async () => {
    const totalChunks = 10_000;
    let pulls = 0;
    let cancelCalled = false;
    const response = injectedResponse({
      async read() {
        if (pulls >= totalChunks) return { done: true, value: undefined };
        pulls += 1;
        if (pulls % 64 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return { done: false, value: new Uint8Array(0) };
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
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
        idempotencyKey: "nonblocking-zero-byte-chunk-cancellation",
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
      throw new Error("Stream-work cancellation did not settle through fixed ambiguity");
    }
    expectPostEffectError(outcome.error);
    expect(cancelCalled).toBe(true);
    expect(pulls).toBeLessThan(totalChunks);
  });
});

interface InjectedReaderInput {
  read: () => Promise<
    | { done: false; value: Uint8Array }
    | { done: true; value: undefined }
  >;
  cancel: () => Promise<void> | void;
}

function injectedResponse(input: InjectedReaderInput): Response {
  const cancel = () => input.cancel();
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
      "x-github-request-id": "REQ-CHUNK-WORK",
    }),
    body: {
      getReader() {
        return {
          read: input.read,
          cancel,
          releaseLock() {},
        };
      },
      cancel,
    },
  } as unknown as Response;
}

async function expectPostEffect(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected excessive chunk work to require reconciliation");
  } catch (error) {
    expectPostEffectError(error);
  }
}

function expectPostEffectError(error: unknown): void {
  expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
  expect(error).toMatchObject({
    providerRequestId: "REQ-CHUNK-WORK",
    message:
      "GitHub provider effect requires reconciliation after verification failed",
  });
}

function tokenProvider() {
  return {
    async getInstallationToken() {
      return {
        token: "installation-token",
        expiresAt: "2026-08-03T10:00:00.000Z",
      };
    },
  };
}
