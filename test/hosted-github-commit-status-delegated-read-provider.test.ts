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
const commitSha = "a".repeat(40);
const fixedNow = Date.parse("2026-08-01T09:00:00.000Z");
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
const statusUrl = `https://api.github.test/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=1`;
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
  goal: "Exercise private hosted GitHub combined-status reads.",
  boundaries: "Keep status writes, credentials, and unrelated GitHub tools outside this slice.",
  evidenceAndHandoff: "Return one bounded attributable combined-status receipt.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_commit_status",
  project,
  snapshot,
  sourceRevision: "main@hosted-commit-status-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-01T09:00:00.000Z",
};

describe("private hosted GitHub combined-status delegated reads", () => {
  test("routes the exact SHA through statuses:read and returns a frozen content-minimised receipt", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : null;
          calls.push({
            url,
            method: init?.method ?? "GET",
            authorization: headers.get("authorization"),
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            expect(body).toEqual({
              repositories: ["stensibly"],
              permissions: { statuses: "read" },
            });
            return Response.json({
              token: "commit-status-installation-token-secret",
              expires_at: "2026-08-01T10:00:00Z",
              permissions: { statuses: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === statusUrl) {
            return statusResponse(combinedStatusPayload(), "STATUS:MOUNT:1");
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadTools);
    expect(mounted.delegatedGitHubReadTools)
      .toContain("get_commit_combined_status");

    const receipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "get_commit_combined_status",
      arguments: { commit_sha: commitSha },
    });

    expect(receipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "get_commit_combined_status",
      providerRequestId: "STATUS:MOUNT:1",
      result: {
        repositoryFullName,
        commitSha,
        state: "success",
        totalCount: 1,
        statuses: [{
          id: 123,
          state: "success",
          context: "ci/serial",
          description: "Exact head passed",
          targetUrlPresent: true,
          creatorLogin: "github-actions",
          creatorId: 41898282,
          createdAt: "2026-08-01T09:01:00.000Z",
          updatedAt: "2026-08-01T09:02:00.000Z",
        }],
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.result)).toBe(true);
    const result = receipt.result as { statuses: readonly unknown[] };
    expect(Object.isFrozen(result.statuses)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url)
      .toBe("https://api.github.test/app/installations/98765/access_tokens");
    expect(calls[0]?.authorization).toMatch(/^Bearer /);
    expect(calls[1]).toMatchObject({
      url: statusUrl,
      method: "GET",
      authorization: "Bearer commit-status-installation-token-secret",
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("https://checks.github.test/private");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("denies an unmounted Actions step read before token or provider activity", async () => {
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
      tool: "fetch_workflow_job_steps",
      arguments: { job_id: 91345873454 },
    })).rejects.toThrow("authority denied");
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

function combinedStatusPayload() {
  return {
    state: "success",
    sha: commitSha,
    total_count: 1,
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
    statuses: [{
      id: 123,
      state: "success",
      context: "ci/serial",
      description: "Exact head passed",
      target_url: "https://checks.github.test/private",
      creator: { login: "github-actions", id: 41898282 },
      created_at: "2026-08-01T09:01:00Z",
      updated_at: "2026-08-01T09:02:00Z",
    }],
  };
}

function statusResponse(payload: unknown, requestId: string): Response {
  const response = Response.json(payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": requestId,
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: statusUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}
