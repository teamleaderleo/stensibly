import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let visibleItemId: string;
let hiddenItemId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  visibleItemId = store.createItem({
    project: "studio",
    kind: "task",
    title: "Visible runner context",
    nextAction: "Continue safely.",
    priority: 50,
    actor: leo,
  }).id;
  hiddenItemId = store.createItem({
    project: "secret",
    kind: "task",
    title: "Hidden runner context",
    nextAction: "Keep this private.",
    priority: 50,
    actor: leo,
  }).id;
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("runner context remote MCP", () => {
  test("returns a packet for an allowed item", async () => {
    const token = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const response = await mcpRequest(token.token, toolCall(1, "get_runner_context", {
      id: visibleItemId,
      maxCharacters: 3_000,
    }));
    expect(response.status).toBe(200);
    const packet = await readToolJson<{ item: { id: string; project: string } }>(response);
    expect(packet.item).toMatchObject({ id: visibleItemId, project: "studio" });
  });

  test("requires read scope and the item's project", async () => {
    const reader = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const deniedProject = await mcpRequest(reader.token, toolCall(2, "get_runner_context", {
      id: hiddenItemId,
    }));
    expect(deniedProject.status).toBe(403);

    const writer = createApiToken(store, {
      name: "Write-only runner",
      scopes: ["write"],
      projects: ["studio"],
    });
    const deniedScope = await mcpRequest(writer.token, toolCall(3, "get_runner_context", {
      id: visibleItemId,
    }));
    expect(deniedScope.status).toBe(403);
  });
});

async function mcpRequest(token: string, body: unknown): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
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
