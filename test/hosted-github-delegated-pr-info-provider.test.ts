import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
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
const pullRequestNumber = 42;
const headSha = "d".repeat(40);
const baseSha = "e".repeat(40);
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
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
  goal: "Exercise private hosted delegated GitHub pull request reads.",
  boundaries: "Keep credentials, writes, and public exposure outside this slice.",
  evidenceAndHandoff: "Return exact binding and provider receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_delegated_pr_reads",
  project,
  snapshot,
  sourceRevision: "main@hosted-delegated-pr-read-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T00:00:00.000Z",
};

describe("private hosted GitHub delegated pull request reads", () => {
  test("mints pull-request-only authority and publishes an attributable receipt", async () => {
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
              token: "pull-request-installation-token-secret",
              expires_at: "2026-07-31T01:00:00Z",
              permissions: {
                pull_requests: "read",
                metadata: "read",
              },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (
            url
              === "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42"
          ) {
            return Response.json(pullRequestPayload(), {
              headers: { "x-github-request-id": "PRINFO:1234" },
            });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    const receipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "TeamLeaderLeo/Stensibly",
      tool: "get_pr_info",
      arguments: { pr_number: pullRequestNumber },
    });

    expect(receipt).toMatchObject({
      version: 1,
      project,
      repositoryFullName,
      tool: "get_pr_info",
      connectionId: "ghconn_installation_98765",
      installationId: "98765",
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      capabilityGrantId: null,
      approvalId: null,
      catalogueFingerprint,
      providerRequestId: "PRINFO:1234",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        id: 987654,
        state: "open",
        title: "Add one guarded pull request read",
        headRepositoryFullName: repositoryFullName,
        headSha,
        baseSha,
      },
    });
    expect(receipt.bindingId).toMatch(/^ghbind_[a-f0-9]{24}$/);
    expect(receipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.result)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.github.test/app/installations/98765/access_tokens",
      method: "POST",
      body: {
        repositories: ["stensibly"],
        permissions: { pull_requests: "read" },
      },
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42",
      method: "GET",
      authorization: "Bearer pull-request-installation-token-secret",
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("keeps every remaining delegated contract outside private authority", async () => {
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
      tool: "get_pr_diff",
      arguments: { pr_number: pullRequestNumber, format: "diff" },
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

function pullRequestPayload(): Record<string, unknown> {
  return {
    id: 987654,
    node_id: "PR_kwDOGitHub",
    number: pullRequestNumber,
    state: "open",
    locked: false,
    title: "Add one guarded pull request read",
    user: { login: "teamleaderleo" },
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: {
      ref: "sable/697-pr-info-native-read",
      sha: headSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    url: "https://api.github.test/repos/TeamLeaderLeo/Stensibly/pulls/42",
    created_at: "2026-07-31T02:00:00Z",
    updated_at: "2026-07-31T02:05:00Z",
    closed_at: null,
    merged_at: null,
    additions: 120,
    deletions: 12,
    changed_files: 2,
    commits: 1,
    review_comments: 3,
    comments: 4,
  };
}
