import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestIssueSetWriteAdapter } from "../src/github-rest-issue-set-write-adapter.ts";
import { GitHubRestIssueWriteAdapter } from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const requestId = "WRITE:BOUNDED:1";
const secret = `github_pat_${"s".repeat(32)}`;

class StaticTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "installation-token",
      expiresAt: "2026-08-03T03:00:00.000Z",
    };
  }
}

describe("GitHub issue-write provider response boundaries", () => {
  test("retains request identity when a successful create response exceeds the streamed byte ceiling", async () => {
    const state = { pulls: 0, cancellations: 0 };
    const adapter = createWriteAdapter(async () => trackedResponse(
      [new Uint8Array(300_000), new Uint8Array(300_000), new TextEncoder().encode(secret)],
      state,
      { "x-github-request-id": requestId },
      201,
    ));

    const error = await capturedPostEffect(() => adapter.createIssue({
      repositoryFullName,
      title: "Bound provider response",
      body: null,
      labels: [],
      assignees: [],
    }));

    expect(error.providerRequestId).toBe(requestId);
    expect(state.pulls).toBe(2);
    expect(state.cancellations).toBe(1);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("retains request identity for malformed length and invalid JSON on set mutations", async () => {
    for (const response of [
      () => trackedResponse(
        [new TextEncoder().encode("[]")],
        { pulls: 0, cancellations: 0 },
        {
          "content-length": "2x",
          "x-github-request-id": requestId,
        },
      ),
      () => new Response("not-json", {
        status: 200,
        headers: {
          "content-length": "8",
          "x-github-request-id": requestId,
        },
      }),
    ]) {
      const adapter = createSetWriteAdapter(async () => response());
      const error = await capturedPostEffect(() => adapter.addIssueLabels({
        repositoryFullName,
        issueNumber: 42,
        labels: ["triage"],
      }));
      expect(error.providerRequestId).toBe(requestId);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  test("retains request identity when a successful mutation body fails endpoint schema admission", async () => {
    const adapter = createSetWriteAdapter(async () => Response.json(
      { unexpected: true },
      { headers: { "x-github-request-id": requestId } },
    ));

    const error = await capturedPostEffect(() => adapter.addIssueLabels({
      repositoryFullName,
      issueNumber: 42,
      labels: ["triage"],
    }));

    expect(error.providerRequestId).toBe(requestId);
  });

  test("cancels deterministic rejected-status prose without reading or echoing it", async () => {
    const state = { pulls: 0, cancellations: 0 };
    const adapter = createWriteAdapter(async () => trackedResponse(
      [new TextEncoder().encode(`private provider detail ${secret}`)],
      state,
      { "x-github-request-id": requestId },
      422,
    ));

    try {
      await adapter.createIssue({
        repositoryFullName,
        title: "Rejected provider response",
        body: null,
        labels: [],
        assignees: [],
      });
      throw new Error("Expected provider rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubProviderRejectedError);
      expect((error as GitHubProviderRejectedError).code)
        .toBe("github_provider_request_rejected");
      expect((error as Error).message).toBe("GitHub rejected create issue");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(state.pulls).toBe(0);
    expect(state.cancellations).toBe(1);
  });

  test("keeps attribution null when fetch fails before a provider response exists", async () => {
    const adapter = createWriteAdapter(async () => {
      throw new Error(`private transport failure ${secret}`);
    });

    try {
      await adapter.createIssue({
        repositoryFullName,
        title: "Transport ambiguity",
        body: null,
        labels: [],
        assignees: [],
      });
      throw new Error("Expected transport ambiguity");
    } catch (error) {
      expect(error).not.toBeInstanceOf(GitHubProviderPostEffectError);
      expect((error as Error).message)
        .toBe("GitHub create issue outcome requires reconciliation");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

function createWriteAdapter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestIssueWriteAdapter {
  return new GitHubRestIssueWriteAdapter({
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

function createSetWriteAdapter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestIssueSetWriteAdapter {
  return new GitHubRestIssueSetWriteAdapter({
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

async function capturedPostEffect(
  operation: () => Promise<unknown>,
): Promise<GitHubProviderPostEffectError> {
  try {
    await operation();
    throw new Error("Expected post-effect ambiguity");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
    return error as GitHubProviderPostEffectError;
  }
}

function trackedResponse(
  chunks: readonly Uint8Array[],
  state: { pulls: number; cancellations: number },
  headers: Record<string, string>,
  status = 200,
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancellations += 1;
    },
  }), { status, headers });
}
