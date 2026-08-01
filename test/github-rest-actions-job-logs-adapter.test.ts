import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestActionsJobDetailAdapter } from "../src/github-rest-actions-job-detail-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "d".repeat(40);
const runId = 30706199155;
const jobId = 91345873454;
const logEndpoint =
  `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}/logs`;
const downloadUrl = "https://results.github.test/job-log.txt?signature=bounded";

describe("native GitHub delegated Actions job-log reads", () => {
  test("verifies job identity, follows one controlled redirect without forwarding credentials, and retains bounded text", async () => {
    const tokens = new RecordingTokenProvider();
    const calls: Array<{
      url: string;
      redirect: RequestRedirect | undefined;
      authorization: string | null;
    }> = [];
    const adapter = createAdapter(tokens, async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        redirect: init?.redirect,
        authorization: headers.get("authorization"),
      });
      if (url.endsWith(`/actions/jobs/${jobId}`)) {
        return Response.json(workflowJob(), {
          headers: { "x-github-request-id": "ACTIONS:JOB:1" },
        });
      }
      if (url === logEndpoint) {
        return new Response(null, {
          status: 302,
          headers: { location: downloadUrl },
        });
      }
      if (url === downloadUrl) {
        return new Response(
          "setup complete\r\nexact revision passed\r\n",
          {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "content-disposition": `attachment; filename="job-${jobId}.txt"`,
              "x-github-request-id": "ACTIONS:LOG:1",
            },
          },
        );
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });

    const called = await adapter.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ));

    expect(tokens.requests).toEqual([{
      repositoryFullName,
      permission: { name: "actions", access: "read" },
    }]);
    expect(calls).toEqual([
      {
        url: `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`,
        redirect: "error",
        authorization: "Bearer delegated-token",
      },
      {
        url: logEndpoint,
        redirect: "manual",
        authorization: "Bearer delegated-token",
      },
      {
        url: downloadUrl,
        redirect: "error",
        authorization: null,
      },
    ]);
    expect(called).toEqual({
      providerRequestId: "ACTIONS:LOG:1",
      result: {
        repositoryFullName,
        jobId,
        runId,
        runAttempt: 2,
        headSha: commitSha,
        byteLength: 37,
        lineCount: 2,
        truncated: false,
        content: "setup complete\nexact revision passed\n",
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    const serialized = JSON.stringify(called);
    expect(serialized).not.toContain(downloadUrl);
    expect(serialized).not.toContain("delegated-token");
    expect(serialized).not.toContain(credentialRef);
  });

  test("accepts bounded gzip text and rejects unsupported compression", async () => {
    const gzip = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) {
        return Response.json(workflowJob());
      }
      return new Response(gzipSync("compressed line\n"), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
        },
      });
    });
    const called = await gzip.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ));
    expect(called.result).toMatchObject({
      content: "compressed line\n",
      lineCount: 1,
      truncated: false,
    });

    const unsupported = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) {
        return Response.json(workflowJob());
      }
      return new Response("encoded", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-encoding": "br",
        },
      });
    });
    await expect(unsupported.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ))).rejects.toThrow("unsupported log compression");
  });

  test("fails closed on unsafe redirects, traversal filenames, secret-like content, invalid UTF-8, and oversized lines", async () => {
    const unsafeRedirect = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) return Response.json(workflowJob());
      return new Response(null, {
        status: 302,
        headers: { location: "http://results.github.test/log.txt" },
      });
    });
    await expect(unsafeRedirect.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ))).rejects.toThrow("log redirect was invalid");

    const traversal = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) return Response.json(workflowJob());
      return new Response("line\n", {
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=../secret.txt",
        },
      });
    });
    await expect(traversal.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ))).rejects.toThrow("archive boundary");

    const secret = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) return Response.json(workflowJob());
      return new Response(`token github_pat_${"x".repeat(24)}\n`, {
        headers: { "content-type": "text/plain" },
      });
    });
    await expect(secret.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ))).rejects.toThrow("credential-shaped content");

    const invalidUtf8 = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) return Response.json(workflowJob());
      return new Response(Uint8Array.from([0xc3, 0x28]), {
        headers: { "content-type": "application/octet-stream" },
      });
    });
    await expect(invalidUtf8.callReadTool(callInput(
      "fetch_workflow_job_logs",
      { job_id: jobId },
    ))).rejects.toThrow("not valid UTF-8");

    const longLine = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      if (url.endsWith(`/actions/jobs/${jobId}`)) return Response.json(workflowJob());
      return new Response(`${"x".repeat(4_097)}\n`, {
        headers: { "content-type": "text/plain" },
      });
    });
    await expectRejectionCode(
      longLine.callReadTool(callInput(
        "fetch_workflow_job_logs",
        { job_id: jobId },
      )),
      "github_delegated_provider_result_too_large",
    );
  });

  test("rejects malformed caller input before token or provider activity", async () => {
    const tokens = new RecordingTokenProvider();
    let calls = 0;
    const adapter = createAdapter(tokens, async () => {
      calls += 1;
      return Response.json(workflowJob());
    });
    await expectRejectionCode(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_logs",
        { job_id: 0 },
      )),
      "github_delegated_adapter_invalid_input",
    );
    expect(tokens.requests).toEqual([]);
    expect(calls).toBe(0);
  });
});

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-08-02T00:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestActionsJobDetailAdapter {
  return new GitHubRestActionsJobDetailAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

function callInput(tool: string, argumentsValue: Record<string, unknown>) {
  return {
    tool,
    arguments: Object.freeze(argumentsValue),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

async function expectRejectionCode(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected rejection code ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    expect((error as GitHubProviderRejectedError).code).toBe(expectedCode);
  }
}

function workflowJob() {
  return {
    id: jobId,
    run_id: runId,
    run_attempt: 2,
    head_sha: commitSha,
    name: "serial-full",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T22:30:00Z",
    completed_at: "2026-08-01T22:40:00Z",
    url: `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`,
    steps: [{
      number: 1,
      name: "Run exact revision checks",
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-01T22:30:00Z",
      completed_at: "2026-08-01T22:40:00Z",
    }],
  };
}
