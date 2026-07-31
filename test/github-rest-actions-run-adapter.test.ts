import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestActionsRunAdapter } from "../src/github-rest-actions-run-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "d".repeat(40);
const runId = 30660326044;

describe("native GitHub delegated Actions run and job reads", () => {
  test("reads workflow runs for one exact commit with actions-only authority", async () => {
    const tokens = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokens, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        total_count: 1,
        workflow_runs: [workflowRun()],
      }, { headers: { "x-github-request-id": "ACTIONS:RUNS" } });
    });

    const called = await adapter.callReadTool(callInput(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha.toUpperCase() },
    ));

    expect(tokens.requests).toEqual([{
      repositoryFullName,
      permission: { name: "actions", access: "read" },
    }]);
    expect(requestUrl).toBe(
      `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs?head_sha=${commitSha}&per_page=50&page=1`,
    );
    expect(requestInit?.redirect).toBe("error");
    expect(new Headers(requestInit?.headers).get("authorization"))
      .toBe("Bearer delegated-token");
    expect(called).toEqual({
      providerRequestId: "ACTIONS:RUNS",
      result: {
        repositoryFullName,
        commitSha,
        totalCount: 1,
        workflowRuns: [{
          id: runId,
          attempt: 1,
          workflowId: 123456,
          workflowName: "Canonical CI",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          headSha: commitSha,
          createdAt: "2026-07-31T19:40:00.000Z",
          updatedAt: "2026-07-31T19:48:00.000Z",
          runStartedAt: "2026-07-31T19:41:00.000Z",
        }],
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("reads jobs for one exact run and verifies repository identity from each job URL", async () => {
    const tokens = new RecordingTokenProvider();
    const adapter = createAdapter(tokens, async () => Response.json({
      total_count: 1,
      jobs: [workflowJob()],
    }));

    const called = await adapter.callReadTool(callInput(
      "fetch_workflow_run_jobs",
      { run_id: runId },
    ));

    expect(tokens.requests[0]).toEqual({
      repositoryFullName,
      permission: { name: "actions", access: "read" },
    });
    expect(called.result).toEqual({
      repositoryFullName,
      runId,
      totalCount: 1,
      jobs: [{
        id: 777,
        runId,
        runAttempt: 1,
        headSha: commitSha,
        name: "test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-07-31T19:41:00.000Z",
        completedAt: "2026-07-31T19:47:00.000Z",
        labels: ["ubuntu-24.04"],
      }],
    });
  });

  test("rejects caller and provider identity drift before publication", async () => {
    const tokens = new RecordingTokenProvider();
    let calls = 0;
    const adapter = createAdapter(tokens, async () => {
      calls += 1;
      return Response.json({
        total_count: 1,
        workflow_runs: [{
          ...workflowRun(),
          repository: { full_name: "teamleaderleo/other" },
        }],
      });
    });

    await expect(adapter.callReadTool({
      ...callInput("fetch_commit_workflow_runs", { commit_sha: commitSha }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    expect(tokens.requests).toEqual([]);
    expect(calls).toBe(0);

    await expect(adapter.callReadTool(callInput(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha },
    ))).rejects.toThrow("accepted repository");
  });

  test("rejects pagination escape, inconsistent counts, and job/run mismatch", async () => {
    const escaped = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({ total_count: 0, workflow_runs: [] }, {
        headers: {
          link: `<https://evil.example/repos/teamleaderleo/stensibly/actions/runs?head_sha=${commitSha}&per_page=50&page=2>; rel="next"`,
        },
      }));
    await expect(escaped.callReadTool(callInput(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha },
    ))).rejects.toThrow("escaped the accepted request");

    const count = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({ total_count: 2, workflow_runs: [workflowRun()] }));
    await expect(count.callReadTool(callInput(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha },
    ))).rejects.toThrow("count was inconsistent");

    const mismatch = createAdapter(new RecordingTokenProvider(), async () =>
      Response.json({
        total_count: 1,
        jobs: [{ ...workflowJob(), run_id: runId + 1 }],
      }));
    await expect(mismatch.callReadTool(callInput(
      "fetch_workflow_run_jobs",
      { run_id: runId },
    ))).rejects.toThrow("requested run");
  });

  test("preserves landed repository reads", async () => {
    const tokens = new RecordingTokenProvider();
    const adapter = createAdapter(tokens, async () => Response.json({
      id: 123456,
      node_id: "R_kgDOGitHub",
      full_name: "TeamLeaderLeo/Stensibly",
      private: true,
      archived: false,
      disabled: false,
      visibility: "private",
      default_branch: "main",
      updated_at: "2026-07-31T01:02:03Z",
      pushed_at: "2026-07-31T01:01:00Z",
    }));
    const called = await adapter.callReadTool(callInput("get_repo", {}));
    expect((called.result as { repositoryFullName: string }).repositoryFullName)
      .toBe(repositoryFullName);
    expect(tokens.requests[0]?.permission).toEqual({ name: "metadata", access: "read" });
  });
});

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];
  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return { token: "delegated-token", expiresAt: "2026-07-31T21:00:00.000Z" };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): GitHubRestActionsRunAdapter {
  return new GitHubRestActionsRunAdapter({
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

function workflowRun() {
  return {
    id: runId,
    run_attempt: 1,
    workflow_id: 123456,
    name: "Canonical CI",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: commitSha,
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
    created_at: "2026-07-31T19:40:00Z",
    updated_at: "2026-07-31T19:48:00Z",
    run_started_at: "2026-07-31T19:41:00Z",
  };
}

function workflowJob() {
  return {
    id: 777,
    run_id: runId,
    run_attempt: 1,
    head_sha: commitSha,
    name: "test",
    status: "completed",
    conclusion: "success",
    started_at: "2026-07-31T19:41:00Z",
    completed_at: "2026-07-31T19:47:00Z",
    labels: ["ubuntu-24.04"],
    url: "https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/777",
  };
}
