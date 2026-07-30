import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { mcpRequest, readToolJson, toolCall } from "./support/mcp-http.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const human = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;
let app: ReturnType<typeof createServerApp>;
let writeToken: string;
let readToken: string;
let alphaProposal: Awaited<ReturnType<SqliteWorkLedger["proposeContinuation"]>>;
let betaProposal: Awaited<ReturnType<SqliteWorkLedger["proposeContinuation"]>>;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  const alphaSource = await createItem("alpha", "Alpha source");
  const alphaTarget = await createItem("alpha", "Alpha target");
  const betaSource = await createItem("beta", "Beta source");
  const betaTarget = await createItem("beta", "Beta target");
  alphaProposal = await propose(alphaSource.id, alphaTarget.id);
  betaProposal = await propose(betaSource.id, betaTarget.id);
  writeToken = createApiToken(store, {
    name: "Alpha supervisor writer",
    scopes: ["read", "write"],
    projects: ["alpha"],
  }).token;
  readToken = createApiToken(store, {
    name: "Alpha supervisor reader",
    scopes: ["read"],
    projects: ["alpha"],
  }).token;
  app = createServerApp(store, { httpAuth: { required: true } });
});

afterEach(() => store.close());

describe("continuation supervisor API", () => {
  test("queues an allowed continuation through REST and returns durable references", async () => {
    const response = await app.request(
      `/api/v1/supervisor/continuations/${alphaProposal.id}/queue`,
      {
        method: "POST",
        headers: {
          ...bearer(writeToken),
          "content-type": "application/json",
          "idempotency-key": "rest-supervisor-queue",
        },
        body: JSON.stringify({
          actor: human,
          expectedGeneration: alphaProposal.generation,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      dispatch: {
        continuation: {
          status: string;
          result: { itemId: string; runId: string };
        };
        item: { id: string; project: string; status: string };
        run: { id: string; itemId: string; runnerType: string; runnerProfile: string };
      };
    };
    expect(body.dispatch).toMatchObject({
      continuation: {
        status: "consumed",
        result: {
          itemId: body.dispatch.item.id,
          runId: body.dispatch.run.id,
        },
      },
      item: { project: "alpha", status: "active" },
      run: {
        itemId: body.dispatch.item.id,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
      },
    });

    const replay = await app.request(
      `/api/v1/supervisor/continuations/${alphaProposal.id}/queue`,
      {
        method: "POST",
        headers: {
          ...bearer(writeToken),
          "content-type": "application/json",
          "idempotency-key": "rest-supervisor-queue",
        },
        body: JSON.stringify({
          actor: human,
          expectedGeneration: alphaProposal.generation,
        }),
      },
    );
    expect(await replay.json()).toEqual(body);
  });

  test("enforces write scope and source project through REST and remote MCP", async () => {
    const readOnly = await mcpRequest(
      app,
      readToken,
      toolCall(1, "queue_continuation_for_supervisor", {
        id: alphaProposal.id,
        actor: human,
        expectedGeneration: alphaProposal.generation,
      }),
    );
    expect(readOnly.status).toBe(403);

    const wrongProject = await app.request(
      `/api/v1/supervisor/continuations/${betaProposal.id}/queue`,
      {
        method: "POST",
        headers: {
          ...bearer(writeToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actor: human,
          expectedGeneration: betaProposal.generation,
        }),
      },
    );
    expect(wrongProject.status).toBe(403);

    const allowed = await mcpRequest(
      app,
      writeToken,
      toolCall(2, "queue_continuation_for_supervisor", {
        id: alphaProposal.id,
        actor: human,
        expectedGeneration: alphaProposal.generation,
        idempotencyKey: "mcp-supervisor-queue",
      }),
    );
    expect(allowed.status).toBe(200);
    const result = await readToolJson<{
      continuation: { status: string };
      run: { continuationRef: string };
    }>(allowed, 2);
    expect(result).toMatchObject({
      continuation: { status: "consumed" },
      run: { continuationRef: alphaProposal.id },
    });
  });

  test("requires a project for allowlisted policy runners", async () => {
    const missingRestProject = await app.request(
      "/api/v1/supervisor/continuations/policy",
      {
        method: "POST",
        headers: {
          ...bearer(writeToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(missingRestProject.status).toBe(400);

    const missingMcpProject = await mcpRequest(
      app,
      writeToken,
      toolCall(3, "run_continuation_supervisor_policy", {}),
    );
    expect(missingMcpProject.status).toBe(400);
  });
});

async function createItem(project: string, title: string) {
  return await ledger.createItem({
    project,
    kind: "task",
    title,
    nextAction: `Continue ${title}.`,
    priority: 60,
    actor: agent,
  });
}

async function propose(sourceItemId: string, targetItemId: string) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: "Dispatch the follow-up",
    rationale: "The target item owns the next unit of work.",
    instruction: "Queue the exact target item.",
    action: { kind: "dispatch_item", itemId: targetItemId },
    actor: agent,
    approvalMode: "human",
    deliveryMode: "supervisor",
  });
}

function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}
