import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadTools,
  type HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const hidden = Symbol("escaped-mounted-tool");

test("rejects a symbol-decorated mounted declaration on its single descriptor read", () => {
  const target = [...hostedGitHubDelegatedReadTools] as unknown[];
  Object.defineProperty(target, hidden, {
    configurable: true,
    enumerable: true,
    value: "fetch_workflow_job_logs",
  });
  let ownKeyReads = 0;
  const hostile = new Proxy(target, {
    ownKeys(current) {
      ownKeyReads += 1;
      return Reflect.ownKeys(current);
    },
  });
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    delegatedGitHubReadTools:
      hostile as unknown as typeof hostedGitHubDelegatedReadTools,
    async callGitHubDelegatedRead() {
      throw new Error("must not dispatch");
    },
  };

  try {
    expect(() => createMcpServer(
      Object.assign(ledger, provider),
      {
        principal: {
          tokenId: "delegated-actions-proxy-review",
          name: "delegated actions proxy review",
          scopes: ["read"],
          projects: ["scrapbook"],
        },
      },
    )).toThrow("tool declaration is invalid");
    expect(ownKeyReads).toBe(1);
  } finally {
    store.close();
  }
});

test("dispatches through the captured delegated callable instead of a later Proxy view", async () => {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    delegatedGitHubReadTools: hostedGitHubDelegatedReadTools,
    async callGitHubDelegatedRead(input) {
      return Object.freeze({
        version: 1,
        project: input.project,
        repositoryFullName: input.repository.toLowerCase(),
        tool: input.tool,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "ghconn_proxy_callable_review",
        installationId: "98765",
        bindingId: "ghbind_proxy_callable_review",
        attachmentId: "attach_proxy_callable_review",
        attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint: input.catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "ACTIONS:PROXY:1",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result: Object.freeze({ source: "captured" }),
      });
    },
  };
  const target = Object.assign(ledger, provider);
  let substitutionReads = 0;
  const hostile = new Proxy(target, {
    get(current, key, receiver) {
      if (key === "callGitHubDelegatedRead") {
        substitutionReads += 1;
        return async () => Object.freeze({ source: "substituted" });
      }
      return Reflect.get(current, key, receiver);
    },
  });
  const server = createMcpServer(hostile, {
    principal: {
      tokenId: "delegated-actions-callable-review",
      name: "delegated actions callable review",
      scopes: ["read"],
      projects: ["scrapbook"],
    },
  });
  const client = new Client(
    { name: "delegated-actions-callable-review", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "github_call_tool",
      arguments: {
        project: "scrapbook",
        repository: "teamleaderleo/stensibly",
        tool: "fetch_commit_workflow_runs",
        arguments: { commit_sha: "a".repeat(40) },
        catalogueFingerprint:
          new GitHubCapabilityCatalogueService().registry.fingerprint,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textContent(result))).toMatchObject({
      result: { source: "captured" },
    });
    expect(substitutionReads).toBe(0);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Missing tool content");
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Missing text tool content");
  }
  return first.text;
}
