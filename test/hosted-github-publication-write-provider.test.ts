import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  InMemoryGitHubProviderReceiptStore,
} from "../src/github-provider-receipts.ts";
import type { GitHubProviderReceiptStore } from "../src/github-provider-contracts.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";
import { mountHostedGitHubIssueProviderFromEnv } from "../src/hosted-github-issue-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const baseSha = "a".repeat(40);
const branch = "codex/publication";
const fixedNow = Date.parse("2026-08-09T00:00:00.000Z");
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repository],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["create_branch", "provider_write"],
  approvalRequired: [],
  checks: [],
  tags: ["github"],
  relatedProjects: [],
}, {
  goal: "Exercise hosted GitHub publication writes.",
  boundaries: "One accepted repository and exact branch/PR revisions.",
  evidenceAndHandoff: "Retain durable provider receipts without bodies.",
  escalation: "Reconcile ambiguous provider effects before retry.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_publication",
  project,
  snapshot,
  sourceRevision: "main@hosted-publication-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-09T00:00:00.000Z",
};

describe("private hosted GitHub publication writes", () => {
  test("mounts only under its exact flag and replays branch/PR receipts across remount", async () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const branches = new Map<string, string>([["main", baseSha]]);
    const calls: Array<{
      url: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : null;
      calls.push({ url, method, body });
      if (url.endsWith("/app/installations/98765/access_tokens")) {
        const permissions = body?.permissions as Record<string, "read" | "write">;
        return Response.json({
          token: `installation-${Object.keys(permissions)[0]}-${Object.values(permissions)[0]}-secret`,
          expires_at: "2026-08-09T01:00:00Z",
          permissions: { ...permissions, metadata: "read" },
          repository_selection: "selected",
          repositories: [{ full_name: repository }],
        }, { status: 201 });
      }
      const refPrefix = `https://api.github.com/repos/${repository}/git/ref/heads/`;
      if (url.startsWith(refPrefix) && method === "GET") {
        const name = decodeURIComponent(url.slice(refPrefix.length));
        const sha = branches.get(name);
        return sha
          ? Response.json(apiBranch(name, sha))
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.endsWith(`/repos/${repository}/git/refs`) && method === "POST") {
        const name = String(body?.ref).replace(/^refs\/heads\//u, "");
        const sha = String(body?.sha);
        branches.set(name, sha);
        return Response.json(apiBranch(name, sha), {
          status: 201,
          headers: { "x-github-request-id": "BRANCH:HOSTED" },
        });
      }
      if (url.endsWith(`/repos/${repository}/pulls`) && method === "POST") {
        return Response.json(apiPullRequest(body), {
          status: 201,
          headers: { "x-github-request-id": "PR:HOSTED" },
        });
      }
      if (url.endsWith(`/repos/${repository}/pulls/42`) && method === "GET") {
        return Response.json(apiPullRequest({
          title: "Hosted publication",
          body: "Hosted bounded body",
          head: branch,
          base: "main",
          draft: true,
        }));
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(),
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    expect(typeof mounted.createBranch).toBe("function");
    expect(typeof mounted.createPullRequest).toBe("function");
    expect(typeof mounted.createRepositoryFile).toBe("function");
    expect(typeof mounted.updateRepositoryFile).toBe("function");
    expect(typeof mounted.reconcileRepositoryFile).toBe("function");
    expect("publishChange" in mounted).toBe(false);

    const context = {
      project,
      repository,
      actorId: "api-token:oauth_grant_publication",
      clientId: "mcp:api-token:oauth_grant_publication",
    };
    const branchInput = {
      ...context,
      branch,
      fromCommitSha: baseSha,
      idempotencyKey: "hosted-publication-branch",
    };
    const createdBranch = await mounted.createBranch!(branchInput);
    expect(createdBranch).toMatchObject({
      state: "succeeded",
      operation: "github_create_branch",
      providerRequestId: "BRANCH:HOSTED",
      result: { kind: "branch", name: branch, commitSha: baseSha },
    });

    const pullRequestInput = {
      ...context,
      title: "Hosted publication",
      body: "Hosted bounded body",
      head: branch,
      base: "main",
      expectedHeadSha: baseSha,
      expectedBaseSha: baseSha,
      draft: true,
      idempotencyKey: "hosted-publication-pr",
    };
    const createdPullRequest = await mounted.createPullRequest!(
      pullRequestInput,
    );
    expect(createdPullRequest).toMatchObject({
      state: "succeeded",
      operation: "github_create_pull_request",
      providerRequestId: "PR:HOSTED",
      result: { kind: "pull_request", number: 42, containsBody: false },
    });
    expect(JSON.stringify(createdPullRequest)).not.toContain(
      "Hosted bounded body",
    );

    const writesBeforeReplay = providerWriteCount(calls);
    const remounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(),
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    expect(await remounted.createBranch!(branchInput)).toEqual(createdBranch);
    expect(await remounted.createPullRequest!(pullRequestInput)).toEqual(
      createdPullRequest,
    );
    expect(providerWriteCount(calls)).toBe(writesBeforeReplay);
  });

  test("keeps publication methods absent when the exact flag is disabled", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(new InMemoryGitHubProviderReceiptStore()),
      { ...providerEnv(), STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "false" },
    );
    expect("createBranch" in mounted).toBe(false);
    expect("createPullRequest" in mounted).toBe(false);
    expect("createRepositoryFile" in mounted).toBe(false);
    expect("updateRepositoryFile" in mounted).toBe(false);
  });

  test("mounts the composed operation only when its durable workflow store is present", () => {
    const ledger = Object.assign(
      ledgerWithReceipts(new InMemoryGitHubProviderReceiptStore()),
      {
        async reserveOperationWorkflow(workflow: unknown) {
          return { outcome: "reserved" as const, workflow };
        },
        async transitionOperationWorkflow(input: { next: unknown }) {
          return input.next;
        },
        async getOperationWorkflow() {
          return null;
        },
      },
    );
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledger,
      providerEnv(),
    );
    expect(typeof mounted.publishChange).toBe("function");
  });

  test("derives repository authority from the attachment and refuses the default branch before provider write dispatch", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(String(init?.body)) as {
          permissions: Record<string, "read" | "write">;
        };
        return Response.json({
          token: "installation-metadata-read-secret",
          expires_at: "2026-08-09T01:00:00Z",
          permissions: body.permissions,
          repository_selection: "selected",
          repositories: [{ full_name: repository }],
        }, { status: 201 });
      }
      if (url.endsWith(`/repos/${repository}`) && method === "GET") {
        return Response.json(apiRepository());
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(new InMemoryGitHubProviderReceiptStore()),
      providerEnv(),
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );

    await expect(mounted.createRepositoryFile!({
      project,
      repository,
      actorId: "api-token:oauth_grant_publication",
      clientId: "mcp:api-token:oauth_grant_publication",
      path: "docs/default-branch.md",
      branch: "main",
      expectedParentSha: baseSha,
      content: "refused\n",
      message: "Refuse default-branch write",
      idempotencyKey: "hosted-default-branch-refusal",
    })).rejects.toThrow(
      "Default-branch repository writes require trusted approval evidence",
    );
    expect(providerWriteCount(calls)).toBe(0);
    expect(calls.some((call) => call.url.endsWith(`/repos/${repository}`))).toBe(
      true,
    );
  });

  test("fails closed on malformed activation or a missing durable receipt store", () => {
    expect(() => mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(new InMemoryGitHubProviderReceiptStore()),
      {
        ...providerEnv(),
        STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "TRUE",
      },
    )).toThrow(
      "STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED must be exact true or false",
    );
    expect(() => mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      providerEnv(),
    )).toThrow("durable provider receipt store");
  });
});

