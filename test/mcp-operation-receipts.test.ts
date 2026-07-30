import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  callToolJson,
  initializeMessage,
  mcpRequest,
  toolCall,
} from "./support/mcp-http.ts";

const actor = {
  id: "receipt-http-agent",
  name: "Receipt HTTP Agent",
  kind: "agent" as const,
};
const receiptClient = { clientName: "operation-receipt-test" };

describe("remote operation receipts", () => {
  test("allows project-scoped reads and rejects missing scope or project access", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      const item = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Remote receipt",
        priority: 80,
        actor,
        idempotencyKey: "remote-receipt-create",
      });
      const reader = createApiToken(store, {
        name: "Alpha receipt reader",
        scopes: ["read"],
        projects: ["alpha"],
      });
      const foreignReader = createApiToken(store, {
        name: "Beta receipt reader",
        scopes: ["read"],
        projects: ["beta"],
      });
      const writer = createApiToken(store, {
        name: "Write-only token",
        scopes: ["write"],
        projects: ["alpha"],
      });
      const app = createServerApp(store);

      const initialized = await mcpRequest(
        app,
        reader.token,
        initializeMessage(1, receiptClient),
      );
      expect(initialized.status).toBe(200);

      const receipt = await callToolJson<{
        status: string;
        operation: string;
        itemId: string;
        result: { kind: string; id: string };
      }>(app, reader.token, 2, "get_operation_receipt", {
        project: "alpha",
        idempotencyKey: "remote-receipt-create",
      });
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        itemId: item.id,
        result: { kind: "item", id: item.id },
      });

      const foreign = await mcpRequest(
        app,
        foreignReader.token,
        toolCall(3, "get_operation_receipt", {
          project: "alpha",
          idempotencyKey: "remote-receipt-create",
        }),
      );
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({
        error: { message: "Token cannot access project alpha" },
        id: 3,
      });

      const missingReadScope = await mcpRequest(
        app,
        writer.token,
        toolCall(4, "get_operation_receipt", {
          project: "alpha",
          idempotencyKey: "remote-receipt-create",
        }),
      );
      expect(missingReadScope.status).toBe(403);
      expect(await missingReadScope.json()).toMatchObject({
        error: { message: "Token requires read scope" },
        id: 4,
      });
    } finally {
      store.close();
    }
  });
});
