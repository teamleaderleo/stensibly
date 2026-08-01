import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import type {
  HostedGitHubDelegatedReadInput,
  HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import {
  hostedGitHubDelegatedReadTools,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "scrapbook";
const repository = "teamleaderleo/stensibly";
const pullRequestNumber = 42;
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;

describe("guarded GitHub review-thread delegated-read MCP dispatch", () => {
  test("advertises and dispatches the exact bounded review-thread read", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const mounted = mountedLedger(calls);
    const server = createMcpServer(mounted.ledger, {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "github-review-thread-delegated-mounted", version: "0.0.1" },
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
      expect(toolsets).toMatchObject({
        delegatedDispatchEnabled: true,
        delegatedTools: [...hostedGitHubDelegatedReadTools],
      });
      expect(toolsets.delegatedTools)
        .toContain("list_pull_request_review_threads");

      const capability = await call<{
        delegatedDispatchEnabled: boolean;
        recommendedAction: string;
      }>(client, "github_get_tool", {
        name: "list_pull_request_review_threads",
      });
      expect(capability.delegatedDispatchEnabled).toBe(true);
      expect(capability.recommendedAction).toContain("github_call_tool");

      const receipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        {
          project,
          repository,
          tool: "list_pull_request_review_threads",
          arguments: { pr_number: pullRequestNumber },
          catalogueFingerprint,
        },
      );
      expect(receipt).toMatchObject({
        project,
        repositoryFullName: repository,
        tool: "list_pull_request_review_threads",
        actorId: "api-token:delegated-review-thread-token",
        clientId: "mcp:api-token:delegated-review-thread-token",
        result: {
          number: pullRequestNumber,
          threadCount: 0,
          commentCount: 0,
          threads: [],
        },
      });
      expect(calls).toEqual([{
        project,
        repository,
        tool: "list_pull_request_review_threads",
        arguments: { pr_number: pullRequestNumber },
        actorId: "api-token:delegated-review-thread-token",
        clientId: "mcp:api-token:delegated-review-thread-token",
        catalogueFingerprint,
      }]);

      for (const argumentsValue of [
        {
          project,
          repository,
          tool: "list_pull_request_review_threads",
          arguments: { pr_number: 0 },
          catalogueFingerprint,
        },
        {
          project,
          repository,
          tool: "fetch_workflow_job_logs",
          arguments: { job_id: 91345873454 },
          catalogueFingerprint,
        },
      ]) {
        const denied = await client.callTool({
          name: "github_call_tool",
          arguments: argumentsValue,
        });
        expect(denied.isError).toBe(true);
        expect(calls).toHaveLength(1);
      }
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
    delegatedGitHubReadTools: hostedGitHubDelegatedReadTools,
    async callGitHubDelegatedRead(input) {
      if (input.catalogueFingerprint !== catalogueFingerprint) {
        throw new Error("GitHub delegated catalogue fingerprint is stale");
      }
      calls.push(input);
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_review_thread_dispatch",
        installationId: "98765",
        bindingId: "ghbind_review_thread_dispatch",
        attachmentId: "attach_review_thread_dispatch",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "THREADS:PUBLIC:1",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result: Object.freeze({
          repositoryFullName: input.repository.toLowerCase(),
          number: input.arguments.pr_number,
          threadCount: 0,
          commentCount: 0,
          pageCount: 1,
          providerRequestIds: Object.freeze(["THREADS:PUBLIC:1"]),
          threads: Object.freeze([]),
        }),
      });
    },
  };
  return {
    store,
    ledger: Object.assign(ledger, provider),
  };
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "delegated-review-thread-token",
    name: "delegated review-thread test",
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
