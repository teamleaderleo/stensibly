import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  GitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import {
  withGitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

describe("GitHub issue provider write composition", () => {
  test("binds the typed write service onto a ledger-compatible target", async () => {
    const calls: unknown[] = [];
    const target = { kind: "target" };
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        calls.push(input);
        return receipt("github_create_issue", input.idempotencyKey);
      },
      async updateIssue(input) {
        calls.push(input);
        return receipt("github_update_issue", input.idempotencyKey);
      },
      async addIssueComment(input) {
        calls.push(input);
        return receipt("github_add_issue_comment", input.idempotencyKey);
      },
    };

    const composed = withGitHubIssueProviderWriteService(target, service);
    expect(composed).toBe(target);

    await composed.createIssue({
      ...context(),
      title: "Create through the provider seam",
      idempotencyKey: "write-seam-create-1",
    });
    await composed.updateIssue({
      ...context(),
      issueNumber: 921,
      expectedSourceRevision: "github-rest:I_issue_921:rev-1",
      title: "Update through the provider seam",
      idempotencyKey: "write-seam-update-1",
    });
    await composed.addIssueComment({
      ...context(),
      issueNumber: 921,
      body: "Comment through the provider seam",
      idempotencyKey: "write-seam-comment-1",
    });

    expect(calls).toEqual([
      {
        ...context(),
        title: "Create through the provider seam",
        idempotencyKey: "write-seam-create-1",
      },
      {
        ...context(),
        issueNumber: 921,
        expectedSourceRevision: "github-rest:I_issue_921:rev-1",
        title: "Update through the provider seam",
        idempotencyKey: "write-seam-update-1",
      },
      {
        ...context(),
        issueNumber: 921,
        body: "Comment through the provider seam",
        idempotencyKey: "write-seam-comment-1",
      },
    ]);
  });

  test("keeps write actions outside the public MCP manifest until hosted execution is mounted", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      {
        async createIssue(input) {
          return receipt("github_create_issue", input.idempotencyKey);
        },
        async updateIssue(input) {
          return receipt("github_update_issue", input.idempotencyKey);
        },
        async addIssueComment(input) {
          return receipt("github_add_issue_comment", input.idempotencyKey);
        },
      },
    );
    const server = createMcpServer(ledger);
    const client = new Client(
      { name: "github-write-composition-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).not.toContain("github_create_issue");
      expect(names).not.toContain("github_update_issue");
      expect(names).not.toContain("github_add_issue_comment");
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function context() {
  return {
    project: "stensibly",
    repository: "teamleaderleo/stensibly",
    actorId: "actor_lynx",
    clientId: "client_github_only",
  };
}

function receipt(
  operation: GitHubIssueProviderOperation,
  idempotencyKey: string,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: `ghop_${idempotencyKey}`,
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation,
    target: "teamleaderleo/stensibly#921",
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey,
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    providerRequestId: "github-request-1",
    result: null,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T00:00:01.000Z",
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}
