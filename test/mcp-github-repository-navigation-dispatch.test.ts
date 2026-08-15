import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadJobDetailTools,
  type HostedGitHubDelegatedReadInput,
  type HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "scrapbook";
const repository = "teamleaderleo/stensibly";
const commitSha = "a".repeat(40);
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;

describe("guarded GitHub repository navigation MCP dispatch", () => {
  test("advertises and dispatches immutable directory and exact ref reads", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const mounted = mountedLedger(calls);
    const server = createMcpServer(mounted.ledger, {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "github-repository-navigation-mounted", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const toolsets = await call<{
        delegatedDispatchEnabled: boolean;
        delegatedTools: string[];
      }>(client, "github_list_toolsets", {});
      expect(toolsets.delegatedDispatchEnabled).toBe(true);
      expect(toolsets.delegatedTools).toContain("list_directory");
      expect(toolsets.delegatedTools).toContain("resolve_ref");

      for (const name of ["list_directory", "resolve_ref"]) {
        const capability = await call<{
          delegatedDispatchEnabled: boolean;
          recommendedAction: string;
        }>(client, "github_get_tool", { name });
        expect(capability.delegatedDispatchEnabled).toBe(true);
        expect(capability.recommendedAction).toContain("github_call_tool");
      }

      await call(client, "github_call_tool", {
        project,
        repository,
        tool: "list_directory",
        arguments: { path: "", ref: commitSha },
        catalogueFingerprint,
      });
      await call(client, "github_call_tool", {
        project,
        repository,
        tool: "resolve_ref",
        arguments: { ref: "refs/heads/main" },
        catalogueFingerprint,
      });

      expect(calls.map((entry) => entry.tool)).toEqual([
        "list_directory",
        "resolve_ref",
      ]);
      expect(calls[0]?.arguments).toEqual({ path: "", ref: commitSha });
      expect(calls[1]?.arguments).toEqual({ ref: "refs/heads/main" });

      const shorthand = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository,
          tool: "resolve_ref",
          arguments: { ref: "main" },
          catalogueFingerprint,
        },
      });
      expect(shorthand.isError).toBe(true);
      expect(calls).toHaveLength(2);

      const mutableDirectory = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository,
          tool: "list_directory",
          arguments: { path: "src", ref: "main" },
          catalogueFingerprint,
        },
      });
      expect(mutableDirectory.isError).toBe(true);
      expect(calls).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
      mounted.store.close();
    }
  });
});

function mountedLedger(calls: HostedGitHubDelegatedReadInput[]) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    delegatedGitHubReadTools: hostedGitHubDelegatedReadJobDetailTools,
    async callGitHubDelegatedRead(input) {
      calls.push(input);
      const result = input.tool === "list_directory"
        ? Object.freeze({
          repositoryFullName: repository,
          path: input.arguments.path,
          commitSha: input.arguments.ref,
          entries: Object.freeze([]),
          truncated: false,
        })
        : Object.freeze({
          repositoryFullName: repository,
          ref: input.arguments.ref,
          refType: "branch",
          refObjectSha: commitSha,
          commitSha,
          peeledTagDepth: 0,
        });
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_navigation_dispatch",
        installationId: "98765",
        bindingId: "ghbind_navigation_dispatch",
        attachmentId: "attach_navigation_dispatch",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "NAV:PUBLIC",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result,
      });
    },
  };
  return { store, ledger: Object.assign(ledger, provider) };
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "delegated-navigation-token",
    name: "delegated navigation test",
    scopes: ["read"],
    projects: [project],
  };
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
