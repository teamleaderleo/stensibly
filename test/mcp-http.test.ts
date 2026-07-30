import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  initializeMessage,
  mcpRequest,
  readToolJson,
  toolCall,
} from "./support/mcp-http.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

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
    const response = await mcpRequest(app, null, initializeMessage(1));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("initializes and reads work through stateless Streamable HTTP", async () => {
    const token = createApiToken(store, {
      name: "Remote scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const initialized = await mcpRequest(app, token.token, initializeMessage(1));
    expect(initialized.status).toBe(200);
    const initializedBody = await initialized.json() as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(initializedBody.result?.serverInfo?.name).toBe("stensibly");

    const listed = await mcpRequest(app, token.token, toolCall(2, "list_work", {
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

    const missingProject = await mcpRequest(
      app,
      token.token,
      toolCall(3, "list_work", {}),
    );
    expect(missingProject.status).toBe(400);

    const otherProject = await mcpRequest(app, token.token, toolCall(4, "get_brief", {
      project: "elsewhere",
    }));
    expect(otherProject.status).toBe(403);

    const write = await mcpRequest(app, token.token, toolCall(5, "create_item", {
      project: "scrapbook",
      kind: "task",
      title: "A write from a read-only token",
      actor: leo,
    }));
    expect(write.status).toBe(403);
  });

  test("rejects unclassified tools before constructing the MCP server", async () => {
    const token = createApiToken(store, {
      name: "Unknown tool probe",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    });
    let serverConstructions = 0;
    const guardedApp = createServerApp(store, {
      mcp: {
        createServer(ledger, context) {
          serverConstructions += 1;
          return createMcpServer(ledger, context);
        },
      },
    });

    const response = await mcpRequest(
      guardedApp,
      token.token,
      toolCall(6, "unclassified_tool", { project: "scrapbook" }),
    );
    expect(response.status).toBe(403);
    expect(serverConstructions).toBe(0);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toBe(
      "Tool is not registered in the Stensibly capability policy",
    );
  });

  test("rejects browser origins unless explicitly allowed", async () => {
    const token = createApiToken(store, {
      name: "Browser client",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const denied = await mcpRequest(app, token.token, initializeMessage(7), {
      origin: "https://untrusted.example",
    });
    expect(denied.status).toBe(403);

    const originApp = createServerApp(store, {
      mcp: { allowedOrigins: ["https://trusted.example"] },
    });
    const allowed = await mcpRequest(originApp, token.token, initializeMessage(8), {
      origin: "https://trusted.example",
    });
    expect(allowed.status).toBe(200);
  });
});
