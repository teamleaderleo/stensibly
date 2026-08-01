import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadJobDetailTools,
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
const jobId = 91345873454;
const jobUrl = `https://api.github.test/repos/teamleaderleo/stensibly/actions/jobs/${jobId}`;
const logsUrl = `${jobUrl}/logs`;
const downloadUrl =
  "https://results-receiver.actions.githubusercontent.com/job-logs/91345873454?sig=bounded";
const logText = "2026-08-01T08:02:00Z Run tests\nAll checks passed";
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
  goal: "Exercise guarded hosted GitHub Actions job-detail reads.",
  boundaries: "Keep artifacts, credentials, and writes outside this slice.",
  evidenceAndHandoff: "Return bounded step and log receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_actions_job_detail",
  project,
  snapshot,
  sourceRevision: "main@hosted-actions-job-detail-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-01T08:00:00.000Z",
};

describe("opt-in hosted GitHub Actions job-detail reads", () => {
  test("keeps the existing eight-tool declaration until the exact flag is enabled", async () => {
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(false),
      { now: () => fixedNow },
    );
    expect(mounted.delegatedGitHubReadTools).toBe(hostedGitHubDelegatedReadTools);
    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_workflow_job_steps",
      arguments: { job_id: jobId },
    })).rejects.toThrow("authority denied");
  });

  test("routes steps and logs through exact actions authority with separate request identities", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(true),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          calls.push({
            url,
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
          if (url === jobUrl) {
            return Response.json(workflowJob(), {
              headers: { "x-github-request-id": "ACTIONS:JOB:DETAIL" },
            });
          }
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
            expect(headers.get("authorization")).toBeNull();
            return new Response(logText, {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadJobDetailTools);

    const stepsReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_workflow_job_steps",
      arguments: { job_id: jobId },
    });
    const logsReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_workflow_job_logs",
      arguments: { job_id: jobId },
    });

    expect(stepsReceipt).toMatchObject({
      tool: "fetch_workflow_job_steps",
      providerRequestId: "ACTIONS:JOB:DETAIL",
      result: {
        repositoryFullName,
        jobId,
        runId,
        runAttempt: 1,
        headSha: commitSha,
        totalCount: 2,
      },
    });
    expect(logsReceipt).toMatchObject({
      tool: "fetch_workflow_job_logs",
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
    expect(Object.isFrozen(stepsReceipt)).toBe(true);
    expect(Object.isFrozen(logsReceipt)).toBe(true);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({
      repositories: ["stensibly"],
      permissions: { actions: "read" },
    });
    expect(calls.find((call) => call.url === downloadUrl)?.authorization)
      .toBeNull();
    const serialized = JSON.stringify({ stepsReceipt, logsReceipt });
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain(downloadUrl);
  });

  test("rejects malformed job-detail enablement before mounting", () => {
    expect(() => mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      {
        ...providerEnv(false),
        STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: "TRUE",
      },
    )).toThrow("must be exact true or false");
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

function providerEnv(jobDetailReadsEnabled: boolean): Record<string, string> {
  return {
    STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true",
    STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED:
      jobDetailReadsEnabled ? "true" : "false",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
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
    started_at: "2026-08-01T08:02:00Z",
    completed_at: "2026-08-01T08:09:00Z",
    url: jobUrl,
    run_url:
      `https://api.github.test/repos/teamleaderleo/stensibly/actions/runs/${runId}`,
    steps: [
      {
        number: 1,
        name: "Set up job",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T08:02:00Z",
        completed_at: "2026-08-01T08:03:00Z",
      },
      {
        number: 2,
        name: "Run tests",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T08:03:00Z",
        completed_at: "2026-08-01T08:09:00Z",
      },
    ],
  };
}
