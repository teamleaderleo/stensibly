import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let scrapbookItemId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  scrapbookItemId = store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Read this over remote MCP",
    nextAction: "Call list_work.",
    priority: 50,
    actor: leo,
  }).id;
  store.createItem({
    project: "elsewhere",
    kind: "task",
    title: "Keep this outside the token boundary",
    nextAction: "Do not disclose it.",
    priority: 50,
    actor: leo,
  });
  app = createServerApp(store);
});

afterEach(() => {
  store.close();
});

describe("remote MCP", () => {
  test("requires a Bearer token even when REST auth is disabled", async () => {
    const response = await mcpRequest(null, initializeMessage(1));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("initializes and reads work through stateless Streamable HTTP", async () => {
    const token = createApiToken(store, {
      name: "Remote scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const initialized = await mcpRequest(token.token, initializeMessage(1));
    expect(initialized.status).toBe(200);
    const initializedBody = await initialized.json() as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(initializedBody.result?.serverInfo?.name).toBe("stensibly");

    const listed = await mcpRequest(token.token, toolCall(2, "list_work", {
      project: "scrapbook",
    }));
    expect(listed.status).toBe(200);
    const result = await readToolJson<Array<{ id: string; project: string }>>(listed);
    expect(result).toEqual([
      expect.objectContaining({ id: scrapbookItemId, project: "scrapbook" }),
    ]);
  });

  test("enforces scope and project allowlists before invoking tools", async () => {
    const token = createApiToken(store, {
      name: "Scoped observer",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const missingProject = await mcpRequest(token.token, toolCall(3, "list_work", {}));
    expect(missingProject.status).toBe(400);

    const otherProject = await mcpRequest(token.token, toolCall(4, "get_brief", {
      project: "elsewhere",
    }));
    expect(otherProject.status).toBe(403);

    const write = await mcpRequest(token.token, toolCall(5, "create_item", {
      project: "scrapbook",
      kind: "task",
      title: "A write from a read-only token",
      actor: leo,
    }));
    expect(write.status).toBe(403);
  });

  test("rejects browser origins unless explicitly allowed", async () => {
    const token = createApiToken(store, {
      name: "Browser client",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const denied = await mcpRequest(token.token, initializeMessage(6), {
      origin: "https://untrusted.example",
    });
    expect(denied.status).toBe(403);

    const originApp = createServerApp(store, {
      mcp: { allowedOrigins: ["https://trusted.example"] },
    });
    const allowed = await originApp.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(token.token, {
        origin: "https://trusted.example",
      }),
      body: JSON.stringify(initializeMessage(7)),
    });
    expect(allowed.status).toBe(200);
  });
});

async function mcpRequest(
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, extraHeaders),
    body: JSON.stringify(body),
  });
}

function mcpHeaders(
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
}

function initializeMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "stensibly-test", version: "0.0.1" },
    },
  };
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
