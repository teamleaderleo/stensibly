import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  InMemoryGitHubProviderReceiptStore,
  type GitHubProviderReceipt,
  type GitHubProviderReceiptStore,
} from "../src/github-issue-provider.ts";
import {
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
import { GitHubRestIssueWriteAdapter } from "../src/github-rest-issue-write-adapter.ts";
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
const fixedNow = Date.parse("2026-08-02T00:00:00.000Z");
const issueNumber = 1001;
const commentId = 2001;
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
  autonomousActions: ["github_issue_read", "github_issue_write"],
  approvalRequired: [],
  checks: [],
  tags: ["dogfood"],
  relatedProjects: [],
}, {
  goal: "Exercise durable hosted GitHub issue writes.",
  boundaries: "One accepted repository and three initial issue mutations.",
  evidenceAndHandoff: "Retain provider receipts and exact readback.",
  escalation: "Reconcile ambiguous provider effects before retry.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_github_writes",
  project,
  snapshot,
  sourceRevision: "main@hosted-github-write-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-02T00:00:00.000Z",
};

describe("private hosted GitHub issue writes", () => {
  test("creates, replays across remount, updates, and comments with exact scopes and readback", async () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    let issue = apiIssue({
      title: "Durable hosted write",
      body: "Bounded provider body",
    });
    const comment = apiComment("Verified comment body");
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
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
        const permission = body?.permissions as Record<string, unknown>;
        return Response.json({
          token: permission.issues === "write"
            ? "installation-write-token-secret"
            : "installation-read-token-secret",
          expires_at: "2026-08-02T01:00:00Z",
          permissions: {
            issues: permission.issues,
            metadata: "read",
          },
          repository_selection: "selected",
          repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
        }, { status: 201 });
      }
      if (
        method === "POST"
        && url.endsWith("/repos/teamleaderleo/stensibly/issues")
      ) {
        issue = apiIssue({
          title: String(body?.title),
          body: typeof body?.body === "string" ? body.body : null,
          labels: Array.isArray(body?.labels)
            ? body.labels.map(String)
            : [],
          assignees: Array.isArray(body?.assignees)
            ? body.assignees.map((login) => ({ login: String(login) }))
            : [],
        });
        return Response.json(issue, {
          status: 201,
          headers: { "x-github-request-id": "WRITE:CREATE" },
        });
      }
      if (
        method === "PATCH"
        && url.endsWith(`/repos/teamleaderleo/stensibly/issues/${issueNumber}`)
      ) {
        issue = apiIssue({
          ...issue,
          ...(typeof body?.title === "string" ? { title: body.title } : {}),
          ...(typeof body?.body === "string" ? { body: body.body } : {}),
          ...(body?.state === "open" || body?.state === "closed"
            ? { state: body.state }
            : {}),
          ...(body?.state_reason === null
            || body?.state_reason === "completed"
            || body?.state_reason === "not_planned"
            || body?.state_reason === "reopened"
            ? { state_reason: body.state_reason }
            : {}),
          updated_at: "2026-08-02T00:02:00Z",
        });
        return Response.json(issue, {
          headers: { "x-github-request-id": "WRITE:UPDATE" },
        });
      }
      if (
        method === "POST"
        && url.endsWith(
          `/repos/teamleaderleo/stensibly/issues/${issueNumber}/comments`,
        )
      ) {
        return Response.json(comment, {
          status: 201,
          headers: { "x-github-request-id": "WRITE:COMMENT" },
        });
      }
      if (
        method === "GET"
        && url.endsWith(
          `/repos/teamleaderleo/stensibly/issues/comments/${commentId}`,
        )
      ) {
        return Response.json(comment, {
          headers: { "x-github-request-id": "READ:COMMENT" },
        });
      }
      if (
        method === "GET"
        && url.endsWith(`/repos/teamleaderleo/stensibly/issues/${issueNumber}`)
      ) {
        return Response.json(issue, {
          headers: { "x-github-request-id": "READ:ISSUE" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };

    const env = providerEnv(true);
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      env,
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    const context = {
      project,
      repository: repositoryFullName,
      actorId: "api-token:write-test",
      clientId: "mcp:api-token:write-test",
    };
    const createInput = {
      ...context,
      title: "Durable hosted write",
      body: "Bounded provider body",
      labels: ["area:github"],
      assignees: ["teamleaderleo"],
      idempotencyKey: "hosted-create-1",
    };
    const created = await mounted.createIssue!(createInput);
    expect(created).toMatchObject({
      state: "succeeded",
      operation: "github_create_issue",
      providerRequestId: "WRITE:CREATE",
      verification: { state: "passed" },
      result: {
        reference: {
          externalId: `github:${repositoryFullName}#${issueNumber}`,
        },
        title: "Durable hosted write",
        containsIssueBody: false,
      },
    });

    const remounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      env,
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    expect(await remounted.createIssue!(createInput)).toEqual(created);
    await expect(remounted.createIssue!({
      ...createInput,
      title: "Changed idempotency reuse",
    })).rejects.toThrow("idempotency key was reused");

    const sourceRevision = (
      created.result as { sourceRevision: string }
    ).sourceRevision;
    const updated = await remounted.updateIssue!({
      ...context,
      issueNumber,
      expectedSourceRevision: sourceRevision,
      title: "Durable hosted write updated",
      idempotencyKey: "hosted-update-1",
    });
    expect(updated).toMatchObject({
      state: "succeeded",
      operation: "github_update_issue",
      providerRequestId: "WRITE:UPDATE",
      result: { title: "Durable hosted write updated" },
    });

    const commented = await remounted.addIssueComment!({
      ...context,
      issueNumber,
      body: "Verified comment body",
      idempotencyKey: "hosted-comment-1",
    });
    expect(commented).toMatchObject({
      state: "succeeded",
      operation: "github_add_issue_comment",
      providerRequestId: "WRITE:COMMENT",
      result: {
        id: String(commentId),
        issueNumber,
        containsBody: false,
      },
    });

    const providerWrites = calls.filter((call) =>
      call.method === "POST" || call.method === "PATCH"
    ).filter((call) => !call.url.includes("/access_tokens"));
    expect(providerWrites.map((call) => call.method)).toEqual([
      "POST",
      "PATCH",
      "POST",
    ]);
    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls.map((call) => call.body)).toEqual([
      {
        repositories: ["stensibly"],
        permissions: { issues: "write" },
      },
      {
        repositories: ["stensibly"],
        permissions: { issues: "read" },
      },
    ]);
    expect(providerWrites.every((call) =>
      call.authorization === "Bearer installation-write-token-secret"
    )).toBe(true);
    const retained = JSON.stringify({ created, updated, commented });
    expect(retained).not.toContain("installation-write-token-secret");
    expect(retained).not.toContain("Bounded provider body");
    expect(retained).not.toContain("Verified comment body");
  });

  test("keeps writes absent by default and rejects malformed enablement", () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(false),
      { now: () => fixedNow },
    );
    expect("getIssue" in mounted).toBe(true);
    expect("createIssue" in mounted).toBe(false);

    expect(() => mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      {
        ...providerEnv(false),
        STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "TRUE",
      },
    )).toThrow("must be exact true or false");
  });

  test("requires durable receipts before mounting and keeps set writes unavailable", async () => {
    let providerCalls = 0;
    expect(() => mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      providerEnv(true),
      {
        fetch: (async () => {
          providerCalls += 1;
          return Response.json({ message: "must not dispatch" });
        }) as typeof fetch,
        now: () => fixedNow,
      },
    )).toThrow("durable provider receipt store");
    expect(providerCalls).toBe(0);

    const adapter = new GitHubRestIssueWriteAdapter({
      tokenProvider: {
        async getInstallationToken() {
          providerCalls += 1;
          return {
            token: "must-not-mint",
            expiresAt: "2026-08-02T01:00:00.000Z",
          };
        },
      },
      apiBaseUrl: "https://api.github.test",
      fetch: (async () => {
        providerCalls += 1;
        return Response.json({ message: "must not dispatch" });
      }) as typeof fetch,
    });
    await expect(adapter.addIssueLabels({
      repositoryFullName,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "labels-remain-off",
    })).rejects.toThrow("remain unavailable");
    expect(providerCalls).toBe(0);
  });
});

