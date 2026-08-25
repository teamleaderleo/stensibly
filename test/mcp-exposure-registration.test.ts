import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCapabilityExposureProfile } from "../src/mcp-exposure-selection.ts";
import {
  compileMcpExposureRegistrationPlan,
  createMcpExposureRegistrationFilter,
} from "../src/mcp-exposure-registration.ts";
import { mcpToolManifestForLedger } from "../src/mcp-diagnostics.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { withHostedMcpProviders } from "./support/hosted-mcp-ledger.ts";

const publishedDefaultNames = [
  "block_work",
  "claim_work",
  "complete_work",
  "create_item",
  "get_brief",
  "get_item",
  "get_project_attachment",
  "github_add_issue_comment",
  "github_ci_diagnose",
  "github_create_issue",
  "github_get_issue",
  "github_land_pr",
  "github_publish_change",
  "github_repo_health",
  "github_search_issues",
  "github_update_issue",
  "handoff_work",
  "list_work",
  "unblock_work",
] as const;

describe("trusted MCP exposure registration", () => {
  test("keeps default and explicit full_internal byte-compatible with the full hosted surface", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withHostedMcpProviders(new SqliteWorkLedger(store));
    try {
      const fullManifest = mcpToolManifestForLedger(ledger);
      const defaultPlan = compileMcpExposureRegistrationPlan(ledger);
      const explicitPlan = compileMcpExposureRegistrationPlan(ledger, "full_internal");

      expect(defaultPlan.manifest).toEqual(fullManifest);
      expect(explicitPlan.manifest).toEqual(fullManifest);
      expect(defaultPlan.grantsAuthority).toBe(false);
      expect(defaultPlan.authorizesPublication).toBe(false);

      const defaultNames = await listToolNames(ledger);
      const explicitNames = await listToolNames(ledger, "full_internal");
      expect(defaultNames).toEqual([...fullManifest.tools]);
      expect(explicitNames).toEqual(defaultNames);
      expect(defaultNames).toHaveLength(52);
    } finally {
      store.close();
    }
  });

  test("registers the reviewed 19-tool published_default surface only when explicitly requested", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withHostedMcpProviders(new SqliteWorkLedger(store));
    try {
      const plan = compileMcpExposureRegistrationPlan(ledger, "published_default");
      expect(plan.manifest.tools).toEqual([...publishedDefaultNames]);
      expect(plan.manifest.tools).toHaveLength(19);
      expect(plan.manifest.fingerprint).not.toBe(
        mcpToolManifestForLedger(ledger).fingerprint,
      );
      expect(plan.manifest.serverVersion).toBe(
        `0.0.1+manifest.${plan.manifest.revision}`,
      );
      expect(plan.grantsAuthority).toBe(false);
      expect(plan.authorizesPublication).toBe(false);

      const { names, listWorkResult } = await listToolsAndCallListWork(
        ledger,
        "published_default",
      );
      expect(names).toEqual([...publishedDefaultNames]);
      expect(listWorkResult.isError).not.toBe(true);
    } finally {
      store.close();
    }
  });

  test("registers core plus searchable tools without hidden tools", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withHostedMcpProviders(new SqliteWorkLedger(store));
    try {
      const plan = compileMcpExposureRegistrationPlan(
        ledger,
        "published_plus_searchable",
      );
      const names = await listToolNames(ledger, "published_plus_searchable");

      expect(names).toEqual([...plan.manifest.tools]);
      expect(names).toContain("github_get_tool");
      expect(names).toContain("get_continuation");
      expect(names).not.toContain("survey_workspace");
      expect(names).not.toContain("enrol_worker");
      expect(names.length).toBeGreaterThan(publishedDefaultNames.length);
      expect(names.length).toBeLessThan(52);
    } finally {
      store.close();
    }
  });

  test("rejects invalid profiles before registration", () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      expect(() => createMcpServer(
        ledger,
        {},
        { exposureProfile: "unknown" as McpCapabilityExposureProfile },
      )).toThrow("exposure profile is invalid");
    } finally {
      store.close();
    }
  });

  test("filters only classified tools and verifies the exact selected registration set", () => {
    const actual: string[] = [];
    const fakeServer = {
      registerTool(toolName: string) {
        actual.push(toolName);
      },
    } as unknown as McpServer;
    const filtered = createMcpExposureRegistrationFilter(fakeServer, ["get_brief"]);
    const register = filtered.server.registerTool as unknown as (
      toolName: string,
      ...args: unknown[]
    ) => unknown;

    expect(register("survey_workspace", {}, () => undefined)).toBeUndefined();
    expect(actual).toEqual([]);
    expect(() => register("survey_workspace", {}, () => undefined))
      .toThrow("Duplicate MCP tool registration: survey_workspace");
    expect(() => register("unclassified_tool", {}, () => undefined))
      .toThrow("Missing MCP capability policy for registered tool: unclassified_tool");

    register("get_brief", {}, () => undefined);
    expect(actual).toEqual(["get_brief"]);
    expect(filtered.complete(["get_brief"])).toEqual(["get_brief"]);
    expect(() => filtered.complete([]))
      .toThrow("did not match selected tools");
  });
});

async function listToolNames(
  ledger: ReturnType<typeof withHostedMcpProviders>,
  profile?: McpCapabilityExposureProfile,
): Promise<string[]> {
  const server = createMcpServer(
    ledger,
    {},
    profile === undefined ? {} : { exposureProfile: profile },
  );
  const client = new Client(
    { name: "mcp-exposure-registration-test", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listToolsAndCallListWork(
  ledger: ReturnType<typeof withHostedMcpProviders>,
  profile: McpCapabilityExposureProfile,
) {
  const server = createMcpServer(ledger, {}, { exposureProfile: profile });
  const client = new Client(
    { name: "mcp-exposure-registration-call-test", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const listWorkResult = await client.callTool({
      name: "list_work",
      arguments: {},
    });
    return {
      names: tools.tools.map((tool) => tool.name),
      listWorkResult,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
