import { afterEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const human = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";
let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("continuation supervisor cross-project authorization", () => {
  test("requires access to both the proposal source and dispatch target projects", async () => {
    store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const alphaSource = await ledger.createItem({
      project: "alpha",
      kind: "task",
      title: "Allowed source",
      priority: 60,
      actor: agent,
    });
    const betaTarget = await ledger.createItem({
      project: "beta",
      kind: "task",
      title: "Forbidden target",
      priority: 60,
      actor: agent,
    });
    const proposal = await ledger.proposeContinuation({
      sourceItemId: alphaSource.id,
      title: "Dispatch across projects",
      rationale: "This action touches a second project.",
      instruction: "Queue the beta target.",
      action: { kind: "dispatch_item", itemId: betaTarget.id },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const token = createApiToken(store, {
      name: "Alpha-only writer",
      scopes: ["read", "write"],
      projects: ["alpha"],
    }).token;
    const app = createServerApp(store, { httpAuth: { required: true } });

    const rest = await app.request(
      `/api/v1/supervisor/continuations/${proposal.id}/queue`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actor: human,
          expectedGeneration: proposal.generation,
        }),
      },
    );
    expect(rest.status).toBe(403);
    expect(await rest.json()).toMatchObject({
      error: "Token cannot access project beta",
    });

    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": protocolVersion,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "queue_continuation_for_supervisor",
          arguments: {
            id: proposal.id,
            actor: human,
            expectedGeneration: proposal.generation,
          },
        },
      }),
    });
    expect(mcp.status).toBe(403);
    expect(await mcp.json()).toMatchObject({
      error: { message: "Token cannot access project beta" },
    });

    expect(await ledger.getContinuation(proposal.id)).toMatchObject({
      status: "proposed",
      generation: proposal.generation,
    });
    expect((await ledger.getItem(betaTarget.id)).item.status).toBe("ready");
  });
});