function ledgerWithReceipts(
  receipts: GitHubProviderReceiptStore,
): WorkLedger & ProjectAttachmentLedger & GitHubProviderReceiptStore {
  const repositoryWrites = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
  return Object.assign(fakeLedger(), {
    reserveGitHubProviderReceipt:
      receipts.reserveGitHubProviderReceipt.bind(receipts),
    updateGitHubProviderReceipt:
      receipts.updateGitHubProviderReceipt.bind(receipts),
    getGitHubProviderReceipt:
      receipts.getGitHubProviderReceipt.bind(receipts),
    reserveRepositoryWrite:
      repositoryWrites.reserveRepositoryWrite.bind(repositoryWrites),
    rejectAndReleaseRepositoryWrite:
      repositoryWrites.rejectAndReleaseRepositoryWrite.bind(repositoryWrites),
    holdRepositoryWriteForReconciliation:
      repositoryWrites.holdRepositoryWriteForReconciliation.bind(repositoryWrites),
    recordVerifiedRepositoryWrite:
      repositoryWrites.recordVerifiedRepositoryWrite.bind(repositoryWrites),
    holdVerifiedRepositoryWriteForReconciliation:
      repositoryWrites.holdVerifiedRepositoryWriteForReconciliation.bind(
        repositoryWrites,
      ),
    releaseVerifiedRepositoryWrite:
      repositoryWrites.releaseVerifiedRepositoryWrite.bind(repositoryWrites),
    getRepositoryWriteReceipt:
      repositoryWrites.getRepositoryWriteReceipt.bind(repositoryWrites),
  });
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
    STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "false",
    STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "true",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.com",
  };
}

function apiRepository() {
  return {
    id: 123456,
    node_id: "R_kgDOHostedPublication",
    full_name: repository,
    private: true,
    archived: false,
    disabled: false,
    visibility: "private",
    default_branch: "main",
    updated_at: "2026-08-09T00:00:00Z",
    pushed_at: "2026-08-09T00:00:00Z",
  };
}

function apiBranch(name: string, sha: string) {
  return {
    ref: `refs/heads/${name}`,
    object: { type: "commit", sha },
  };
}

function apiPullRequest(body: Record<string, unknown> | null) {
  return {
    number: 42,
    node_id: "PR_kwDO_hosted_publication",
    title: body?.title,
    body: body?.body ?? null,
    state: "open",
    draft: body?.draft,
    head: {
      ref: body?.head,
      sha: baseSha,
      repo: { full_name: repository },
    },
    base: {
      ref: body?.base,
      sha: baseSha,
      repo: { full_name: repository },
    },
    created_at: "2026-08-09T00:00:00Z",
    updated_at: "2026-08-09T00:00:01Z",
  };
}

function providerWriteCount(
  calls: Array<{ url: string; method: string }>,
): number {
  return calls.filter((call) =>
    call.method === "POST" && !call.url.includes("/access_tokens")
  ).length;
}
