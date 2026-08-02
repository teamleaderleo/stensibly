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
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const sourceRevision = `sha256:${"c".repeat(64)}`;

describe("GitHub issue provider write composition", () => {
  test("binds the typed write service onto a ledger-compatible target", async () => {
    const calls: unknown[] = [];
    const target = { kind: "target" };
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        calls.push(input);
        return receipt(
          "github_create_issue",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async updateIssue(input) {
        calls.push(input);
        return receipt(
          "github_update_issue",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async addIssueComment(input) {
        calls.push(input);
        return receipt(
          "github_add_issue_comment",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
    };

    const composed = withGitHubIssueProviderWriteService(target, service);
    expect(Object.is(composed, target)).toBe(true);

    await composed.createIssue({
      ...context(),
      title: "Create through the provider seam",
      idempotencyKey: "write-seam-create-1",
    });
    await composed.updateIssue({
      ...context(),
      issueNumber: 921,
      expectedSourceRevision: sourceRevision,
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
        expectedSourceRevision: sourceRevision,
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

  test("publishes typed writes and actor-bound durable receipt lookup", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const receipts = new Map<string, GitHubProviderReceipt>();
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        calls.push({ operation: "create", ...input });
        const value = receipt(
          "github_create_issue",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
        receipts.set(receiptKey(input.project, input.idempotencyKey), value);
        return value;
      },
      async updateIssue(input) {
        calls.push({ operation: "update", ...input });
        const value = receipt(
          "github_update_issue",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
        receipts.set(receiptKey(input.project, input.idempotencyKey), value);
        return value;
      },
      async addIssueComment(input) {
        calls.push({ operation: "comment", ...input });
        const value = receipt(
          "github_add_issue_comment",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
        receipts.set(receiptKey(input.project, input.idempotencyKey), value);
        return value;
      },
    };
    const ledger = Object.assign(
      withGitHubIssueProviderWriteService(new SqliteWorkLedger(store), service),
      {
        async getGitHubProviderReceipt(
          requestedProject: string,
          idempotencyKey: string,
        ) {
          return receipts.get(receiptKey(requestedProject, idempotencyKey)) ?? null;
        },
      },
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-write-public-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const name of [
        "get_github_provider_receipt",
        "github_add_issue_comment",
        "github_create_issue",
        "github_update_issue",
      ]) {
        expect(names).toContain(name);
      }
      expect(tools.tools.find((tool) =>
        tool.name === "get_github_provider_receipt"
      )?.annotations?.readOnlyHint).toBe(true);
      for (const name of [
        "github_add_issue_comment",
        "github_create_issue",
        "github_update_issue",
      ]) {
        const annotations = tools.tools.find((tool) => tool.name === name)?.annotations;
        expect(annotations?.idempotentHint).toBe(true);
        expect(annotations?.destructiveHint).toBe(false);
      }

      const created = await call<GitHubProviderReceipt>(
        client,
        "github_create_issue",
        {
          project,
          repository,
          title: "Create through public MCP",
          body: "Bounded issue body",
          idempotencyKey: "public-create-1",
        },
      );
      expect(created).toMatchObject({
        operation: "github_create_issue",
        actorId: "api-token:github-write-token",
        clientId: "mcp:api-token:github-write-token",
        idempotencyKey: "public-create-1",
      });
      expect(calls[0]).toMatchObject({
        operation: "create",
        project,
        repository,
        title: "Create through public MCP",
        body: "Bounded issue body",
        labels: [],
        assignees: [],
        actorId: "api-token:github-write-token",
        clientId: "mcp:api-token:github-write-token",
      });

      const updated = await call<GitHubProviderReceipt>(
        client,
        "github_update_issue",
        {
          project,
          repository,
          issueNumber: 921,
          expectedSourceRevision: sourceRevision,
          title: "Update through public MCP",
          state: "closed",
          stateReason: "completed",
          idempotencyKey: "public-update-1",
        },
      );
      expect(updated.operation).toBe("github_update_issue");

      const commented = await call<GitHubProviderReceipt>(
        client,
        "github_add_issue_comment",
        {
          project,
          repository,
          issueNumber: 921,
          body: "Comment through public MCP",
          idempotencyKey: "public-comment-1",
        },
      );
      expect(commented.operation).toBe("github_add_issue_comment");
      expect(calls).toHaveLength(3);

      const found = await call<GitHubProviderReceipt | null>(
        client,
        "get_github_provider_receipt",
        {
          project,
          repository,
          idempotencyKey: "public-create-1",
        },
      );
      expect(found).toEqual(created);

      receipts.set(
        receiptKey(project, "foreign-receipt"),
        receipt(
          "github_create_issue",
          "foreign-receipt",
          "api-token:foreign",
          "mcp:api-token:foreign",
        ),
      );
      expect(await call<GitHubProviderReceipt | null>(
        client,
        "get_github_provider_receipt",
        {
          project,
          repository,
          idempotencyKey: "foreign-receipt",
        },
      )).toBeNull();

      const malformed = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 0,
          body: "must not dispatch",
          idempotencyKey: "malformed-comment",
        },
      });
      expect(malformed.isError).toBe(true);
      expect(calls).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("denies a read-only principal before public write dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let calls = 0;
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      {
        async createIssue(input) {
          calls += 1;
          return receipt(
            "github_create_issue",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async updateIssue(input) {
          calls += 1;
          return receipt(
            "github_update_issue",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async addIssueComment(input) {
          calls += 1;
          return receipt(
            "github_add_issue_comment",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
      },
    );
    const server = createMcpServer(ledger, { principal: readPrincipal() });
    const client = new Client(
      { name: "github-write-denial-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "github_create_issue",
        arguments: {
          project,
          repository,
          title: "must not dispatch",
          idempotencyKey: "read-only-denial",
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

function context() {
  return {
    project,
    repository,
    actorId: "actor_lynx",
    clientId: "client_github_only",
  };
}

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "github-write-token",
    name: "GitHub write test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "github-read-token",
    name: "GitHub read-only test",
    scopes: ["read"],
    projects: [project],
  };
}

function receiptKey(requestedProject: string, idempotencyKey: string): string {
  return `${requestedProject}:${idempotencyKey}`;
}

function receipt(
  operation: GitHubIssueProviderOperation,
  idempotencyKey: string,
  actorId: string,
  clientId: string,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: `ghop_${idempotencyKey}`,
    project,
    provider: "github",
    repositoryFullName: repository,
    operation,
    target: `${repository}#921`,
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
