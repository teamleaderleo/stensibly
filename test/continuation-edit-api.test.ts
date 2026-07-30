import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { bearerJsonHeaders } from "./support/http.ts";
import { mcpRequest, readToolJson, toolCall } from "./support/mcp-http.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;
let app: ReturnType<typeof createServerApp>;
let alphaProposal: Awaited<ReturnType<SqliteWorkLedger["proposeContinuation"]>>;
let betaProposal: Awaited<ReturnType<SqliteWorkLedger["proposeContinuation"]>>;
let alphaReadToken: string;
let alphaWriteToken: string;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  const alpha = await ledger.createItem({
    project: "alpha",
    kind: "task",
    title: "Alpha edit source",
    priority: 70,
    actor: agent,
  });
  const beta = await ledger.createItem({
    project: "beta",
    kind: "task",
    title: "Beta edit source",
    priority: 60,
    actor: agent,
  });
  alphaProposal = await propose(alpha.id);
  betaProposal = await propose(beta.id);
  alphaReadToken = createApiToken(store, {
    name: "Alpha continuation reader",
    scopes: ["read"],
    projects: ["alpha"],
  }).token;
  alphaWriteToken = createApiToken(store, {
    name: "Alpha continuation writer",
    scopes: ["read", "write"],
    projects: ["alpha"],
  }).token;
  app = createServerApp(store, { httpAuth: { required: true } });
});

afterEach(() => store.close());

describe("continuation instruction edit API", () => {
  test("edits through REST with exact replay and stale-generation conflicts", async () => {
    const body = {
      actor: leo,
      expectedGeneration: alphaProposal.generation,
      instruction: "Review the alpha change and record the merge decision.",
      note: "Clarify the expected output.",
    };
    const first = await restEdit(alphaProposal.id, body, "rest-edit-1");
    expect(first.response.status).toBe(200);
    expect(first.continuation).toMatchObject({
      id: alphaProposal.id,
      status: "proposed",
      generation: alphaProposal.generation + 1,
      instruction: body.instruction,
    });

    const replay = await restEdit(alphaProposal.id, body, "rest-edit-1");
    expect(replay.response.status).toBe(200);
    expect(replay.continuation).toEqual(first.continuation);

    const stale = await restEdit(alphaProposal.id, body, "rest-edit-stale");
    expect(stale.response.status).toBe(409);
    expect(stale.raw).toMatchObject({ code: "conflict" });
  });

  test("enforces source-item project scopes through REST", async () => {
    const denied = await restEdit(betaProposal.id, {
      actor: leo,
      expectedGeneration: betaProposal.generation,
      instruction: "This token cannot edit beta.",
    }, "rest-edit-beta");
    expect(denied.response.status).toBe(403);

    const allowed = await restEdit(alphaProposal.id, {
      actor: leo,
      expectedGeneration: alphaProposal.generation,
      instruction: "This token may edit alpha.",
    }, "rest-edit-alpha");
    expect(allowed.response.status).toBe(200);
    expect(allowed.continuation).toMatchObject({
      instruction: "This token may edit alpha.",
      generation: alphaProposal.generation + 1,
    });
  });

  test("requires write scope and the correct project through remote MCP", async () => {
    const args = {
      id: alphaProposal.id,
      actor: leo,
      expectedGeneration: alphaProposal.generation,
      instruction: "Edit through remote MCP.",
      idempotencyKey: "mcp-edit-alpha",
    };
    const readOnly = await mcpRequest(
      app,
      alphaReadToken,
      toolCall(1, "edit_continuation", args),
    );
    expect(readOnly.status).toBe(403);

    const wrongProject = await mcpRequest(
      app,
      alphaWriteToken,
      toolCall(2, "edit_continuation", {
        ...args,
        id: betaProposal.id,
        idempotencyKey: "mcp-edit-beta",
      }),
    );
    expect(wrongProject.status).toBe(403);

    const allowed = await mcpRequest(
      app,
      alphaWriteToken,
      toolCall(3, "edit_continuation", args),
    );
    expect(allowed.status).toBe(200);
    const edited = await readToolJson<{
      status: string;
      generation: number;
      instruction: string;
    }>(allowed, 3);
    expect(edited).toMatchObject({
      status: "proposed",
      generation: alphaProposal.generation + 1,
      instruction: args.instruction,
    });
  });
});

async function propose(sourceItemId: string) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: `Review ${sourceItemId}`,
    rationale: "A human should decide whether to continue.",
    instruction: "Review the implementation.",
    action: { kind: "request_decision", decisionType: "review" },
    actor: agent,
    approvalMode: "human",
    deliveryMode: "human_inbox",
  });
}

async function restEdit(
  id: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const response = await app.request(`/api/v1/continuations/${id}/edit`, {
    method: "POST",
    headers: bearerJsonHeaders(alphaWriteToken, {
      "idempotency-key": idempotencyKey,
    }),
    body: JSON.stringify(body),
  });
  const raw = await response.json() as Record<string, unknown>;
  return {
    response,
    raw,
    continuation: raw.continuation as Record<string, unknown> | undefined,
  };
}