function ledgerWithReceipts(
  receipts: GitHubProviderReceiptStore,
): WorkLedger & ProjectAttachmentLedger & GitHubProviderReceiptStore {
  return Object.assign(fakeLedger(), {
    reserveGitHubProviderReceipt:
      receipts.reserveGitHubProviderReceipt.bind(receipts),
    updateGitHubProviderReceipt:
      receipts.updateGitHubProviderReceipt.bind(receipts),
    getGitHubProviderReceipt:
      receipts.getGitHubProviderReceipt.bind(receipts),
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

function providerEnv(writesEnabled: boolean): Record<string, string> {
  return {
    STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED:
      writesEnabled ? "true" : "false",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

function apiIssue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: issueNumber,
    node_id: "I_hosted_write_1001",
    repository_url: "https://api.github.test/repos/teamleaderleo/stensibly",
    title: "Durable hosted write",
    body: "Bounded provider body",
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    milestone: null,
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:01Z",
    ...overrides,
  };
}

function apiComment(body: string): Record<string, unknown> {
  return {
    id: commentId,
    issue_url:
      `https://api.github.test/repos/teamleaderleo/stensibly/issues/${issueNumber}`,
    html_url:
      `https://github.test/teamleaderleo/stensibly/issues/${issueNumber}#issuecomment-${commentId}`,
    body,
    created_at: "2026-08-02T00:03:00Z",
    updated_at: "2026-08-02T00:03:00Z",
  };
}
