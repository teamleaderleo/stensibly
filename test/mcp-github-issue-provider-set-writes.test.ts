import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import {
  withGitHubIssueProviderSetWriteService,
  type GitHubIssueProviderSetWriteService,
} from "../src/github-issue-provider-set-write-service.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const issueNumber = 525;

describe("public GitHub issue set writes", () => {
  test("discovers and dispatches all four typed actions with authenticated identity", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const service: GitHubIssueProviderSetWriteService = {
      async addIssueLabels(input) {
        calls.push({ operation: "add_labels", ...input });
        return receipt(
          "github_add_issue_labels",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async removeIssueLabel(input) {
        calls.push({ operation: "remove_label", ...input });
        return receipt(
          "github_remove_issue_label",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async addIssueAssignees(input) {
        calls.push({ operation: "add_assignees", ...input });
        return receipt(
          "github_add_issue_assignees",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async removeIssueAssignees(input) {
        calls.push({ operation: "remove_assignees", ...input });
        return receipt(
          "github_remove_issue_assignees",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
    };
    const ledger = withGitHubIssueProviderSetWriteService(
      new SqliteWorkLedger(store),
      service,
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-set-write-public-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      for (const name of addToolNames) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        expect(tool?.annotations?.idempotentHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);
      }
      for (const name of removeToolNames) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        expect(tool?.annotations?.idempotentHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(true);
      }

      const addedLabels = await call<GitHubProviderReceipt>(
        client,
        "github_add_issue_labels",
        {
          project,
          repository,
          issueNumber,
          labels: ["area:github", "priority:p0"],
          idempotencyKey: "public-label-add-1",
        },
      );
      expect(addedLabels.operation).toBe("github_add_issue_labels");

      const removedLabel = await call<GitHubProviderReceipt>(
        client,
        "github_remove_issue_label",
        {
          project,
          repository,
          issueNumber,
          label: "priority:p0",
          idempotencyKey: "public-label-remove-1",
        },
      );
      expect(removedLabel.operation).toBe("github_remove_issue_label");

      const addedAssignees = await call<GitHubProviderReceipt>(
        client,
        "github_add_issue_assignees",
        {
          project,
          repository,
          issueNumber,
          assignees: ["teamleaderleo", "juniper-bot"],
          idempotencyKey: "public-assignee-add-1",
        },
      );
      expect(addedAssignees.operation).toBe("github_add_issue_assignees");

      const removedAssignees = await call<GitHubProviderReceipt>(
        client,
        "github_remove_issue_assignees",
        {
          project,
          repository,
          issueNumber,
          assignees: ["juniper-bot"],
          idempotencyKey: "public-assignee-remove-1",
        },
      );
      expect(removedAssignees.operation).toBe("github_remove_issue_assignees");

      expect(calls).toEqual([
        {
          operation: "add_labels",
          ...context(),
          issueNumber,
          labels: ["area:github", "priority:p0"],
          idempotencyKey: "public-label-add-1",
        },
        {
          operation: "remove_label",
          ...context(),
          issueNumber,
          label: "priority:p0",
          idempotencyKey: "public-label-remove-1",
        },
        {
          operation: "add_assignees",
          ...context(),
          issueNumber,
          assignees: ["teamleaderleo", "juniper-bot"],
          idempotencyKey: "public-assignee-add-1",
        },
        {
          operation: "remove_assignees",
          ...context(),
          issueNumber,
          assignees: ["juniper-bot"],
          idempotencyKey: "public-assignee-remove-1",
        },
      ]);

      const overLimit = await client.callTool({
        name: "github_add_issue_assignees",
        arguments: {
          project,
          repository,
          issueNumber,
          assignees: Array.from(
            { length: 11 },
            (_, index) => `reviewer-${index + 1}`,
          ),
          idempotencyKey: "public-assignee-over-limit",
        },
      });
      expect(overLimit.isError).toBe(true);
      expect(calls).toHaveLength(4);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("denies a read-only principal before set-write dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let calls = 0;
    const ledger = withGitHubIssueProviderSetWriteService(
      new SqliteWorkLedger(store),
      {
        async addIssueLabels(input) {
          calls += 1;
          return receipt(
            "github_add_issue_labels",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async removeIssueLabel(input) {
          calls += 1;
          return receipt(
            "github_remove_issue_label",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async addIssueAssignees(input) {
          calls += 1;
          return receipt(
            "github_add_issue_assignees",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async removeIssueAssignees(input) {
          calls += 1;
          return receipt(
            "github_remove_issue_assignees",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
      },
    );
    const server = createMcpServer(ledger, { principal: readPrincipal() });
    const client = new Client(
      { name: "github-set-write-denial-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "github_add_issue_labels",
        arguments: {
          project,
          repository,
          issueNumber,
          labels: ["must-not-dispatch"],
          idempotencyKey: "read-only-label-denial",
        },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("require write scope");
      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

const addToolNames = [
  "github_add_issue_assignees",
  "github_add_issue_labels",
] as const;
const removeToolNames = [
  "github_remove_issue_assignees",
  "github_remove_issue_label",
] as const;

function context() {
  return {
    project,
    repository,
    actorId: "api-token:github-set-write-token",
    clientId: "mcp:api-token:github-set-write-token",
  };
}

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "github-set-write-token",
    name: "GitHub set-write test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "github-set-read-token",
    name: "GitHub set read-only test",
    scopes: ["read"],
    projects: [project],
  };
}

function receipt(
  operation: GitHubIssueProviderOperation,
  idempotencyKey: string,
  actorId: string,
  clientId: string,
): GitHubProviderReceipt {
  const field = operation.includes("label") ? "labels" : "assignees";
  return {
    version: 1,
    id: `ghop_${idempotencyKey}`,
    project,
    provider: "github",
    repositoryFullName: repository,
    operation,
    target: `${repository}#${issueNumber}:${field}`,
    actorId,
    clientId,
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
    providerRequestId: "github-request-set-1",
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

async function call<T>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) throw new Error(textContent(result));
  return JSON.parse(textContent(result)) as T;
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result had no content");
  }
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return first.text;
}
