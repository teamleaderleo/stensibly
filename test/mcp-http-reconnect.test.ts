import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";
const token = "hosted-reconnect-token";
const project = "oauth-dogfood";
const actor = {
  id: "chatgpt:reconnect-regression",
  name: "Reconnect Regression",
  kind: "agent" as const,
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== token) return null;
    return {
      tokenId: "tok_hosted_reconnect",
      name: "Hosted reconnect test",
      scopes: ["read", "write"],
      projects: [project],
    };
  }
}

type HostedApp = ReturnType<typeof createHostedApp>;

let store: StensiblyStore;
let requestId: number;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  requestId = 0;
});

afterEach(() => store.close());

describe("hosted MCP reconnect lifecycle", () => {
  test("preserves a generation-fenced lifecycle across app recreation", async () => {
    const initialApp = createApp();
    await initialize(initialApp);

    const initialTools = await listTools(initialApp);
    expect(initialTools).toContain("create_item");
    expect(initialTools).toContain("complete_work");

    const created = await callTool<{
      id: string;
      status: string;
      claimGeneration: number;
    }>(initialApp, "create_item", {
      project,
      kind: "task",
      title: "Hosted MCP reconnect regression",
      summary: "Exercise repeated hosted MCP writes across app recreation.",
      nextAction: "Claim, append evidence, reconnect, and complete.",
      priority: 100,
      actor,
      idempotencyKey: "mcp-http-reconnect-create-v1",
    });
    expect(created).toMatchObject({ status: "ready", claimGeneration: 0 });

    const claimed = await callTool<{
      status: string;
      claimedBy: string;
      claimGeneration: number;
    }>(initialApp, "claim_work", {
      id: created.id,
      actor,
      leaseSeconds: 900,
      idempotencyKey: "mcp-http-reconnect-claim-v1",
    });
    expect(claimed).toMatchObject({
      status: "active",
      claimedBy: actor.id,
      claimGeneration: 1,
    });

    const event = await callTool<{ id: string; type: string }>(
      initialApp,
      "record_event",
      {
        id: created.id,
        actor,
        type: "progress.reconnect_test",
        payload: {
          checkpoint: "before-app-recreation",
          nextAction: "Recreate the hosted app and read this item back.",
        },
        idempotencyKey: "mcp-http-reconnect-event-v1",
      },
    );
    expect(event.type).toBe("progress.reconnect_test");

    const artifact = await callTool<{ id: string; kind: string }>(
      initialApp,
      "attach_artifact",
      {
        id: created.id,
        actor,
        kind: "issue",
        label: "Reliability incident #490",
        uri: "https://github.com/teamleaderleo/stensibly/issues/490",
        metadata: { issueNumber: 490, lane: "hosted-mcp-reconnect-regression" },
        idempotencyKey: "mcp-http-reconnect-artifact-v1",
      },
    );
    expect(artifact.kind).toBe("issue");

    const active = await callTool<{
      item: { id: string; status: string; claimGeneration: number };
      events: Array<{ id: string; type: string }>;
      artifacts: Array<{ id: string }>;
    }>(initialApp, "get_item", { id: created.id });
    expect(active.item).toMatchObject({
      id: created.id,
      status: "active",
      claimGeneration: claimed.claimGeneration,
    });
    expect(active.events.map((entry) => entry.id)).toContain(event.id);
    expect(active.artifacts.map((entry) => entry.id)).toEqual([artifact.id]);

    const reconnectedApp = createApp();
    await initialize(reconnectedApp);
    expect(await listTools(reconnectedApp)).toContain("get_item");

    const reconnected = await callTool<{
      item: { id: string; status: string; claimGeneration: number };
      events: Array<{ type: string }>;
      artifacts: Array<{ id: string }>;
    }>(reconnectedApp, "get_item", { id: created.id });
    expect(reconnected.item).toMatchObject({
      id: created.id,
      status: "active",
      claimGeneration: claimed.claimGeneration,
    });
    expect(reconnected.events.map((entry) => entry.type)).toContain(
      "progress.reconnect_test",
    );
    expect(reconnected.artifacts.map((entry) => entry.id)).toEqual([artifact.id]);

    await callTool(reconnectedApp, "complete_work", {
      id: created.id,
      actor,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Hosted MCP lifecycle survived app recreation and remained writable.",
      idempotencyKey: "mcp-http-reconnect-complete-v1",
    });

    const finalApp = createApp();
    await initialize(finalApp);
    const completed = await callTool<{
      item: { id: string; status: string; claimGeneration: number; summary: string };
      events: Array<{ type: string }>;
      artifacts: Array<{ id: string }>;
    }>(finalApp, "get_item", { id: created.id });
    expect(completed.item).toMatchObject({
      id: created.id,
      status: "done",
      claimGeneration: claimed.claimGeneration + 1,
      summary: "Hosted MCP lifecycle survived app recreation and remained writable.",
    });
    expect(completed.events.map((entry) => entry.type)).toContain("item.completed");
    expect(completed.artifacts.map((entry) => entry.id)).toEqual([artifact.id]);
  });
});

function createApp(): HostedApp {
  return createHostedApp({
    ledger: new SqliteWorkLedger(store),
    authenticator: new FixedAuthenticator(),
    allowedOrigins: [],
  });
}

async function initialize(app: HostedApp): Promise<void> {
  const result = await rpc<{ protocolVersion: string }>(app, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "hosted-reconnect-test", version: "0.0.1" },
  });
  expect(result.protocolVersion).toBe(protocolVersion);
}

async function listTools(app: HostedApp): Promise<string[]> {
  const result = await rpc<{ tools: Array<{ name: string }> }>(app, "tools/list", {});
  return result.tools.map((tool) => tool.name);
}

async function callTool<T = unknown>(
  app: HostedApp,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await rpc<{
    isError?: boolean;
    content?: unknown;
  }>(app, "tools/call", { name, arguments: args });
  if (result.isError) throw new Error(textContent(result));
  return JSON.parse(textContent(result)) as T;
}

async function rpc<T>(
  app: HostedApp,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const id = ++requestId;
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(response.status).toBe(200);

  const payload = await response.json() as {
    id?: unknown;
    result?: T;
    error?: { code?: unknown; message?: unknown };
  };
  expect(payload.id).toBe(id);
  if (payload.error) {
    throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error)}`);
  }
  expect(payload.result).toBeDefined();
  return payload.result as T;
}

function textContent(result: { content?: unknown }): string {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new Error("MCP result had no content");
  }
  const first = result.content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return first.text;
}
