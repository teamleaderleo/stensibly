import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const maximumResponseBytes = 512 * 1024;

describe("GitHub set-write streamed response bounds", () => {
  test("rejects malformed Content-Length while retaining request identity", async () => {
    const response = new Response("[]", {
      status: 200,
      headers: {
        "content-length": "not-a-number",
        "x-github-request-id": "REQ-MALFORMED-LENGTH",
      },
    });

    await expectPostEffect(
      addLabels(adapterFor(response)),
      "REQ-MALFORMED-LENGTH",
    );
  });

  test("cancels an unbounded body without Content-Length", async () => {
    const observed = streamResponse([
      new Uint8Array(300 * 1024).fill(0x61),
      new Uint8Array(300 * 1024).fill(0x62),
    ]);

    await expectPostEffect(
      addLabels(adapterFor(observed.response)),
      "REQ-STREAM-BOUND",
    );
    expect(observed.cancelled()).toBe(true);
    expect(observed.pulls()).toBe(2);
  });

  test("enforces the byte limit when Content-Length is understated", async () => {
    const observed = streamResponse([
      new Uint8Array(maximumResponseBytes).fill(0x61),
      new Uint8Array([0x62]),
    ], { "content-length": "1" });

    await expectPostEffect(
      addLabels(adapterFor(observed.response)),
      "REQ-STREAM-BOUND",
    );
    expect(observed.cancelled()).toBe(true);
    expect(observed.pulls()).toBe(2);
  });

  test("rejects invalid UTF-8 while retaining request identity", async () => {
    const observed = streamResponse([new Uint8Array([0xc3, 0x28])]);

    await expectPostEffect(
      addLabels(adapterFor(observed.response)),
      "REQ-STREAM-BOUND",
    );
    expect(observed.cancelled()).toBe(false);
  });

  test("admits a valid chunked response and completes exact readback", async () => {
    const bytes = new TextEncoder().encode('[{"name":"area:github"}]');
    const mutation = streamResponse([
      bytes.slice(0, 7),
      bytes.slice(7, 18),
      bytes.slice(18),
    ]);
    let calls = 0;
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
          return mutation.response;
        }
        if (method === "GET" && url.endsWith(`/issues/${issueNumber}`)) {
          return Response.json(issuePayload(), {
            headers: { "x-github-request-id": "REQ-STREAM-READBACK" },
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as typeof fetch,
    });

    const result = await addLabels(adapter);

    expect(result.providerRequestId).toBe("REQ-STREAM-BOUND");
    expect(result.issue).toMatchObject({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: issueNumber,
      labels: ["area:github"],
    });
    expect(calls).toBe(2);
    expect(mutation.pulls()).toBe(3);
    expect(mutation.cancelled()).toBe(false);
  });
});

async function expectPostEffect(
  promise: Promise<unknown>,
  providerRequestId: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected the GitHub mutation response to require reconciliation");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
    expect(error).toMatchObject({
      providerRequestId,
      message:
        "GitHub provider effect requires reconciliation after verification failed",
    });
  }
}

function adapterFor(response: Response): GitHubRestIssueSetWriteAdapter {
  let used = false;
  return new GitHubRestIssueSetWriteAdapter({
    tokenProvider: tokenProvider(),
    fetch: (async () => {
      if (used) {
        return Response.json({ message: "unexpected readback" }, { status: 500 });
      }
      used = true;
      return response;
    }) as unknown as typeof fetch,
  });
}

function addLabels(adapter: GitHubRestIssueSetWriteAdapter) {
  return adapter.addIssueLabels({
    repositoryFullName,
    issueNumber,
    labels: ["area:github"],
    idempotencyKey: "stream-bound-response",
  });
}

function tokenProvider() {
  return {
    async getInstallationToken() {
      return {
        token: "installation-token",
        expiresAt: "2026-08-03T02:00:00.000Z",
      };
    },
  };
}

function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
) {
  let index = 0;
  let wasCancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      wasCancelled = true;
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": "REQ-STREAM-BOUND",
      ...headers,
    },
  });
  return {
    response,
    pulls: () => index,
    cancelled: () => wasCancelled,
  };
}

function issuePayload() {
  return {
    repository_url: `https://api.github.com/repos/${repositoryFullName}`,
    number: issueNumber,
    node_id: "I_kwDOSetWriteStreamBound",
    title: "Bound streamed GitHub set-write responses",
    body: null,
    state: "open",
    state_reason: null,
    labels: [{ name: "area:github" }],
    assignees: [],
    milestone: null,
    created_at: "2026-08-02T18:00:00.000Z",
    updated_at: "2026-08-02T18:10:00.000Z",
  };
}
