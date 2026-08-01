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
const commitSha = "d".repeat(40);
const runId = 30691104156;
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;

describe("guarded GitHub Actions delegated-read MCP dispatch", () => {
  test("advertises, replays, and dispatches only run and job metadata additions", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const mounted = mountedLedger(calls);
    const server = createMcpServer(mounted.ledger, {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "github-actions-delegated-mounted", version: "0.0.1" },
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

      for (const name of [
        "fetch_commit_workflow_runs",
        "fetch_workflow_run_jobs",
      ]) {
        const capability = await call<{
          delegatedDispatchEnabled: boolean;
          recommendedAction: string;
        }>(client, "github_get_tool", { name });
        expect(capability.delegatedDispatchEnabled).toBe(true);
        expect(capability.recommendedAction).toContain("github_call_tool");
      }
      for (const name of [
        "fetch_workflow_job_steps",
        "fetch_workflow_job_logs",
      ]) {
        const capability = await call<{
          delegatedDispatchEnabled: boolean;
        }>(client, "github_get_tool", { name });
        expect(capability.delegatedDispatchEnabled).toBe(false);
      }

      const runArguments = {
        project,
        repository,
        tool: "fetch_commit_workflow_runs",
        arguments: { commit_sha: commitSha },
        catalogueFingerprint,
      };
      const runReceipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        runArguments,
      );
      const replayReceipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        runArguments,
      );
      expect(runReceipt).toMatchObject({
        project,
        repositoryFullName: repository,
        tool: "fetch_commit_workflow_runs",
        actorId: "api-token:delegated-actions-token",
        clientId: "mcp:api-token:delegated-actions-token",
        result: { commitSha },
      });
      expect(replayReceipt).toEqual(runReceipt);

      const jobReceipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        {
          project,
          repository,
          tool: "fetch_workflow_run_jobs",
          arguments: { run_id: runId },
          catalogueFingerprint,
        },
      );
      expect(jobReceipt).toMatchObject({
        project,
        repositoryFullName: repository,
        tool: "fetch_workflow_run_jobs",
        actorId: "api-token:delegated-actions-token",
        clientId: "mcp:api-token:delegated-actions-token",
        result: { runId },
      });

      expect(calls).toEqual([
        {
          project,
          repository,
          tool: "fetch_commit_workflow_runs",
          arguments: { commit_sha: commitSha },
          actorId: "api-token:delegated-actions-token",
          clientId: "mcp:api-token:delegated-actions-token",
          catalogueFingerprint,
        },
        {
          project,
          repository,
          tool: "fetch_commit_workflow_runs",
          arguments: { commit_sha: commitSha },
          actorId: "api-token:delegated-actions-token",
          clientId: "mcp:api-token:delegated-actions-token",
          catalogueFingerprint,
        },
        {
          project,
          repository,
          tool: "fetch_workflow_run_jobs",
          arguments: { run_id: runId },
          actorId: "api-token:delegated-actions-token",
          clientId: "mcp:api-token:delegated-actions-token",
          catalogueFingerprint,
        },
      ]);

      for (const { argumentsValue, errorField } of [
        {
          argumentsValue: {
            project,
            repository,
            tool: "fetch_commit_workflow_runs",
            arguments: { commit_sha: "D".repeat(40) },
            catalogueFingerprint,
          },
          errorField: "commit_sha",
        },
        {
          argumentsValue: {
            project,
            repository,
            tool: "fetch_workflow_run_jobs",
            arguments: { run_id: 0 },
            catalogueFingerprint,
          },
          errorField: "run_id",
        },
        {
          argumentsValue: {
            project,
            repository,
            tool: "fetch_workflow_job_logs",
            arguments: { job_id: 91345873454 },
            catalogueFingerprint,
          },
          errorField: "tool",
        },
      ]) {
        const denied = await client.callTool({
          name: "github_call_tool",
          arguments: argumentsValue,
        });
        expect(denied.isError).toBe(true);
        expect(textContent(denied)).toContain(errorField);
        expect(calls).toHaveLength(3);
      }

      const stale = await client.callTool({
        name: "github_call_tool",
        arguments: {
          ...runArguments,
          catalogueFingerprint: `sha256:${"0".repeat(64)}`,
        },
      });
      expect(stale.isError).toBe(true);
      expect(textContent(stale)).toContain("catalogue fingerprint is stale");
      expect(calls).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
      mounted.store.close();
    }
  });

  test("rejects reordered or decorated hosted tool declarations", () => {
    for (const tools of [
      [
        "fetch_file",
        "get_repo",
        "get_pr_info",
        "get_pr_diff",
        "fetch_commit_workflow_runs",
        "fetch_workflow_run_jobs",
      ],
      Object.assign([...hostedGitHubDelegatedReadTools], { extra: true }),
    ]) {
      const store = new StensiblyStore(":memory:");
      const ledger = new SqliteWorkLedger(store);
      const provider: HostedGitHubDelegatedReadProvider = {
        delegatedGitHubReadTools:
          tools as unknown as typeof hostedGitHubDelegatedReadTools,
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
      const result = input.tool === "fetch_commit_workflow_runs"
        ? Object.freeze({ commitSha: input.arguments.commit_sha })
        : Object.freeze({ runId: input.arguments.run_id });
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_actions_dispatch",
        installationId: "98765",
        bindingId: "ghbind_actions_dispatch",
        attachmentId: "attach_actions_dispatch",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "ACTIONS:PUBLIC:1",
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
    tokenId: "delegated-actions-token",
    name: "delegated actions test",
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
