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

describe("GitHub Actions job provider request identity controls", () => {
  test("rejects step metadata when the job response lacks provider identity", async () => {
    const adapter = createAdapter(async (input) => {
      if (String(input) === jobUrl) {
        return Response.json(workflowJob());
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });

    await expectInvalidProviderResponse(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_steps",
        { job_id: jobId },
      )),
    );
  });

  test("rejects logs when the authenticated redirect lacks provider identity", async () => {
    const adapter = createAdapter(async (input) => {
      const url = String(input);
      if (url === jobUrl) {
        return Response.json(workflowJob(), {
          headers: { "x-github-request-id": "ACTIONS:JOB:METADATA" },
        });
      }
      if (url === logsUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: downloadUrl },
        });
      }
      if (url === downloadUrl) {
        return new Response("bounded log text", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });

    await expectInvalidProviderResponse(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_logs",
        { job_id: jobId },
      )),
    );
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
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestActionsJobDetailAdapter {
  return new GitHubRestActionsJobDetailAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new RecordingTokenProvider(),
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

async function expectInvalidProviderResponse(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected missing provider request identity to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    expect((error as GitHubProviderRejectedError).code)
      .toBe("github_delegated_provider_invalid_response");
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
    steps: [{
      number: 1,
      name: "Run tests",
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-01T14:00:00Z",
      completed_at: "2026-08-01T14:08:00Z",
    }],
  };
}
