import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const maximumResponseBytes = 512 * 1024;

describe("GitHub set-write streamed response ownership", () => {
  test("cancels bodies rejected by declared-length admission", async () => {
    for (const contentLength of [
      "not-a-number",
      String(maximumResponseBytes + 1),
    ]) {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("[]"));
        },
        cancel() {
          cancelled = true;
        },
      }), {
        status: 200,
        headers: {
          "content-length": contentLength,
          "content-type": "application/json",
          "x-github-request-id": "REQ-DECLARED-LENGTH",
        },
      });

      await expectPostEffect(
        addLabels(adapterForMutation(response)),
        "REQ-DECLARED-LENGTH",
      );
      expect(cancelled).toBe(true);
    }
  });

  test("detaches each delivered chunk before a producer reuses its buffer", async () => {
    const first = new TextEncoder().encode('[{"name":"ar');
    const second = new TextEncoder().encode('ea:github"}]');
    expect(first.byteLength).toBe(second.byteLength);

    const shared = new Uint8Array(first.byteLength);
    let pull = 0;
    const mutation = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pull === 0) {
          shared.set(first);
          pull += 1;
          controller.enqueue(shared);
          return;
        }
        if (pull === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          shared.set(second);
          pull += 1;
          controller.enqueue(shared);
          return;
        }
        controller.close();
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-github-request-id": "REQ-REUSED-BUFFER",
      },
    });

    let calls = 0;
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
          return mutation;
        }
        if (method === "GET" && url.endsWith(`/issues/${issueNumber}`)) {
          return Response.json(issuePayload(), {
            headers: { "x-github-request-id": "REQ-REUSED-BUFFER-READBACK" },
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as typeof fetch,
    });

    const result = await addLabels(adapter);

    expect(result.providerRequestId).toBe("REQ-REUSED-BUFFER");
    expect(result.issue).toMatchObject({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: issueNumber,
      labels: ["area:github"],
    });
    expect(calls).toBe(2);
    expect(pull).toBe(2);
  });

  test("retains only tiny view bytes from a large backing buffer", async () => {
    const json = new TextEncoder().encode('[{"name":"area:github"}]');
    const backing = new Uint8Array(8 * 1024 * 1024);
    backing.set(json, 1024);
    const view = new Uint8Array(backing.buffer, 1024, json.byteLength);
    const mutation = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(view);
        controller.close();
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-github-request-id": "REQ-TINY-VIEW",
      },
    });

    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") return mutation;
        return Response.json(issuePayload(), {
          headers: { "x-github-request-id": "REQ-TINY-VIEW-READBACK" },
        });
      }) as typeof fetch,
    });

    const result = await addLabels(adapter);
    expect(result.providerRequestId).toBe("REQ-TINY-VIEW");
    expect(result.issue.labels).toEqual(["area:github"]);
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

function adapterForMutation(response: Response): GitHubRestIssueSetWriteAdapter {
  let used = false;
  return new GitHubRestIssueSetWriteAdapter({
    tokenProvider: tokenProvider(),
    fetch: (async () => {
      if (used) {
        return Response.json({ message: "unexpected readback" }, { status: 500 });
      }
      used = true;
      return response;
    }) as typeof fetch,
  });
}

function addLabels(adapter: GitHubRestIssueSetWriteAdapter) {
  return adapter.addIssueLabels({
    repositoryFullName,
    issueNumber,
    labels: ["area:github"],
    idempotencyKey: "stream-ownership-response",
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

function issuePayload() {
  return {
    repository_url: `https://api.github.com/repos/${repositoryFullName}`,
    number: issueNumber,
    node_id: "I_kwDOSetWriteStreamOwnership",
    title: "Detach streamed GitHub set-write response chunks",
    body: null,
    state: "open",
    state_reason: null,
    labels: [{ name: "area:github" }],
    assignees: [],
    milestone: null,
    created_at: "2026-08-03T08:20:00.000Z",
    updated_at: "2026-08-03T08:21:00.000Z",
  };
}
