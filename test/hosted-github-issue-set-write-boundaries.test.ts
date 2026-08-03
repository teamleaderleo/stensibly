import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InMemoryGitHubProviderReceiptStore,
  type GitHubProviderReceiptStore,
} from "../src/github-issue-provider.ts";
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
  goal: "Pin private hosted GitHub set-write boundaries.",
  boundaries: "One accepted repository and exact label mutation evidence.",
  evidenceAndHandoff: "Retain durable receipts and independent readback.",
  escalation: "Reconcile ambiguous effects before retry.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_github_set_write_boundaries",
  project,
  snapshot,
  sourceRevision: "main@hosted-github-set-write-boundaries",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-02T00:00:00.000Z",
};

describe("private hosted GitHub issue set-write boundaries", () => {
  test("treats a failed service-owned second read as ambiguous and never redispatches", async () => {
    const receipts = new InMemoryGitHubProviderReceiptStore();
    let issueReads = 0;
    let mutationCalls = 0;
    let issue = apiIssue();

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
        if (issueReads <= 2) return Response.json(issue);
        return Response.json(
          { message: "service-owned readback unavailable" },
          { status: 404 },
        );
      }
      if (method === "POST" && url.endsWith(`/issues/${issueNumber}/labels`)) {
        mutationCalls += 1;
        issue = apiIssue({
          labels: [{ name: "area:github" }],
          updated_at: "2026-08-02T00:00:02Z",
        });
        return Response.json(issue.labels, {
          headers: { "x-github-request-id": "WRITE:LABELS:SECOND-READ" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };

    const mounted = mountHostedGitHubIssueProviderFromEnv(
      ledgerWithReceipts(receipts),
      providerEnv(true),
      { fetch: fetcher as unknown as typeof fetch, now: () => fixedNow },
    );
    const input = {
      project,
      repository: repositoryFullName,
      actorId: "api-token:second-read-boundary",
      clientId: "mcp:api-token:second-read-boundary",
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "hosted-label-second-read-boundary-1",
    };

    await expect(mounted.addIssueLabels!(input)).rejects.toThrow(
      "requires reconciliation before retry",
    );
    expect(issueReads).toBe(3);
    expect(mutationCalls).toBe(1);
    expect(await receipts.getGitHubProviderReceipt(
      project,
      input.idempotencyKey,
    )).toMatchObject({
      state: "pending_reconciliation",
      operation: "github_add_issue_labels",
      target: `${repositoryFullName}#${issueNumber}:labels`,
      result: null,
      verification: {
        state: "failed",
        sourceRevision: null,
      },
      error: {
        code: "ambiguous_provider_outcome",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });

    await expect(mounted.addIssueLabels!(input)).rejects.toThrow(
      "requires reconciliation before retry",
    );
    expect(issueReads).toBe(3);
    expect(mutationCalls).toBe(1);
  });

  test("keeps all private set-write methods absent when the exact flag is false", () => {
    let fetchCalls = 0;
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      providerEnv(false),
      {
        fetch: (async () => {
          fetchCalls += 1;
          throw new Error("provider call is outside flag-off composition");
        }) as unknown as typeof fetch,
        now: () => fixedNow,
      },
    );

    expect(mounted).not.toHaveProperty("addIssueLabels");
    expect(mounted).not.toHaveProperty("removeIssueLabel");
    expect(mounted).not.toHaveProperty("addIssueAssignees");
    expect(mounted).not.toHaveProperty("removeIssueAssignees");
    expect(fetchCalls).toBe(0);
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
    node_id: "I_hosted_set_write_boundary_1001",
    repository_url: "https://api.github.com/repos/teamleaderleo/stensibly",
    title: "Durable hosted set write boundary",
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
