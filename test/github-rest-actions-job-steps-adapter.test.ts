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

describe("native GitHub delegated Actions workflow-job step reads", () => {
  test("reads bounded ordered steps after exact job and repository admission", async () => {
    const tokens = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokens, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json(workflowJob(), {
        headers: { "x-github-request-id": "ACTIONS:JOB:STEPS" },
      });
    });

    const called = await adapter.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ));

    expect(tokens.requests).toEqual([{
      repositoryFullName,
      permission: { name: "actions", access: "read" },
    }]);
    expect(requestUrl).toBe(
      `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`,
    );
    expect(requestInit?.redirect).toBe("error");
    expect(new Headers(requestInit?.headers).get("authorization"))
      .toBe("Bearer delegated-token");
    expect(called).toEqual({
      providerRequestId: "ACTIONS:JOB:STEPS",
      result: {
        repositoryFullName,
        jobId,
        runId,
        runAttempt: 1,
        headSha: commitSha,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-08-01T14:00:00.000Z",
        completedAt: "2026-08-01T14:08:00.000Z",
        totalCount: 2,
        steps: [
          {
            number: 1,
            name: "Set up job",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-01T14:00:00.000Z",
            completedAt: "2026-08-01T14:01:00.000Z",
          },
          {
            number: 2,
            name: "Run Bun tests",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-01T14:01:00.000Z",
            completedAt: "2026-08-01T14:08:00.000Z",
          },
        ],
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    const result = called.result as { steps: readonly unknown[] };
    expect(Object.isFrozen(result.steps)).toBe(true);
    expect(Object.isFrozen(result.steps[0])).toBe(true);
  });

  test("rejects caller drift before token activity and provider identity drift before publication", async () => {
    const tokens = new RecordingTokenProvider();
    let calls = 0;
    const adapter = createAdapter(tokens, async () => {
      calls += 1;
      return Response.json({
        ...workflowJob(),
        url: `https://api.github.test/repos/teamleaderleo/other/actions/jobs/${jobId}`,
      });
    });

    await expectRejectionCode(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_steps",
        { job_id: String(jobId) },
      )),
      "github_delegated_adapter_invalid_input",
    );
    expect(tokens.requests).toEqual([]);
    expect(calls).toBe(0);

    await expectRejectionCode(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_steps",
        { job_id: jobId },
      )),
      "github_delegated_provider_identity_mismatch",
    );
    expect(tokens.requests).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("rejects duplicate, reordered, and chronologically invalid steps", async () => {
    const duplicate = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        ...workflowJob(),
        steps: [workflowStep(1), workflowStep(1)],
      }));
    await expect(duplicate.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ))).rejects.toThrow("uniquely ordered");

    const chronology = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        ...workflowJob(),
        steps: [{
          ...workflowStep(1),
          started_at: "2026-08-01T14:03:00Z",
          completed_at: "2026-08-01T14:02:00Z",
        }],
      }));
    await expect(chronology.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ))).rejects.toThrow("timestamps were inconsistent");
  });

  test("preserves the landed Actions run reader", async () => {
    const tokens = new RecordingTokenProvider();
    const adapter = createAdapter(tokens, async () => Response.json({
      total_count: 0,
      workflow_runs: [],
    }));
    const called = await adapter.callReadTool(callInput(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha },
    ));
    expect(called.result).toEqual({
      repositoryFullName,
      commitSha,
      totalCount: 0,
      workflowRuns: [],
    });
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
    run_attempt: 1,
    head_sha: commitSha,
    name: "test",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T14:00:00Z",
    completed_at: "2026-08-01T14:08:00Z",
    url: `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`,
    run_url: `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs/${runId}`,
    steps: [workflowStep(1), workflowStep(2)],
  };
}

function workflowStep(number: number) {
  return {
    number,
    name: number === 1 ? "Set up job" : "Run Bun tests",
    status: "completed",
    conclusion: "success",
    started_at: number === 1
      ? "2026-08-01T14:00:00Z"
      : "2026-08-01T14:01:00Z",
    completed_at: number === 1
      ? "2026-08-01T14:01:00Z"
      : "2026-08-01T14:08:00Z",
  };
}
