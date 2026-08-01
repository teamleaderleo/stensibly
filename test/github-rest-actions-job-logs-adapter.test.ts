import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import {
  GitHubRestActionsJobDetailAdapter,
} from "../src/github-rest-actions-job-detail-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "d".repeat(40);
const runId = 30706199155;
const jobId = 91385646830;
const jobUrl =
  `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`;
const logsUrl = `${jobUrl}/logs`;
const downloadUrl =
  "https://results-receiver.actions.githubusercontent.com/job-logs/91385646830?sig=bounded";

describe("native GitHub delegated Actions workflow-job log reads", () => {
  test("downloads one bounded UTF-8 text log without forwarding installation authority", async () => {
    const tokens = new RecordingTokenProvider();
    const calls: Array<{
      url: string;
      redirect: RequestRedirect | undefined;
      authorization: string | null;
      accept: string | null;
    }> = [];
    const logText = "2026-08-01T14:01:00Z Run Bun tests\nAll checks passed";
    const adapter = createAdapter(tokens, async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        redirect: init?.redirect,
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      });
      if (url === jobUrl) return Response.json(workflowJob());
      if (url === logsUrl) {
        return new Response(null, {
          status: 302,
          headers: {
            location: downloadUrl,
            "x-github-request-id": "ACTIONS:JOB:LOGS",
          },
        });
      }
      if (url === downloadUrl) {
        return new Response(logText, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
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
        url: jobUrl,
        redirect: "error",
        authorization: "Bearer delegated-token",
        accept: "application/vnd.github+json",
      },
      {
        url: logsUrl,
        redirect: "manual",
        authorization: "Bearer delegated-token",
        accept: "application/vnd.github+json",
      },
      {
        url: downloadUrl,
        redirect: "error",
        authorization: null,
        accept: "text/plain",
      },
    ]);
    expect(called).toEqual({
      providerRequestId: "ACTIONS:JOB:LOGS",
      result: {
        repositoryFullName,
        jobId,
        runId,
        runAttempt: 1,
        headSha: commitSha,
        byteCount: Buffer.byteLength(logText, "utf8"),
        lineCount: 2,
        text: logText,
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("rejects an untrusted redirect before the credential-free download", async () => {
    const tokens = new RecordingTokenProvider();
    let calls = 0;
    const adapter = createAdapter(tokens, async (input) => {
      calls += 1;
      if (String(input) === jobUrl) return Response.json(workflowJob());
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/private/job.log" },
      });
    });

    await expectRejectionCode(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_logs",
        { job_id: jobId },
      )),
      "github_delegated_provider_invalid_response",
    );
    expect(calls).toBe(2);
  });

  test("rejects compression, binary controls, credential-shaped content, and overflow", async () => {
    const scenarios: Array<{
      headers: Record<string, string>;
      body: string;
      code: string;
    }> = [
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-encoding": "gzip",
        },
        body: "compressed",
        code: "github_delegated_provider_invalid_response",
      },
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "safe\u0000binary",
        code: "github_delegated_provider_invalid_response",
      },
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
        code: "github_delegated_provider_invalid_response",
      },
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "x".repeat(65),
        code: "github_delegated_provider_result_too_large",
      },
    ];
    for (const scenario of scenarios) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        sequenceFetch(scenario.body, scenario.headers),
        64,
      );
      await expectRejectionCode(
        adapter.callReadTool(callInput(
          "fetch_workflow_job_logs",
          { job_id: jobId },
        )),
        scenario.code,
      );
    }
  });

  test("returns fixed diagnostics when download failures contain private provider prose", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async (input) => {
        if (String(input) === jobUrl) return Response.json(workflowJob());
        if (String(input) === logsUrl) {
          return new Response(null, {
            status: 302,
            headers: { location: downloadUrl },
          });
        }
        throw new Error(`private provider failure ${secret}`);
      },
    );

    try {
      await adapter.callReadTool(callInput(
        "fetch_workflow_job_logs",
        { job_id: jobId },
      ));
      throw new Error("Expected log request failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubProviderRejectedError);
      expect((error as Error).message)
        .toBe("GitHub delegated log request failed before a response was available");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
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
      expiresAt: "2026-08-01T16:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  maximumLogBytes?: number,
): GitHubRestActionsJobDetailAdapter {
  return new GitHubRestActionsJobDetailAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
    ...(maximumLogBytes === undefined ? {} : { maximumLogBytes }),
  });
}

function sequenceFetch(
  body: string,
  headers: Record<string, string>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    if (url === jobUrl) return Response.json(workflowJob());
    if (url === logsUrl) {
      return new Response(null, {
        status: 302,
        headers: { location: downloadUrl },
      });
    }
    if (url === downloadUrl) {
      return new Response(body, { status: 200, headers });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };
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
    run_attempt: 1,
    head_sha: commitSha,
    name: "test",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T14:00:00Z",
    completed_at: "2026-08-01T14:08:00Z",
    url: jobUrl,
    run_url:
      `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs/${runId}`,
    steps: [],
  };
}
