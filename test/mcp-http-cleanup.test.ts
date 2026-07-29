import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";
const actor = {
  id: "cleanup-regression-agent",
  name: "Cleanup Regression Agent",
  kind: "agent" as const,
};

describe("remote MCP cleanup", () => {
  test("preserves repeated lifecycle results when per-request server cleanup fails", async () => {
    const store = new StensiblyStore(":memory:");
    let closeAttempts = 0;

    try {
      const token = createApiToken(store, {
        name: "Cleanup regression writer",
        scopes: ["read", "write"],
        projects: ["oauth-dogfood"],
      });
      const app = createServerApp(store, {
        mcp: {
          createServer(ledger) {
            const server = createMcpServer(ledger);
            const close = server.close.bind(server);
            return new Proxy(server, {
              get(target, property, receiver) {
                if (property === "close") {
                  return async () => {
                    closeAttempts += 1;
                    await close();
                    throw new Error("synthetic cleanup failure");
                  };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
      });

      const initialized = await mcpRequest(app, token.token, initializeMessage(1));
      expect(initialized.status).toBe(200);

      let requestId = 2;
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const prefix = `cleanup-cycle-${cycle}`;
        const created = await callTool<{
          id: string;
          status: string;
          claimGeneration: number;
        }>(app, token.token, requestId++, "create_item", {
          project: "oauth-dogfood",
          kind: "task",
          title: `Cleanup regression lifecycle ${cycle}`,
          summary: "Prove a cleanup exception cannot hide a successful MCP result.",
          nextAction: "Complete the bounded remote MCP lifecycle.",
          actor,
          idempotencyKey: `${prefix}-create`,
        });
        expect(created).toMatchObject({ status: "ready", claimGeneration: 0 });

        const claimed = await callTool<{
          status: string;
          claimedBy: string;
          claimGeneration: number;
        }>(app, token.token, requestId++, "claim_work", {
          id: created.id,
          actor,
          leaseSeconds: 900,
          idempotencyKey: `${prefix}-claim`,
        });
        expect(claimed).toMatchObject({
          status: "active",
          claimedBy: actor.id,
          claimGeneration: 1,
        });

        const event = await callTool<{ id: string; type: string }>(
          app,
          token.token,
          requestId++,
          "record_event",
          {
            id: created.id,
            actor,
            type: "progress.cleanup_regression",
            payload: { cycle },
            idempotencyKey: `${prefix}-event`,
          },
        );
        expect(event.type).toBe("progress.cleanup_regression");

        const artifact = await callTool<{ id: string; kind: string }>(
          app,
          token.token,
          requestId++,
          "attach_artifact",
          {
            id: created.id,
            actor,
            kind: "issue",
            label: "Canonical reliability incident",
            uri: "https://github.com/teamleaderleo/stensibly/issues/490",
            idempotencyKey: `${prefix}-artifact`,
          },
        );
        expect(artifact.kind).toBe("issue");

        const active = await callTool<{
          item: { id: string; status: string; version: number };
          artifacts: Array<{ id: string }>;
          events: Array<{ id: string }>;
        }>(app, token.token, requestId++, "get_item", { id: created.id });
        expect(active.item).toMatchObject({ id: created.id, status: "active" });
        expect(active.artifacts.map((entry) => entry.id)).toContain(artifact.id);
        expect(active.events.map((entry) => entry.id)).toContain(event.id);

        const completed = await callTool<{
          id: string;
          status: string;
          claimGeneration: number;
        }>(app, token.token, requestId++, "complete_work", {
          id: created.id,
          actor,
          expectedClaimGeneration: claimed.claimGeneration,
          summary: `Cleanup regression lifecycle ${cycle} completed.`,
          idempotencyKey: `${prefix}-complete`,
        });
        expect(completed).toMatchObject({
          id: created.id,
          status: "done",
          claimGeneration: 2,
        });

        const terminal = await callTool<{
          item: { id: string; status: string; claimGeneration: number };
        }>(app, token.token, requestId++, "get_item", { id: created.id });
        expect(terminal.item).toMatchObject({
          id: created.id,
          status: "done",
          claimGeneration: 2,
        });
      }

      expect(closeAttempts).toBe(15);
    } finally {
      store.close();
    }
  });
});

async function callTool<T>(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await mcpRequest(app, token, toolCall(id, name, args));
  expect(response.status).toBe(200);
  return await readToolJson<T>(response);
}

async function mcpRequest(
  app: ReturnType<typeof createServerApp>,
  token: string,
  body: unknown,
): Promise<Response> {
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

function initializeMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "cleanup-regression-test", version: "0.0.1" },
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
