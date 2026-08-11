import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  withGitHubIssueProviderWriteService,
  type GitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";

describe("GitHub issue comment worker attribution", () => {
  test("resolves workerRef attribution, preserves explicit fallback, and rejects unsigned comments", async () => {
    const store = new StensiblyStore(":memory:");
    const bodies: string[] = [];
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        return receipt("github_create_issue", input.idempotencyKey, input.actorId, input.clientId);
      },
      async updateIssue(input) {
        return receipt("github_update_issue", input.idempotencyKey, input.actorId, input.clientId);
      },
      async addIssueComment(input) {
        bodies.push(input.body);
        return receipt(
          "github_add_issue_comment",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
    };
    const resolutions: unknown[] = [];
    const ledger = Object.assign(withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      service,
    ), {
      async resolveWorkerEnrolment(input: Record<string, unknown>) {
        resolutions.push(input);
        if (input.workerRef === "wrk_foreign") return null;
        return activeWorker(String(input.workerRef));
      },
    });
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-comment-signoff-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const resolved = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Fresh dogfood checkpoint.",
          workerRef: "wrk_kite_1",
          runId: "run_kite_signoff_1",
          intention: "keep GitHub App comments attributable",
          idempotencyKey: "signed-comment-1",
        },
      });
      expect(resolved.isError).toBeFalsy();
      expect(resolutions).toEqual([{
        actorId: "api-token:github-comment-signoff-grant",
        clientId: "mcp:api-token:github-comment-signoff-grant",
        project,
        workerRef: "wrk_kite_1",
      }]);
      expect(bodies).toEqual([
        [
          "Fresh dogfood checkpoint.",
          "",
          "— Kite g3",
          "  Intention: keep GitHub App comments attributable",
          "  Run: run_kite_signoff_1",
        ].join("\n"),
      ]);

      const fallback = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Recovery checkpoint.",
          signoff: {
            callsign: "Harbor",
            runId: "run_harbor_recovery_1",
          },
          idempotencyKey: "fallback-comment-1",
        },
      });
      expect(fallback.isError).toBeFalsy();
      expect(bodies[1]).toBe([
        "Recovery checkpoint.",
        "",
        "— Harbor",
        "  Run: run_harbor_recovery_1",
      ].join("\n"));

      const unsigned = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Unsigned dogfood checkpoint.",
          idempotencyKey: "unsigned-comment-1",
        },
      });
      expect(unsigned.isError).toBe(true);
      expect(bodies).toHaveLength(2);

      const ambiguous = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Ambiguous checkpoint.",
          workerRef: "wrk_kite_1",
          runId: "run_kite_signoff_1",
          signoff: {
            callsign: "Harbor",
            runId: "run_harbor_recovery_1",
          },
          idempotencyKey: "ambiguous-comment-1",
        },
      });
      expect(ambiguous.isError).toBe(true);
      expect(resolutions).toHaveLength(1);
      expect(bodies).toHaveLength(2);

      const missingRun = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Missing-run checkpoint.",
          workerRef: "wrk_kite_1",
          idempotencyKey: "missing-run-comment-1",
        },
      });
      expect(missingRun.isError).toBe(true);
      expect(resolutions).toHaveLength(1);
      expect(bodies).toHaveLength(2);

      const foreign = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: 490,
          body: "Foreign checkpoint.",
          workerRef: "wrk_foreign",
          runId: "run_foreign_1",
          idempotencyKey: "foreign-comment-1",
        },
      });
      expect(foreign.isError).toBe(true);
      expect(bodies).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function activeWorker(workerRef: string) {
  return {
    workerRef,
    adapter: "remote-mcp",
    profile: "authenticated-generalist",
    workerSessionId: "chat.session-kite",
    capabilities: ["coordination"],
    toolAllowlist: [],
    projectScope: [project],
    preferredStances: [],
    startedAt: "2026-08-11T00:00:00.000Z",
    expiresAt: "2099-08-13T00:00:00.000Z",
    heartbeatSeconds: 3_600,
    correlationId: null,
    causationId: null,
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    status: "active",
    acceptedAt: "2026-08-11T00:00:00.000Z",
    lastHeartbeatAt: "2026-08-11T00:00:00.000Z",
    releasedAt: null,
    expiredAt: null,
    callsign: "Kite",
    callsignLeaseId: "csl_kite_3",
    callsignLeaseGeneration: 3,
    grantsAuthority: false,
  };
}

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "github-comment-signoff-token",
    authorizationId: "github-comment-signoff-grant",
    name: "GitHub comment signoff test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function receipt(
  operation: "github_create_issue" | "github_update_issue" | "github_add_issue_comment",
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
    target: `${repository}#490`,
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
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    providerRequestId: "github-request-1",
    result: null,
    verification: {
      state: "passed",
      checkedAt: "2026-08-10T00:00:01.000Z",
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}
