import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const defaultApiBaseUrl = "https://api.github.com";

describe("shared GitHub issue-write response admission", () => {
  test("admits a decoded compressed response without comparing decoded bytes to encoded length", async () => {
    const payload = issuePayload(defaultApiBaseUrl);
    const response = jsonStreamResponse(payload, {
      "content-encoding": "gzip",
      "content-length": "17",
      "x-github-request-id": "REQ-COMPRESSED",
    });
    const adapter = adapterFor(response);

    const result = await createIssue(adapter);

    expect(result.providerRequestId).toBe("REQ-COMPRESSED");
    expect(result.issue).toMatchObject({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: issueNumber,
    });
  });

  test("retains a known request ID for overflow, invalid JSON, and invalid schema", async () => {
    const cases = [
      streamResponse([
        new Uint8Array(300 * 1024),
        new Uint8Array(300 * 1024),
      ], { "x-github-request-id": "REQ-OVERFLOW" }),
      streamResponse([
        new TextEncoder().encode("not-json"),
      ], { "x-github-request-id": "REQ-INVALID-JSON" }),
      jsonStreamResponse(
        { ...issuePayload(defaultApiBaseUrl), repository_url: "not a URL" },
        { "x-github-request-id": "REQ-INVALID-SCHEMA" },
      ),
    ];
    const expected = ["REQ-OVERFLOW", "REQ-INVALID-JSON", "REQ-INVALID-SCHEMA"];

    for (let index = 0; index < cases.length; index += 1) {
      await expectPostEffect(createIssue(adapterFor(cases[index]!)), expected[index]!);
    }
  });

  test("keeps attribution absent when a successful response has no admissible request ID", async () => {
    const response = jsonStreamResponse(issuePayload(defaultApiBaseUrl), {});

    try {
      await createIssue(adapterFor(response));
      throw new Error("Expected missing provider request identity to fail");
    } catch (error) {
      expect(error).not.toBeInstanceOf(GitHubProviderPostEffectError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "GitHub create issue succeeded without an admissible exact response; reconcile before retry",
      );
    }
  });

  test("disposes deterministic provider rejection bodies without reading provider prose", async () => {
    let readerRequested = false;
    let cancelled = false;
    const response = {
      ok: false,
      status: 422,
      headers: new Headers({ "x-github-request-id": "REQ-REJECTED" }),
      body: {
        getReader() {
          readerRequested = true;
          throw new Error("rejected provider prose should not be read");
        },
        cancel() {
          cancelled = true;
        },
      },
    } as unknown as Response;

    try {
      await createIssue(adapterFor(response));
      throw new Error("Expected deterministic provider rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubProviderRejectedError);
      expect((error as Error).message).toBe("GitHub rejected create issue");
      expect((error as Error).message).not.toContain("provider prose");
    }
    expect(readerRequested).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("preserves configured API-host binding", async () => {
    const apiBaseUrl = "https://api.github.example.test/api/v3";
    const response = jsonStreamResponse(issuePayload(apiBaseUrl), {
      "x-github-request-id": "REQ-ENTERPRISE",
    });
    const adapter = adapterFor(response, apiBaseUrl);

    const result = await createIssue(adapter);

    expect(result.providerRequestId).toBe("REQ-ENTERPRISE");
    expect(result.issue.number).toBe(issueNumber);
  });

  test("rejects malformed, credentialed, queried, and fragmented provider URLs after effect", async () => {
    const invalidUrls = [
      "not a URL",
      "https://user:pass@api.github.com/repos/teamleaderleo/stensibly",
      "https://api.github.com/repos/teamleaderleo/stensibly?secret=1",
      "https://api.github.com/repos/teamleaderleo/stensibly#fragment",
    ];

    for (const [index, repositoryUrl] of invalidUrls.entries()) {
      const requestId = `REQ-INVALID-URL-${index}`;
      const response = jsonStreamResponse(
        { ...issuePayload(defaultApiBaseUrl), repository_url: repositoryUrl },
        { "x-github-request-id": requestId },
      );
      await expectPostEffect(createIssue(adapterFor(response)), requestId);
    }
  });

  test("preserves request identity for malformed comment URLs", async () => {
    const response = jsonStreamResponse({
      id: 9001,
      issue_url: "https://api.github.com/repos/teamleaderleo/stensibly/issues/525?wrong=1",
      html_url: "https://github.com/teamleaderleo/stensibly/issues/525#issuecomment-9001",
      body: "comment body",
      created_at: "2026-08-03T09:00:00.000Z",
      updated_at: "2026-08-03T09:00:00.000Z",
    }, { "x-github-request-id": "REQ-COMMENT-URL" });

    await expectPostEffect(
      adapterFor(response).addIssueComment({
        repositoryFullName,
        issueNumber,
        body: "comment body",
        idempotencyKey: "shared-response-comment-url",
      }),
      "REQ-COMMENT-URL",
    );
  });
});

function adapterFor(
  response: Response,
  apiBaseUrl = defaultApiBaseUrl,
): GitHubRestIssueWriteAdapter {
  return new GitHubRestIssueWriteAdapter({
    tokenProvider: tokenProvider(),
    apiBaseUrl,
    fetch: (async () => response) as unknown as typeof fetch,
  });
}

function createIssue(adapter: GitHubRestIssueWriteAdapter) {
  return adapter.createIssue({
    repositoryFullName,
    title: "Shared bounded response",
    body: "Body",
    labels: [],
    assignees: [],
    idempotencyKey: "shared-response-create",
  });
}

async function expectPostEffect(
  promise: Promise<unknown>,
  providerRequestId: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected post-effect reconciliation");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
    expect(error).toMatchObject({
      providerRequestId,
      message:
        "GitHub provider effect requires reconciliation after verification failed",
    });
  }
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

function issuePayload(apiBaseUrl: string) {
  return {
    repository_url: `${apiBaseUrl}/repos/${repositoryFullName}`,
    number: issueNumber,
    node_id: "I_kwDOSharedResponse",
    title: "Shared bounded response",
    body: "Body",
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    milestone: null,
    created_at: "2026-08-03T09:00:00.000Z",
    updated_at: "2026-08-03T09:00:00.000Z",
  };
}

function jsonStreamResponse(
  value: unknown,
  headers: Record<string, string>,
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return streamResponse([
    bytes.slice(0, Math.floor(bytes.byteLength / 2)),
    bytes.slice(Math.floor(bytes.byteLength / 2)),
  ], headers);
}

function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string>,
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  }), {
    status: 201,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}
