import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";
import {
  callToolJson,
  initializeMessage,
  mcpRequest,
} from "./support/mcp-http.ts";

const actor = {
  id: "cleanup-regression-agent",
  name: "Cleanup Regression Agent",
  kind: "agent" as const,
};
const cleanupClient = { clientName: "cleanup-regression-test" };

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

      const initialized = await mcpRequest(
        app,
        token.token,
        initializeMessage(1, cleanupClient),
      );
      expect(initialized.status).toBe(200);

      let requestId = 2;
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const prefix = `cleanup-cycle-${cycle}`;
        const created = await callToolJson<{
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

        const claimed = await callToolJson<{
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

        const event = await callToolJson<{ id: string; type: string }>(
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

        const artifact = await callToolJson<{ id: string; kind: string }>(
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

        const active = await callToolJson<{
          item: { id: string; status: string; version: number };
          artifacts: Array<{ id: string }>;
          events: Array<{ id: string }>;
        }>(app, token.token, requestId++, "get_item", { id: created.id });
        expect(active.item).toMatchObject({ id: created.id, status: "active" });
        expect(active.artifacts.map((entry) => entry.id)).toContain(artifact.id);
        expect(active.events.map((entry) => entry.id)).toContain(event.id);

        const completed = await callToolJson<{
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

        const terminal = await callToolJson<{
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

  test("classifies server construction failures as MCP failures", async () => {
    const store = new StensiblyStore(":memory:");

    try {
      const token = createApiToken(store, {
        name: "Factory failure reader",
        scopes: ["read"],
        projects: ["oauth-dogfood"],
      });
      const app = createServerApp(store, {
        mcp: {
          createServer() {
            throw new Error("synthetic server construction failure");
          },
        },
      });

      const response = await mcpRequest(
        app,
        token.token,
        initializeMessage(99, cleanupClient),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("mcp_failure");
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: 99,
      });
    } finally {
      store.close();
    }
  });
});
