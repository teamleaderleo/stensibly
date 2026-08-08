import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  withGitHubPublicationProviderWriteService,
  type GitHubPublicationProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type {
  GitHubProviderReceipt,
  GitHubPublicationProviderOperation,
} from "../src/github-provider-contracts.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

describe("GitHub publication provider MCP surface", () => {
  test("derives stable principal identity and forwards guarded branch and PR inputs", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const service: GitHubPublicationProviderWriteService = {
      async createBranch(input) {
        calls.push({ operation: "branch", ...input });
        return receipt(
          "github_create_branch",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async createPullRequest(input) {
        calls.push({ operation: "pull_request", ...input });
        return receipt(
          "github_create_pull_request",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
    };
    const ledger = withGitHubPublicationProviderWriteService(
      new SqliteWorkLedger(store),
      service,
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-publication-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      for (const name of [
        "github_create_branch",
        "github_create_pull_request",
      ]) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        expect(tool?.annotations?.idempotentHint).toBe(true);
        expect(tool?.annotations?.destructiveHint).toBe(false);
      }

      await call(client, "github_create_branch", {
        project,
        repository,
        branch: "codex/publication",
        fromCommitSha: baseSha,
        idempotencyKey: "mcp-publication-branch",
      });
      await call(client, "github_create_pull_request", {
        project,
        repository,
        title: "Guarded publication",
        body: "Bounded publication body",
        head: "codex/publication",
        base: "main",
        expectedHeadSha: headSha,
        expectedBaseSha: baseSha,
        draft: true,
        idempotencyKey: "mcp-publication-pr",
      });

      expect(calls).toEqual([
        {
          operation: "branch",
          project,
          repository,
          actorId: "api-token:oauth-grant-publication",
          clientId: "mcp:api-token:oauth-grant-publication",
          branch: "codex/publication",
          fromCommitSha: baseSha,
          idempotencyKey: "mcp-publication-branch",
        },
        {
          operation: "pull_request",
          project,
          repository,
          actorId: "api-token:oauth-grant-publication",
          clientId: "mcp:api-token:oauth-grant-publication",
          title: "Guarded publication",
          body: "Bounded publication body",
          head: "codex/publication",
          base: "main",
          expectedHeadSha: headSha,
          expectedBaseSha: baseSha,
          draft: true,
          idempotencyKey: "mcp-publication-pr",
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("rejects read-only principals before provider dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let dispatches = 0;
    const ledger = withGitHubPublicationProviderWriteService(
      new SqliteWorkLedger(store),
      {
        async createBranch(input) {
          dispatches += 1;
          return receipt(
            "github_create_branch",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
        async createPullRequest(input) {
          dispatches += 1;
          return receipt(
            "github_create_pull_request",
            input.idempotencyKey,
            input.actorId,
            input.clientId,
          );
        },
      },
    );
    const server = createMcpServer(ledger, { principal: readPrincipal() });
    const client = new Client(
      { name: "github-publication-denial", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "github_create_branch",
        arguments: {
          project,
          repository,
          branch: "codex/denied",
          fromCommitSha: baseSha,
          idempotencyKey: "mcp-publication-denied",
        },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("require write scope");
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
    tokenId: "publication-write-token",
    authorizationId: "oauth-grant-publication",
    name: "GitHub publication test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "publication-read-token",
    name: "GitHub publication read-only test",
    scopes: ["read"],
    projects: [project],
  };
}

function receipt(
  operation: GitHubPublicationProviderOperation,
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
    target: `${repository}:publication`,
    actorId,
    clientId,
    connectionId: "ghconn_publication",
    installationId: "152263678",
    bindingId: "ghbind_publication",
    attachmentId: "attach_publication",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey,
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:01.000Z",
    providerRequestId: "PUBLICATION:TEST",
    result: null,
    verification: {
      state: "passed",
      checkedAt: "2026-08-09T00:00:01.000Z",
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
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
