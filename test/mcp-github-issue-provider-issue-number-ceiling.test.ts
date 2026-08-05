import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  withGitHubIssueProviderReadService,
  withGitHubIssueProviderWriteService,
  type GitHubIssueProviderReadService,
  type GitHubIssueProviderWriteService,
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
const maximumGitHubIssueNumber = 2_147_483_647;
const aboveGitHubIssueCeiling = maximumGitHubIssueNumber + 1;
const sourceRevision = `sha256:${"a".repeat(64)}`;

describe("public GitHub issue number ceiling", () => {
  test("admits the exact maximum for get, update, and comment dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    const readIssueNumbers: number[] = [];
    const writeCalls: Array<{
      operation: "update" | "comment";
      issueNumber: number;
    }> = [];
    const reads: GitHubIssueProviderReadService = {
      async listIssues() {
        return { issues: [], nextCursor: null };
      },
      async searchIssues() {
        return { issues: [], nextCursor: null };
      },
      async getIssue(input) {
        readIssueNumbers.push(input.issueNumber);
        return issue();
      },
    };
    const writes: GitHubIssueProviderWriteService = {
      async createIssue() {
        throw new Error("outside this control");
      },
      async updateIssue(input) {
        writeCalls.push({ operation: "update", issueNumber: input.issueNumber });
        return receipt(
          "github_update_issue",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
      async addIssueComment(input) {
        writeCalls.push({ operation: "comment", issueNumber: input.issueNumber });
        return receipt(
          "github_add_issue_comment",
          input.idempotencyKey,
          input.actorId,
          input.clientId,
        );
      },
    };
    const ledger = withGitHubIssueProviderWriteService(
      withGitHubIssueProviderReadService(new SqliteWorkLedger(store), reads),
      writes,
    );
    const server = createMcpServer(ledger, { principal: principal() });
    const client = new Client(
      { name: "github-issue-number-maximum-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const getResult = await client.callTool({
        name: "github_get_issue",
        arguments: {
          project,
          repository,
          issueNumber: maximumGitHubIssueNumber,
        },
      });
      expect(getResult.isError).not.toBe(true);

      const updateResult = await client.callTool({
        name: "github_update_issue",
        arguments: {
          project,
          repository,
          issueNumber: maximumGitHubIssueNumber,
          expectedSourceRevision: sourceRevision,
          title: "exact maximum remains admissible",
          idempotencyKey: "public-issue-number-maximum-update",
        },
      });
      expect(updateResult.isError).not.toBe(true);

      const commentResult = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: maximumGitHubIssueNumber,
          body: "exact maximum remains admissible",
          idempotencyKey: "public-issue-number-maximum-comment",
        },
      });
      expect(commentResult.isError).not.toBe(true);

      expect(readIssueNumbers).toEqual([maximumGitHubIssueNumber]);
      expect(writeCalls).toEqual([
        { operation: "update", issueNumber: maximumGitHubIssueNumber },
        { operation: "comment", issueNumber: maximumGitHubIssueNumber },
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("rejects impossible get, update, and comment targets before service dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let readCalls = 0;
    let writeCalls = 0;
    const reads: GitHubIssueProviderReadService = {
      async listIssues() {
        throw new Error("outside this control");
      },
      async searchIssues() {
        throw new Error("outside this control");
      },
      async getIssue() {
        readCalls += 1;
        throw new Error("provider read must remain unreachable");
      },
    };
    const writes: GitHubIssueProviderWriteService = {
      async createIssue() {
        throw new Error("outside this control");
      },
      async updateIssue() {
        writeCalls += 1;
        throw new Error("provider update must remain unreachable");
      },
      async addIssueComment() {
        writeCalls += 1;
        throw new Error("provider comment must remain unreachable");
      },
    };
    const ledger = withGitHubIssueProviderWriteService(
      withGitHubIssueProviderReadService(new SqliteWorkLedger(store), reads),
      writes,
    );
    const server = createMcpServer(ledger, { principal: principal() });
    const client = new Client(
      { name: "github-issue-number-ceiling-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const getResult = await client.callTool({
        name: "github_get_issue",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
        },
      });
      expect(getResult.isError).toBe(true);

      const updateResult = await client.callTool({
        name: "github_update_issue",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
          expectedSourceRevision: sourceRevision,
          title: "must remain unreachable",
          idempotencyKey: "public-issue-number-ceiling-update",
        },
      });
      expect(updateResult.isError).toBe(true);

      const commentResult = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
          body: "must remain unreachable",
          idempotencyKey: "public-issue-number-ceiling-comment",
        },
      });
      expect(commentResult.isError).toBe(true);

      expect(readCalls).toBe(0);
      expect(writeCalls).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function issue() {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: maximumGitHubIssueNumber,
    title: "Exact maximum GitHub issue",
    body: "Bounded maximum issue body",
    state: "open",
    labels: [],
    assignees: [],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    providerNodeId: "I_issue_2147483647",
    sourceRevision: "github-rest:I_issue_2147483647:2026-08-05T00:00:01.000Z",
  });
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
    target: `${repository}#${maximumGitHubIssueNumber}`,
    actorId,
    clientId,
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey,
    parametersSha256: `sha256:${"c".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    providerRequestId: "github-request-maximum-1",
    result: null,
    verification: {
      state: "passed",
      checkedAt: "2026-08-05T00:00:01.000Z",
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function principal(): TokenPrincipal {
  return {
    tokenId: "github-issue-number-ceiling-token",
    name: "GitHub issue number ceiling test",
    scopes: ["read", "write"],
    projects: [project],
  };
}
