import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiToken } from "../src/auth.ts";
import { buildDecisionInbox } from "../src/decision-inbox.ts";
import { registerDecisionInboxTool } from "../src/decision-inbox-mcp.ts";
import { handleMcpHttpRequest } from "../src/mcp-http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const now = new Date("2026-07-25T12:00:00.000Z");

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("human decision inbox", () => {
  test("projects unresolved human approvals with urgency and valid commands", async () => {
    const normalItem = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Normal-priority source",
      priority: 50,
      actor: agent,
    });
    const urgentItem = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Urgent source",
      priority: 80,
      actor: agent,
    });

    const deferred = await ledger.proposeContinuation({
      sourceItemId: normalItem.id,
      title: "Choose the normal follow-up",
      rationale: "A product choice remains.",
      instruction: "Approve or reject the proposed follow-up.",
      action: { kind: "request_decision", decisionType: "normal_choice" },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "human_inbox",
    });
    await ledger.resolveContinuation({
      id: deferred.id,
      actor: leo,
      command: "defer",
      expectedGeneration: deferred.generation,
    });

    const urgent = await ledger.proposeContinuation({
      sourceItemId: urgentItem.id,
      title: "Approve the expiring follow-up",
      rationale: "The approval window closes soon.",
      instruction: "Review the evidence before the deadline.",
      action: { kind: "request_decision", decisionType: "urgent_choice" },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "current_conversation",
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    });

    await ledger.proposeContinuation({
      sourceItemId: urgentItem.id,
      title: "Automatic follow-up",
      rationale: "Policy already permits this action.",
      instruction: "Create the routine follow-up.",
      action: { kind: "create_item", project: "scrapbook" },
      actor: agent,
      approvalMode: "automatic",
      deliveryMode: "supervisor",
    });

    const inbox = await buildDecisionInbox(ledger, { now });
    expect(inbox).toMatchObject({
      generatedAt: now.toISOString(),
      project: null,
      total: 2,
    });
    expect(inbox.entries.map((entry) => entry.continuationId)).toEqual([
      urgent.id,
      deferred.id,
    ]);
    expect(inbox.entries[0]).toMatchObject({
      project: "scrapbook",
      urgency: "high",
      status: "proposed",
      generation: 1,
      sourceItem: {
        id: urgentItem.id,
        title: "Urgent source",
        priority: 80,
      },
      allowedCommands: ["approve", "reject", "defer", "cancel", "supersede"],
    });
    expect(inbox.entries[1]).toMatchObject({
      urgency: "normal",
      status: "deferred",
      generation: 2,
      allowedCommands: ["approve", "reject", "cancel", "supersede"],
    });
  });

  test("serves the inbox through REST and filters scoped portfolio access", async () => {
    const visible = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Visible decision",
      priority: 60,
      actor: agent,
    });
    const hidden = await ledger.createItem({
      project: "secret",
      kind: "task",
      title: "Hidden decision",
      priority: 90,
      actor: agent,
    });
    for (const item of [visible, hidden]) {
      await ledger.proposeContinuation({
        sourceItemId: item.id,
        title: `Decide for ${item.project}`,
        rationale: "A human choice remains.",
        instruction: "Review and decide.",
        action: { kind: "request_decision", decisionType: "review" },
        actor: agent,
        approvalMode: "human",
      });
    }

    const token = createApiToken(store, {
      name: "Scoped decision reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    const app = createServerApp(store, { httpAuth: { required: true } });
    const response = await app.request("/api/v1/decision-inbox", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      inbox: { total: number; entries: Array<{ project: string }> };
    };
    expect(body.inbox.total).toBe(1);
    expect(body.inbox.entries.map((entry) => entry.project)).toEqual(["scrapbook"]);
  });

  test("exposes the inbox through MCP and protects cross-project remote calls", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "MCP decision source",
      priority: 70,
      actor: agent,
    });
    await ledger.proposeContinuation({
      sourceItemId: item.id,
      title: "Approve through MCP",
      rationale: "A remote supervisor needs the decision context.",
      instruction: "Review and resolve the proposal.",
      action: { kind: "request_decision", decisionType: "mcp_review" },
      actor: agent,
      approvalMode: "human",
    });

    const server = createMcpServer(ledger);
    registerDecisionInboxTool(server, ledger);
    const client = new Client(
      { name: "decision-inbox-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "list_decision_inbox",
        arguments: { project: "scrapbook", limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      const inbox = JSON.parse(textContent(result)) as {
        total: number;
        entries: Array<{ continuationId: string; project: string }>;
      };
      expect(inbox.total).toBe(1);
      expect(inbox.entries[0]).toMatchObject({ project: "scrapbook" });
    } finally {
      await client.close();
      await server.close();
    }

    const authenticator = {
      authenticate: async () => ({
        name: "Scoped MCP reader",
        scopes: ["read"],
        projects: ["scrapbook"],
      }),
    } as any;
    const missingProject = await handleMcpHttpRequest(
      toolRequest("list_decision_inbox", {}),
      { ledger, authenticator },
    );
    expect(missingProject.status).toBe(400);

    const forbiddenProject = await handleMcpHttpRequest(
      toolRequest("list_decision_inbox", { project: "secret" }),
      { ledger, authenticator },
    );
    expect(forbiddenProject.status).toBe(403);
  });
});

function toolRequest(name: string, args: Record<string, unknown>): Request {
  return new Request("https://stensibly.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
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
