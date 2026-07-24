import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let ledger: SqliteWorkLedger;
let app: ReturnType<typeof createServerApp>;
let token: string;
let alphaContinuationId: string;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  const alpha = await ledger.createItem({
    project: "alpha",
    kind: "task",
    title: "Alpha source",
    priority: 70,
    actor: agent,
  });
  const beta = await ledger.createItem({
    project: "beta",
    kind: "task",
    title: "Beta source",
    priority: 90,
    actor: agent,
  });
  alphaContinuationId = (await propose(alpha.id)).id;
  await propose(beta.id);
  token = createApiToken(store, {
    name: "Alpha inbox reader",
    scopes: ["read"],
    projects: ["alpha"],
  }).token;
  app = createServerApp(store, { httpAuth: { required: true } });
});

afterEach(() => store.close());

describe("continuation inbox API", () => {
  test("requires and enforces a project for allowlisted REST readers", async () => {
    const missingProject = await app.request("/api/v1/continuations/inbox", {
      headers: bearer(token),
    });
    expect(missingProject.status).toBe(400);
    expect(await missingProject.json()).toMatchObject({ code: "invalid_request" });

    const forbidden = await app.request("/api/v1/continuations/inbox?project=beta", {
      headers: bearer(token),
    });
    expect(forbidden.status).toBe(403);

    const allowed = await app.request(
      "/api/v1/continuations/inbox?project=alpha&limit=10&expiringWithinSeconds=900",
      { headers: bearer(token) },
    );
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as {
      inbox: {
        scope: { project: string | null };
        total: number;
        items: Array<{ id: string; sourceItem: { project: string } }>;
      };
    };
    expect(body.inbox).toMatchObject({
      scope: { project: "alpha" },
      total: 1,
    });
    expect(body.inbox.items).toEqual([
      expect.objectContaining({
        id: alphaContinuationId,
        sourceItem: expect.objectContaining({ project: "alpha" }),
      }),
    ]);

    const invalid = await app.request(
      "/api/v1/continuations/inbox?project=alpha&limit=0",
      { headers: bearer(token) },
    );
    expect(invalid.status).toBe(400);
  });

  test("applies the same project rule through remote MCP", async () => {
    const missingProject = await mcpRequest(toolCall(1, "list_continuation_inbox", {}));
    expect(missingProject.status).toBe(400);

    const forbidden = await mcpRequest(toolCall(2, "list_continuation_inbox", {
      project: "beta",
    }));
    expect(forbidden.status).toBe(403);

    const allowed = await mcpRequest(toolCall(3, "list_continuation_inbox", {
      project: "alpha",
      limit: 5,
    }));
    expect(allowed.status).toBe(200);
    const inbox = await readToolJson<{
      scope: { project: string | null };
      total: number;
      items: Array<{ id: string }>;
    }>(allowed);
    expect(inbox).toMatchObject({
      scope: { project: "alpha" },
      total: 1,
    });
    expect(inbox.items.map((item) => item.id)).toEqual([alphaContinuationId]);
  });
});

async function propose(sourceItemId: string) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: `Review ${sourceItemId}`,
    rationale: "A human should decide whether to continue.",
    instruction: "Review the proposal.",
    action: { kind: "request_decision", decisionType: "review" },
    actor: agent,
    approvalMode: "human",
    deliveryMode: "human_inbox",
  });
}

function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

async function mcpRequest(body: unknown): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function readToolJson<T>(response: Response): Promise<T> {
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Remote MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}
