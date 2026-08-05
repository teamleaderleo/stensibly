import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InMemoryGitHubProviderReceiptStore,
  type GitHubProviderReceiptStore,
} from "../src/github-issue-provider.ts";
import {
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
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
const issueNumber = 1001;
const fixedNow = Date.parse("2026-08-02T00:00:00.000Z");
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
  goal: "Exercise private hosted GitHub issue set writes.",
  boundaries: "One accepted repository and exact label and assignee mutations.",
  evidenceAndHandoff: "Retain durable receipts and independent readback.",
  escalation: "Reconcile ambiguous effects before retry.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_github_set_writes",
  project,
  snapshot,
  sourceRevision: "main@hosted-github-set-write-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-02T00:00:00.000Z",
};

describe("private hosted GitHub issue set writes", () => {
  test("adds and removes labels and assignees with exact scopes, receipts, and replay", async () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    let mutationOrdinal = 0;
    let issue = apiIssue({ labels: [{ name: "existing" }], assignees: [] });

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
        const access = permission.issues;
        return Response.json({
          token: `installation-${access}-token-secret`,
          expires_at: "2026-08-02T01:00:00Z",
          permissions: { issues: access, metadata: "read" },
          repository_selection: "selected",
          repositories: [{ full_name: repositoryFullName }],
        }, { status: 201 });
      }
      if (
        method === "GET"
        && url.endsWith(`/repos/teamleaderleo/stensibly/issues/${issueNumber}`)
      ) {
        return Response.json(issue, {
          headers: { "x-github-request-id": "READ:ISSUE" },
        });
      }
      if (
        method === "POST"
        && url.endsWith(`/issues/${issueNumber}/labels`)
      ) {
        mutationOrdinal += 1;
        const requested = (body?.labels as unknown[]).map(String);
        const labels = new Set(issueLabelNames(issue));
        for (const label of requested) labels.add(label);
        issue = apiIssue({
          ...issue,
          labels: [...labels].map((name) => ({ name })),
          updated_at: mutationTime(mutationOrdinal),
        });
        return Response.json(issue.labels, {
          headers: { "x-github-request-id": "WRITE:LABELS:ADD" },
        });
      }
      if (
        method === "DELETE"
        && url.endsWith(`/issues/${issueNumber}/labels/priority%3Ap0`)
      ) {
        mutationOrdinal += 1;
        issue = apiIssue({
          ...issue,
          labels: issueLabelNames(issue)
            .filter((name) => name !== "priority:p0")
            .map((name) => ({ name })),
          updated_at: mutationTime(mutationOrdinal),
        });
        return Response.json(issue.labels, {
          headers: { "x-github-request-id": "WRITE:LABELS:REMOVE" },
        });
      }
      if (
        method === "POST"
        && url.endsWith(`/issues/${issueNumber}/assignees`)
      ) {
        mutationOrdinal += 1;
        const requested = (body?.assignees as unknown[])
          .map((login) => String(login).toLowerCase());
        const assignees = new Set(issueAssigneeLogins(issue));
        for (const login of requested) assignees.add(login);
        issue = apiIssue({
          ...issue,
          assignees: [...assignees].map((login) => ({ login })),
          updated_at: mutationTime(mutationOrdinal),
        });
        return Response.json(issue, {
          headers: { "x-github-request-id": "WRITE:ASSIGNEES:ADD" },
        });
      }
      if (
        method === "DELETE"
        && url.endsWith(`/issues/${issueNumber}/assignees`)
      ) {
        mutationOrdinal += 1;
        const removed = new Set(
          (body?.assignees as unknown[])
            .map((login) => String(login).toLowerCase()),
        );
        issue = apiIssue({
          ...issue,
          assignees: issueAssigneeLogins(issue)
            .filter((login) => !removed.has(login))
            .map((login) => ({ login })),
          updated_at: mutationTime(mutationOrdinal),
        });
        return Response.json(issue, {
          headers: { "x-github-request-id": "WRITE:ASSIGNEES:REMOVE" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };

    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(true),
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    const context = {
      project,
      repository: "TeamLeaderLeo/Stensibly",
      actorId: "api-token:set-write-test",
      clientId: "mcp:api-token:set-write-test",
    };

    const addLabelsInput = {
      ...context,
      issueNumber,
      labels: ["area:github", "priority:p0"],
      idempotencyKey: "hosted-label-add-1",
    };
    const addedLabels = await mounted.addIssueLabels!(addLabelsInput);
    expect(addedLabels).toMatchObject({
      state: "succeeded",
      operation: "github_add_issue_labels",
      target: `${repositoryFullName}#${issueNumber}:labels`,
      providerRequestId: "WRITE:LABELS:ADD",
      result: { labels: ["area:github", "existing", "priority:p0"] },
      verification: { state: "passed" },
    });
    expect(await mounted.addIssueLabels!(addLabelsInput)).toEqual(addedLabels);

    const removedLabel = await mounted.removeIssueLabel!({
      ...context,
      issueNumber,
      label: "priority:p0",
      idempotencyKey: "hosted-label-remove-1",
    });
    expect(removedLabel).toMatchObject({
      state: "succeeded",
      operation: "github_remove_issue_label",
      target: `${repositoryFullName}#${issueNumber}:labels`,
      providerRequestId: "WRITE:LABELS:REMOVE",
      result: { labels: ["area:github", "existing"] },
    });

    const addedAssignees = await mounted.addIssueAssignees!({
      ...context,
      issueNumber,
      assignees: ["teamleaderleo", "juniper-bot"],
      idempotencyKey: "hosted-assignee-add-1",
    });
    expect(addedAssignees).toMatchObject({
      state: "succeeded",
      operation: "github_add_issue_assignees",
      target: `${repositoryFullName}#${issueNumber}:assignees`,
      providerRequestId: "WRITE:ASSIGNEES:ADD",
      result: { assignees: ["juniper-bot", "teamleaderleo"] },
    });

    const removedAssignees = await mounted.removeIssueAssignees!({
      ...context,
      issueNumber,
      assignees: ["juniper-bot"],
      idempotencyKey: "hosted-assignee-remove-1",
    });
    expect(removedAssignees).toMatchObject({
      state: "succeeded",
      operation: "github_remove_issue_assignees",
      target: `${repositoryFullName}#${issueNumber}:assignees`,
      providerRequestId: "WRITE:ASSIGNEES:REMOVE",
      result: { assignees: ["teamleaderleo"] },
    });

    const providerWrites = calls.filter((call) =>
      !call.url.includes("/access_tokens")
      && (call.method === "POST" || call.method === "DELETE")
    );
    expect(providerWrites).toHaveLength(4);
    expect(providerWrites.every((call) =>
      call.authorization === "Bearer installation-write-token-secret"
    )).toBe(true);
    const issueReads = calls.filter((call) =>
      call.method === "GET" && call.url.includes(`/issues/${issueNumber}`)
    );
    expect(issueReads).toHaveLength(12);
    expect(issueReads.every((call) =>
      call.authorization === "Bearer installation-read-token-secret"
    )).toBe(true);
    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls.map((call) => call.body)).toEqual([
      {
        repositories: ["stensibly"],
        permissions: { issues: "read" },
      },
      {
        repositories: ["stensibly"],
        permissions: { issues: "write" },
      },
    ]);
    expect(mutationOrdinal).toBe(4);

    const retained = JSON.stringify({
      addedLabels,
      removedLabel,
      addedAssignees,
      removedAssignees,
    });
    expect(retained).not.toContain("installation-write-token-secret");
    expect(retained).not.toContain("installation-read-token-secret");
  });

  test("persists ambiguous label effects and does not redispatch exact replay", async () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    let issueReads = 0;
    let mutationCalls = 0;
    const issue = apiIssue();
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(String(init?.body)) as {
          permissions: { issues: "read" | "write" };
        };
        return Response.json({
          token: `installation-${body.permissions.issues}-token`,
          expires_at: "2026-08-02T01:00:00Z",
          permissions: {
            issues: body.permissions.issues,
            metadata: "read",
          },
          repository_selection: "selected",
          repositories: [{ full_name: repositoryFullName }],
        }, { status: 201 });
      }
      if (method === "GET" && url.endsWith(`/issues/${issueNumber}`)) {
        issueReads += 1;
        if (issueReads === 1) return Response.json(issue);
        return Response.json({ message: "readback unavailable" }, { status: 503 });
      }
      if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
        mutationCalls += 1;
        return Response.json([{ name: "area:github" }], {
          headers: { "x-github-request-id": "WRITE:LABELS:AMBIGUOUS" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };

    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(true),
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );
    const input = {
      project,
      repository: repositoryFullName,
      actorId: "api-token:ambiguous-set-write",
      clientId: "mcp:api-token:ambiguous-set-write",
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "hosted-ambiguous-label-add-1",
    };

    await expect(mounted.addIssueLabels!(input)).rejects.toThrow(
      "requires reconciliation before retry",
    );
    expect(await receipts.getGitHubProviderReceipt(
      project,
      input.idempotencyKey,
    )).toMatchObject({
      state: "pending_reconciliation",
      operation: "github_add_issue_labels",
      target: `${repositoryFullName}#${issueNumber}:labels`,
      error: {
        code: "ambiguous_provider_outcome",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });
    await expect(mounted.addIssueLabels!(input)).rejects.toThrow(
      "requires reconciliation before retry",
    );
    expect(mutationCalls).toBe(1);
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
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.com",
  };
}

function apiIssue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: issueNumber,
    node_id: "I_hosted_set_write_1001",
    repository_url: "https://api.github.com/repos/teamleaderleo/stensibly",
    title: "Durable hosted set write",
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

function issueLabelNames(issue: Record<string, unknown>): string[] {
  return (issue.labels as Array<{ name: string }>).map((label) => label.name);
}

function issueAssigneeLogins(issue: Record<string, unknown>): string[] {
  return (issue.assignees as Array<{ login: string }>).map(
    (assignee) => assignee.login,
  );
}

function mutationTime(ordinal: number): string {
  return `2026-08-02T00:00:${String(ordinal + 1).padStart(2, "0")}Z`;
}
