import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  withGitHubRepositoryFileWriteService,
  type GitHubRepositoryFileWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const branch = "codex/file-publication";
const parentSha = "a".repeat(40);
const blobSha = "b".repeat(40);

describe("GitHub repository-file MCP surface", () => {
  test("forwards bounded create/update inputs and returns actor-bound receipts", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const receipts = new Map<string, GitHubRepositoryWriteReceipt>();
    const service: GitHubRepositoryFileWriteService = {
      async createRepositoryFile(input) {
        calls.push({ operation: "create", ...input });
        const result = receipt(
          "create_file",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
        receipts.set(input.idempotencyKey, result);
        return result;
      },
      async updateRepositoryFile(input) {
        calls.push({ operation: "update", ...input });
        const result = receipt(
          "update_file",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
        receipts.set(input.idempotencyKey, result);
        return result;
      },
    };
    const ledger = Object.assign(
      withGitHubRepositoryFileWriteService(new SqliteWorkLedger(store), service),
      {
        async getRepositoryWriteReceipt(
          requestedProject: string,
          idempotencyKey: string,
        ) {
          return requestedProject === project
            ? receipts.get(idempotencyKey) ?? null
            : null;
        },
      },
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-file-publication-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      for (const name of ["github_create_file", "github_update_file"]) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        expect(tool?.annotations?.idempotentHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);
      }

      await call(client, "github_create_file", {
        project,
        repository,
        path: "docs/mcp-v2.md",
        branch,
        expectedParentSha: parentSha,
        content: "MCP v2\n",
        message: "Add MCP v2 note",
        idempotencyKey: "mcp-file-create",
      });
      await call(client, "github_update_file", {
        project,
        repository,
        path: "docs/mcp-v2.md",
        branch,
        expectedParentSha: parentSha,
        contentSha: blobSha,
        content: "MCP v2 is live\n",
        message: "Update MCP v2 note",
        idempotencyKey: "mcp-file-update",
      });
      const reconciled = await client.callTool({
        name: "get_github_repository_write_receipt",
        arguments: {
          project,
          repository,
          idempotencyKey: "mcp-file-create",
        },
      });
      expect(JSON.parse(textContent(reconciled))).toMatchObject({
        state: "succeeded",
        operation: "create_file",
        idempotencyKey: "mcp-file-create",
      });
      expect(calls).toEqual([
        {
          operation: "create",
          project,
          repository,
          actorId: "api-token:oauth-grant-file-publication",
          clientId: "mcp:api-token:oauth-grant-file-publication",
          path: "docs/mcp-v2.md",
          branch,
          expectedParentSha: parentSha,
          content: "MCP v2\n",
          message: "Add MCP v2 note",
          idempotencyKey: "mcp-file-create",
        },
        {
          operation: "update",
          project,
          repository,
          actorId: "api-token:oauth-grant-file-publication",
          clientId: "mcp:api-token:oauth-grant-file-publication",
          path: "docs/mcp-v2.md",
          branch,
          expectedParentSha: parentSha,
          contentSha: blobSha,
          content: "MCP v2 is live\n",
          message: "Update MCP v2 note",
          idempotencyKey: "mcp-file-update",
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("rejects oversized UTF-8 input before mounted service dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let dispatches = 0;
    const ledger = withGitHubRepositoryFileWriteService(
      new SqliteWorkLedger(store),
      {
        async createRepositoryFile(input) {
          dispatches += 1;
          return receipt(
            "create_file",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async updateRepositoryFile(input) {
          dispatches += 1;
          return receipt(
            "update_file",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
      },
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-file-publication-bound", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "github_create_file",
        arguments: {
          project,
          repository,
          path: "docs/oversized.md",
          branch,
          expectedParentSha: parentSha,
          content: "é".repeat(131_073),
          message: "Reject oversized content",
          idempotencyKey: "mcp-file-oversized",
        },
      });
      expect(result.isError).toBe(true);
      expect(dispatches).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "file-publication-write-token",
    authorizationId: "oauth-grant-file-publication",
    name: "GitHub file publication test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function receipt(
  operation: "create_file" | "update_file",
  idempotencyKey: string,
  actorId: string,
  clientId: string,
): GitHubRepositoryWriteReceipt {
  return {
    version: 1,
    id: `ghrw_${idempotencyKey}`,
    project,
    repositoryFullName: repository,
    targetRef: branch,
    path: "docs/mcp-v2.md",
    operation,
    expectedParentSha: parentSha,
    requestSha256: `sha256:${"c".repeat(64)}`,
    payloadSha256: `sha256:${"d".repeat(64)}`,
    actorId,
    clientId,
    idempotencyKey,
    state: "succeeded",
    dispatchCount: 1,
    createdAt: "2026-08-09T04:00:00.000Z",
    updatedAt: "2026-08-09T04:00:01.000Z",
    verified: null,
    error: null,
  };
}

async function call(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<void> {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) throw new Error(textContent(result));
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
