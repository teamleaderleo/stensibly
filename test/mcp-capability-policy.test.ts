import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compileMcpCapabilityPolicyRegistry,
  compileMcpCapabilitySubmissionAnnotations,
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

    expect(mcpCapabilityPolicyRegistry.version).toBe(2);
    expect(mcpCapabilityPolicyRegistry.policies).toHaveLength(52);
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
      interactionDomain: "open",
      effectKind: "none",
      projectResolution: { kind: "project_argument", argument: "project" },
      approvalPolicy: "none",
      receiptPolicy: "none",
      reconciliationPolicy: "none",
    });
    expect(getMcpCapabilityPolicy("get_github_provider_receipt")).toMatchObject({
      scope: "read",
      riskClass: "read",
      interactionDomain: "closed",
      effectKind: "none",
      projectResolution: { kind: "project_argument", argument: "project" },
      approvalPolicy: "none",
      receiptPolicy: "none",
      reconciliationPolicy: "none",
    });
    expect(getMcpCapabilityPolicy("get_github_repository_write_receipt"))
      .toMatchObject({
        scope: "read",
        riskClass: "read",
        projectResolution: { kind: "project_argument", argument: "project" },
        approvalPolicy: "none",
        receiptPolicy: "none",
        reconciliationPolicy: "none",
      });
    for (const toolName of ["github_repo_health", "github_branch_tidy", "github_ci_diagnose"]) {
      expect(getMcpCapabilityPolicy(toolName)).toMatchObject({
        scope: "read",
        riskClass: "read",
        interactionDomain: "open",
        effectKind: "none",
        projectResolution: { kind: "project_argument", argument: "project" },
      });
    }
    expect(getMcpCapabilityPolicy("github_land_pr")).toMatchObject({
      scope: "write",
      riskClass: "consequential",
      defaultExposure: "core",
      interactionDomain: "open",
      effectKind: "destructive",
      approvalPolicy: "tool_managed",
      receiptPolicy: "tool_managed",
      reconciliationPolicy: "tool_managed",
    });
    expect(getMcpCapabilityPolicy("enrol_worker")).toMatchObject({
      scope: "write",
      riskClass: "bounded_write",
      defaultExposure: "hidden",
      interactionDomain: "closed",
      effectKind: "additive",
      projectResolution: { kind: "project_argument", argument: "project" },
      approvalPolicy: "none",
      receiptPolicy: "tool_managed",
      reconciliationPolicy: "tool_managed",
    });
    for (const toolName of [
      "github_add_issue_comment",
      "github_create_branch",
      "github_create_file",
      "github_create_issue",
      "github_create_pull_request",
      "github_publish_change",
      "github_update_file",
      "github_update_issue",
    ]) {
      expect(getMcpCapabilityPolicy(toolName)).toMatchObject({
        scope: "write",
        riskClass: "bounded_write",
        interactionDomain: "open",
        projectResolution: { kind: "project_argument", argument: "project" },
        approvalPolicy: "none",
        receiptPolicy: "tool_managed",
        reconciliationPolicy: "tool_managed",
      });
    }
    for (const policy of mcpCapabilityPolicyRegistry.policies) {
      if (policy.scope === "read") {
        expect(policy.effectKind).toBe("none");
      } else {
        expect(["additive", "destructive"]).toContain(policy.effectKind);
      }
    }
    const openWorldTools = mcpCapabilityPolicyRegistry.policies
      .filter((policy) => policy.interactionDomain === "open")
      .map((policy) => policy.toolName);
    expect(openWorldTools).toEqual([
      "github_add_issue_comment",
      "github_branch_tidy",
      "github_call_tool",
      "github_ci_diagnose",
      "github_create_branch",
      "github_create_file",
      "github_create_issue",
      "github_create_pull_request",
      "github_get_issue",
      "github_land_pr",
      "github_list_issues",
      "github_publish_change",
      "github_repo_health",
      "github_search_issues",
      "github_update_file",
      "github_update_issue",
      "reconcile_github_publish_change",
    ]);

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
    expect(() => compileMcpCapabilityPolicyRegistry([{
      ...readPolicy,
      toolName: "broken_effect",
      effectKind: "destructive",
    }])).toThrow("must declare no environment effect");
  });

  test("derives truthful submission annotations from admitted canonical policy", () => {
    const cases: readonly [string, {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      openWorldHint: boolean;
    }][] = [
      ["get_brief", { readOnlyHint: true, destructiveHint: false, openWorldHint: false }],
      ["github_get_issue", { readOnlyHint: true, destructiveHint: false, openWorldHint: true }],
      ["claim_work", { readOnlyHint: false, destructiveHint: true, openWorldHint: false }],
      ["create_item", { readOnlyHint: false, destructiveHint: false, openWorldHint: false }],
      ["github_add_issue_comment", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }],
      ["github_land_pr", { readOnlyHint: false, destructiveHint: true, openWorldHint: true }],
    ];
    for (const [toolName, expected] of cases) {
      expect(compileMcpCapabilitySubmissionAnnotations(getMcpCapabilityPolicy(toolName)!))
        .toEqual(expected);
    }
  });

  test("projects annotations consistently across every admitted canonical policy", () => {
    for (const policy of mcpCapabilityPolicyRegistry.policies) {
      const annotations = compileMcpCapabilitySubmissionAnnotations(policy);
      expect(Object.isFrozen(annotations)).toBe(true);
      expect(annotations).toEqual({
        readOnlyHint: policy.scope === "read",
        destructiveHint: policy.effectKind === "destructive",
        openWorldHint: policy.interactionDomain === "open",
      });
    }
  });

  test("refuses annotations for policies failing canonical admission", () => {
    const read = getMcpCapabilityPolicy("get_brief")!;
    expect(() =>
      compileMcpCapabilitySubmissionAnnotations({ ...read, scope: "write" })
    ).toThrow("must use read risk exactly for read scope");
    expect(() =>
      compileMcpCapabilitySubmissionAnnotations({ ...read, effectKind: "destructive" })
    ).toThrow("must declare no environment effect");
    expect(() =>
      compileMcpCapabilitySubmissionAnnotations({
        ...read,
        interactionDomain: "hostile" as never,
      })
    ).toThrow("interaction domain is invalid");
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
