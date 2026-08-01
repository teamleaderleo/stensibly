import { describe, expect, test } from "bun:test";
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

describe("native GitHub delegated Actions job-step reads", () => {
  test("reads one exact job with actions-only authority and frozen ordered steps", async () => {
    const tokens = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokens, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json(workflowJob(), {
        headers: { "x-github-request-id": "ACTIONS:STEPS:1" },
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
      providerRequestId: "ACTIONS:STEPS:1",
      result: {
        repositoryFullName,
        jobId,
        runId,
        runAttempt: 2,
        headSha: commitSha,
        name: "serial-full",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-08-01T22:30:00.000Z",
        completedAt: "2026-08-01T22:40:00.000Z",
        steps: [
          {
            number: 1,
            name: "Set up job",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-01T22:30:00.000Z",
            completedAt: "2026-08-01T22:30:10.000Z",
          },
          {
            number: 2,
            name: "Run exact revision checks",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-01T22:30:10.000Z",
            completedAt: "2026-08-01T22:39:50.000Z",
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

  test("rejects malformed caller identity before token or provider activity", async () => {
    const tokens = new RecordingTokenProvider();
    let calls = 0;
    const adapter = createAdapter(tokens, async () => {
      calls += 1;
      return Response.json(workflowJob());
    });

    await expectRejectionCode(
      adapter.callReadTool(callInput(
        "fetch_workflow_job_steps",
        { job_id: String(jobId) },
      )),
      "github_delegated_adapter_invalid_input",
    );
    await expect(adapter.callReadTool({
      ...callInput("fetch_workflow_job_steps", { job_id: jobId }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    expect(tokens.requests).toEqual([]);
    expect(calls).toBe(0);
  });

  test("fails closed on repository drift, job drift, unordered steps, and unsafe retained text", async () => {
    const wrongRepository = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        ...workflowJob(),
        url: `https://api.github.test/repos/teamleaderleo/other/actions/jobs/${jobId}`,
      }));
    await expect(wrongRepository.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ))).rejects.toThrow("accepted repository");

    const wrongJob = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({ ...workflowJob(), id: jobId + 1 }));
    await expect(wrongJob.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ))).rejects.toThrow("requested job");

    const unordered = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        ...workflowJob(),
        steps: [workflowStep(2), workflowStep(1)],
      }));
    await expect(unordered.callReadTool(callInput(
      "fetch_workflow_job_steps",
      { job_id: jobId },
    ))).rejects.toThrow("strictly ordered");

    const secretText = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        ...workflowJob(),
        steps: [{
          ...workflowStep(1),
          name: `Publish github_pat_${"x".repeat(24)}`,
        }],
      }));
    await expectRejectionCode(
      secretText.callReadTool(callInput(
        "fetch_workflow_job_steps",
        { job_id: jobId },
      )),
      "github_delegated_provider_invalid_response",
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
    steps: [workflowStep(1), {
      ...workflowStep(2),
      name: "Run exact revision checks",
      started_at: "2026-08-01T22:30:10Z",
      completed_at: "2026-08-01T22:39:50Z",
    }],
  };
}

function workflowStep(number: number) {
  return {
    number,
    name: "Set up job",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T22:30:00Z",
    completed_at: "2026-08-01T22:30:10Z",
  };
}
