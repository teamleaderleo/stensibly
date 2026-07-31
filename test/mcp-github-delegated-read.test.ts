import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import type {
  HostedGitHubDelegatedReadInput,
  HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "scrapbook";
const repository = "teamleaderleo/stensibly";
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
const commitSha = "a".repeat(40);

describe("guarded GitHub delegated-read MCP dispatch", () => {
  test("omits public dispatch when the backend has no mounted delegated provider", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(new SqliteWorkLedger(store));
    const client = clientFor("github-delegated-absent");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("github_call_tool");
      const toolsets = await call<{
        delegatedDispatchEnabled: boolean;
        delegatedTools: string[];
      }>(client, "github_list_toolsets", {});
      expect(toolsets).toMatchObject({
        delegatedDispatchEnabled: false,
        delegatedTools: [],
      });
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("registers only the two enabled reads and derives principal identity", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const mounted = mountedLedger(calls);
    const server = createMcpServer(mounted.ledger, {
      principal: readPrincipal([project]),
    });
    const client = clientFor("github-delegated-mounted");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("github_call_tool");

      const toolsets = await call<{
        delegatedDispatchEnabled: boolean;
        delegatedTools: string[];
      }>(client, "github_list_toolsets", {});
      expect(toolsets).toMatchObject({
        delegatedDispatchEnabled: true,
        delegatedTools: ["get_repo", "fetch_file"],
      });

      const repositoryCapability = await call<{
        delegatedDispatchEnabled: boolean;
        recommendedAction: string;
      }>(client, "github_get_tool", { name: "get_repo" });
      expect(repositoryCapability.delegatedDispatchEnabled).toBe(true);
      expect(repositoryCapability.recommendedAction).toContain("github_call_tool");
      const disabledCapability = await call<{
        delegatedDispatchEnabled: boolean;
      }>(client, "github_get_tool", { name: "get_pr_info" });
      expect(disabledCapability.delegatedDispatchEnabled).toBe(false);

      const receipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        {
          project,
          repository,
          tool: "fetch_file",
          arguments: { path: "README.md", ref: commitSha },
          catalogueFingerprint,
        },
      );
      expect(receipt).toMatchObject({
        project,
        repositoryFullName: repository,
        tool: "fetch_file",
        actorId: "api-token:delegated-read-token",
        clientId: "mcp:api-token:delegated-read-token",
        catalogueFingerprint,
      });
      expect(calls).toEqual([{
        project,
        repository,
        tool: "fetch_file",
        arguments: { path: "README.md", ref: commitSha },
        actorId: "api-token:delegated-read-token",
        clientId: "mcp:api-token:delegated-read-token",
        catalogueFingerprint,
      }]);

      const disabled = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository,
          tool: "get_pr_info",
          arguments: { pr_number: 1 },
          catalogueFingerprint,
        },
      });
      expect(disabled.isError).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      mounted.store.close();
    }
  });

  test("rejects missing scope and project authority before delegated provider activity", async () => {
    for (const principal of [
      undefined,
      readPrincipal(["another-project"]),
      {
        ...readPrincipal([project]),
        scopes: [] as TokenPrincipal["scopes"],
      },
    ]) {
      const calls: HostedGitHubDelegatedReadInput[] = [];
      const mounted = mountedLedger(calls);
      const server = createMcpServer(
        mounted.ledger,
        principal ? { principal } : {},
      );
      const client = clientFor("github-delegated-denied");
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const denied = await client.callTool({
          name: "github_call_tool",
          arguments: {
            project,
            repository,
            tool: "get_repo",
            arguments: {},
            catalogueFingerprint,
          },
        });
        expect(denied.isError).toBe(true);
        expect(calls).toHaveLength(0);
      } finally {
        await client.close();
        await server.close();
        mounted.store.close();
      }
    }
  });
});

function mountedLedger(calls: HostedGitHubDelegatedReadInput[]) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    async callGitHubDelegatedRead(input) {
      calls.push(input);
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_public_dispatch",
        installationId: "98765",
        bindingId: "ghbind_public_dispatch",
        attachmentId: "attach_public_dispatch",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "REQ:PUBLIC:1",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result: Object.freeze({ path: "README.md", ref: commitSha }),
      });
    },
  };
  return {
    store,
    ledger: Object.assign(ledger, provider),
  };
}

function readPrincipal(projects: string[]): TokenPrincipal {
  return {
    tokenId: "delegated-read-token",
    name: "delegated read test",
    scopes: ["read"],
    projects,
  };
}

function clientFor(name: string): Client {
  return new Client(
    { name, version: "0.0.1" },
    { capabilities: {} },
  );
}

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
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
