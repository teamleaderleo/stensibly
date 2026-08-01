import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadTools,
  mountHostedGitHubDelegatedReadProviderFromEnv,
} from "../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const project = "oauth-dogfood";
const fixedNow = Date.parse("2026-08-01T08:00:00.000Z");
const commitSha = "d".repeat(40);
const runId = 30691104156;
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repositoryFullName],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
}, {
  goal: "Exercise private hosted GitHub Actions metadata reads.",
  boundaries: "Keep steps, logs, artifacts, credentials, and writes outside this slice.",
  evidenceAndHandoff: "Return exact run and job receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_actions_reads",
  project,
  snapshot,
  sourceRevision: "main@hosted-actions-read-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-01T08:00:00.000Z",
};

describe("private hosted GitHub Actions delegated reads", () => {
  test("routes exact commit-run and run-job metadata through actions-only authority and permits deterministic read replay", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : null;
          calls.push({
            url,
            method,
            authorization: headers.get("authorization"),
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "actions-installation-token-secret",
              expires_at: "2026-08-01T09:00:00Z",
              permissions: { actions: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs?head_sha=${commitSha}&per_page=50&page=1`) {
            return Response.json({
              total_count: 1,
              workflow_runs: [workflowRun()],
            }, { headers: { "x-github-request-id": "ACTIONS:RUNS:1" } });
          }
          if (url === `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=1`) {
            return Response.json({
              total_count: 1,
              jobs: [workflowJob()],
            }, { headers: { "x-github-request-id": "ACTIONS:JOBS:1" } });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadTools);

    const runInput = {
      ...callBase(),
      tool: "fetch_commit_workflow_runs" as const,
      arguments: { commit_sha: commitSha },
    };
    const runReceipt = await mounted.callGitHubDelegatedRead!(runInput);
    const jobReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_workflow_run_jobs",
      arguments: { run_id: runId },
    });
    const replayReceipt = await mounted.callGitHubDelegatedRead!(runInput);

    expect(runReceipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "fetch_commit_workflow_runs",
      providerRequestId: "ACTIONS:RUNS:1",
      result: {
        repositoryFullName,
        commitSha,
        totalCount: 1,
        workflowRuns: [{
          id: runId,
          attempt: 1,
          workflowId: 319014676,
          workflowName: "CI",
          status: "completed",
          conclusion: "success",
          headSha: commitSha,
        }],
      },
    });
    expect(jobReceipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "fetch_workflow_run_jobs",
      providerRequestId: "ACTIONS:JOBS:1",
      result: {
        repositoryFullName,
        runId,
        totalCount: 1,
        jobs: [{
          id: 91345873454,
          runId,
          runAttempt: 1,
          headSha: commitSha,
          name: "test",
          status: "completed",
          conclusion: "success",
          labels: ["ubuntu-24.04"],
        }],
      },
    });
    expect(replayReceipt).toEqual(runReceipt);
    expect(Object.isFrozen(runReceipt)).toBe(true);
    expect(Object.isFrozen(jobReceipt)).toBe(true);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({
      repositories: ["stensibly"],
      permissions: { actions: "read" },
    });
    const providerCalls = calls.filter((call) => call.method === "GET");
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls.map((call) => call.authorization)).toEqual([
      "Bearer actions-installation-token-secret",
      "Bearer actions-installation-token-secret",
      "Bearer actions-installation-token-secret",
    ]);
    const serialized = JSON.stringify({ runReceipt, jobReceipt });
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("rejects a stale catalogue before token or provider activity", async () => {
    let externalCalls = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async () => {
          externalCalls += 1;
          return Response.json({ message: "must not dispatch" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      catalogueFingerprint: `sha256:${"0".repeat(64)}`,
      tool: "fetch_commit_workflow_runs",
      arguments: { commit_sha: commitSha },
    })).rejects.toThrow("catalogue fingerprint is stale");
    expect(externalCalls).toBe(0);
  });

  test("propagates an attributable provider HTTP failure without publishing a partial receipt", async () => {
    let externalCalls = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL) => {
          externalCalls += 1;
          const url = String(input);
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "actions-installation-token-secret",
              expires_at: "2026-08-01T09:00:00Z",
              permissions: { actions: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          return Response.json({ message: "provider failure" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_workflow_run_jobs",
      arguments: { run_id: runId },
    })).rejects.toThrow("provider returned HTTP 500");
    expect(externalCalls).toBe(2);
  });

  test("preserves the non-Actions repository adapter branch", async () => {
    const calls: string[] = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            expect(body).toEqual({
              repositories: ["stensibly"],
              permissions: { metadata: "read" },
            });
            return Response.json({
              token: "metadata-installation-token-secret",
              expires_at: "2026-08-01T09:00:00Z",
              permissions: { metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === "https://api.github.test/repos/teamleaderleo/stensibly") {
            return Response.json(repositoryPayload(), {
              headers: { "x-github-request-id": "REPO:ROUTING:1" },
            });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    const receipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "get_repo",
      arguments: {},
    });
    expect(receipt).toMatchObject({
      tool: "get_repo",
      providerRequestId: "REPO:ROUTING:1",
      result: {
        repositoryFullName,
        id: 123456,
        defaultBranch: "main",
      },
    });
    expect(calls).toEqual([
      "https://api.github.test/app/installations/98765/access_tokens",
      "https://api.github.test/repos/teamleaderleo/stensibly",
    ]);
  });

  test("keeps steps and logs outside the hosted authority before token activity", async () => {
    let externalCalls = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async () => {
          externalCalls += 1;
          return Response.json({ message: "must not dispatch" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    for (const [tool, argumentsValue] of [
      ["fetch_workflow_job_steps", { job_id: 91345873454 }],
      ["fetch_workflow_job_logs", { job_id: 91345873454 }],
    ] as const) {
      await expect(mounted.callGitHubDelegatedRead!({
        ...callBase(),
        tool,
        arguments: argumentsValue,
      })).rejects.toThrow("authority denied");
    }
    expect(externalCalls).toBe(0);
  });
});

function callBase() {
  return {
    project,
    repository: repositoryFullName,
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint,
  };
}

function fakeLedger(): WorkLedger & ProjectAttachmentLedger {
  return {
    async getProjectAttachment(requestedProject: string) {
      return requestedProject === project ? attachment : null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  } as unknown as WorkLedger & ProjectAttachmentLedger;
}

function providerEnv(): Record<string, string> {
  return {
    STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

function workflowRun() {
  return {
    id: runId,
    run_attempt: 1,
    workflow_id: 319014676,
    name: "CI",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: commitSha,
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
    created_at: "2026-08-01T08:01:00Z",
    updated_at: "2026-08-01T08:10:00Z",
    run_started_at: "2026-08-01T08:02:00Z",
  };
}

function workflowJob() {
  return {
    id: 91345873454,
    run_id: runId,
    run_attempt: 1,
    head_sha: commitSha,
    name: "test",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T08:02:00Z",
    completed_at: "2026-08-01T08:09:00Z",
    labels: ["ubuntu-24.04"],
    url: "https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/91345873454",
  };
}

function repositoryPayload() {
  return {
    id: 123456,
    node_id: "R_kgDOHostedDelegated",
    full_name: "TeamLeaderLeo/Stensibly",
    private: true,
    archived: false,
    disabled: false,
    visibility: "private",
    default_branch: "main",
    updated_at: "2026-08-01T08:10:00Z",
    pushed_at: "2026-08-01T08:09:00Z",
  };
}
