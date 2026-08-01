import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compileMcpCapabilityPolicyRegistry,
  createMcpCapabilityRegistrationGuard,
  getMcpCapabilityPolicy,
  mcpCapabilityPolicyRegistry,
} from "../src/mcp-capability-policy.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

describe("MCP capability policy registry", () => {
  test("is deterministic, sorted, frozen, and complete for the current surface", () => {
    const names = mcpCapabilityPolicyRegistry.policies.map((policy) => policy.toolName);

    expect(mcpCapabilityPolicyRegistry.version).toBe(1);
    expect(mcpCapabilityPolicyRegistry.policies).toHaveLength(36);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(mcpCapabilityPolicyRegistry.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(mcpCapabilityPolicyRegistry)).toBe(true);
    expect(Object.isFrozen(mcpCapabilityPolicyRegistry.policies)).toBe(true);
    expect(Object.isFrozen(mcpCapabilityPolicyRegistry.policies[0])).toBe(true);
    expect(Object.isFrozen(mcpCapabilityPolicyRegistry.policies[0]!.projectResolution))
      .toBe(true);
    expect(getMcpCapabilityPolicy("github_call_tool")).toMatchObject({
      scope: "read",
      riskClass: "read",
      projectResolution: { kind: "project_argument", argument: "project" },
      approvalPolicy: "none",
      receiptPolicy: "none",
      reconciliationPolicy: "none",
    });
    for (const toolName of [
      "github_add_issue_comment",
      "github_create_issue",
      "github_update_issue",
    ]) {
      expect(getMcpCapabilityPolicy(toolName)).toMatchObject({
        scope: "write",
        riskClass: "bounded_write",
        projectResolution: { kind: "project_argument", argument: "project" },
        approvalPolicy: "none",
        receiptPolicy: "tool_managed",
        reconciliationPolicy: "tool_managed",
      });
    }

    const recompiled = compileMcpCapabilityPolicyRegistry(
      [...mcpCapabilityPolicyRegistry.policies].reverse(),
    );
    expect(recompiled.fingerprint).toBe(mcpCapabilityPolicyRegistry.fingerprint);
    expect(recompiled.policies).toEqual(mcpCapabilityPolicyRegistry.policies);
  });

  test("rejects duplicate and internally inconsistent policies", () => {
    const readPolicy = mcpCapabilityPolicyRegistry.policies.find(
      (policy) => policy.toolName === "get_brief",
    )!;

    expect(() => compileMcpCapabilityPolicyRegistry([readPolicy, readPolicy]))
      .toThrow("Duplicate MCP capability policy: get_brief");
    expect(() => compileMcpCapabilityPolicyRegistry([{
      ...readPolicy,
      toolName: "broken_read",
      scope: "write",
    }])).toThrow("must use read risk exactly for read scope");
    expect(() => compileMcpCapabilityPolicyRegistry([{
      ...readPolicy,
      toolName: "broken_receipt",
      receiptPolicy: "tool_managed",
    }])).toThrow("cannot declare write effect policy");
  });

  test("guards registration against missing and duplicate policies", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool(toolName: string) {
        registered.push(toolName);
      },
    } as unknown as McpServer;
    const guard = createMcpCapabilityRegistrationGuard(fakeServer);
    const register = guard.server.registerTool as unknown as (
      toolName: string,
      ...args: unknown[]
    ) => unknown;

    register("get_brief", {}, () => undefined);
    expect(registered).toEqual(["get_brief"]);
    expect(guard.complete()).toEqual(["get_brief"]);
    expect(() => register("get_brief", {}, () => undefined))
      .toThrow("Duplicate MCP tool registration: get_brief");
    expect(() => register("unclassified_tool", {}, () => undefined))
      .toThrow("Missing MCP capability policy for registered tool: unclassified_tool");
  });

  test("covers every tool registered by the full SQLite MCP surface", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(new SqliteWorkLedger(store));
    const client = new Client(
      { name: "mcp-capability-policy-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);

      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(getMcpCapabilityPolicy(name)).not.toBeNull();
      }
      expect(names.length).toBeGreaterThan(20);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
