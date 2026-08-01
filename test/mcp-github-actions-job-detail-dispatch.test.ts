import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import type {
  HostedGitHubDelegatedReadInput,
  HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import {
  hostedGitHubDelegatedReadJobDetailTools,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "scrapbook";
const repository = "teamleaderleo/stensibly";
const jobId = 91345873454;
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;

describe("opt-in guarded GitHub Actions job-detail MCP dispatch", () => {
  test("advertises and dispatches steps and logs through the expanded declaration", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const mounted = mountedLedger(calls);
    const server = createMcpServer(mounted.ledger, {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "github-actions-job-detail-mounted", version: "0.0.1" },
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
        delegatedTools: [...hostedGitHubDelegatedReadJobDetailTools],
      });

      for (const name of [
        "fetch_workflow_job_steps",
        "fetch_workflow_job_logs",
      ]) {
        const capability = await call<{
          delegatedDispatchEnabled: boolean;
          recommendedAction: string;
        }>(client, "github_get_tool", { name });
        expect(capability.delegatedDispatchEnabled).toBe(true);
        expect(capability.recommendedAction).toContain("github_call_tool");
      }

      for (const tool of [
        "fetch_workflow_job_steps",
        "fetch_workflow_job_logs",
      ] as const) {
        const receipt = await call<Record<string, unknown>>(
          client,
          "github_call_tool",
          {
            project,
            repository,
            tool,
            arguments: { job_id: jobId },
            catalogueFingerprint,
          },
        );
        expect(receipt).toMatchObject({
          project,
          repositoryFullName: repository,
          tool,
          actorId: "api-token:delegated-actions-job-detail-token",
          clientId: "mcp:api-token:delegated-actions-job-detail-token",
        });
      }
      expect(calls.map((call) => call.tool)).toEqual([
        "fetch_workflow_job_steps",
        "fetch_workflow_job_logs",
      ]);
      expect(calls.every((call) => call.arguments.job_id === jobId)).toBe(true);

      const malformed = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository,
          tool: "fetch_workflow_job_logs",
          arguments: { job_id: 0 },
          catalogueFingerprint,
        },
      });
      expect(malformed.isError).toBe(true);
      expect(calls).toHaveLength(2);

      const unavailable = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository,
          tool: "fetch_workflow_run_artifacts",
          arguments: { run_id: 1 },
          catalogueFingerprint,
        },
      });
      expect(unavailable.isError).toBe(true);
      expect(calls).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
      mounted.store.close();
    }
  });

  test("rejects a reordered expanded declaration", () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const provider: HostedGitHubDelegatedReadProvider = {
      delegatedGitHubReadTools: [
        ...hostedGitHubDelegatedReadJobDetailTools,
      ].reverse() as unknown as typeof hostedGitHubDelegatedReadJobDetailTools,
      async callGitHubDelegatedRead() {
        throw new Error("must not dispatch");
      },
    };
    try {
      expect(() => createMcpServer(
        Object.assign(ledger, provider),
        { principal: readPrincipal() },
      )).toThrow("tool declaration is invalid");
    } finally {
      store.close();
    }
  });
});

function mountedLedger(calls: HostedGitHubDelegatedReadInput[]) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    delegatedGitHubReadTools: hostedGitHubDelegatedReadJobDetailTools,
    async callGitHubDelegatedRead(input) {
      if (input.catalogueFingerprint !== catalogueFingerprint) {
        throw new Error("GitHub delegated catalogue fingerprint is stale");
      }
      calls.push(input);
      const result = input.tool === "fetch_workflow_job_steps"
        ? Object.freeze({
          jobId: input.arguments.job_id,
          totalCount: 0,
          steps: Object.freeze([]),
        })
        : Object.freeze({
          jobId: input.arguments.job_id,
          byteCount: 7,
          lineCount: 1,
          text: "bounded",
        });
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_actions_job_detail_dispatch",
        installationId: "98765",
        bindingId: "ghbind_actions_job_detail_dispatch",
        attachmentId: "attach_actions_job_detail_dispatch",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "ACTIONS:PUBLIC:JOB-DETAIL",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result,
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
    tokenId: "delegated-actions-job-detail-token",
    name: "delegated actions job detail test",
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
