import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

describe("GitHub capability catalogue MCP surface", () => {
  test("exposes stable list, search, and exact capability reads", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(new SqliteWorkLedger(store));
    const client = new Client(
      { name: "github-capability-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listedTools = await client.listTools();
      const names = listedTools.tools.map((tool) => tool.name);
      expect(names).toContain("github_list_toolsets");
      expect(names).toContain("github_search_tools");
      expect(names).toContain("github_get_tool");

      const toolsets = await call<{
        delegatedDispatchEnabled: boolean;
        toolsets: Array<{ name: string; defaultVisibleCount: number }>;
      }>(client, "github_list_toolsets", {});
      expect(toolsets.delegatedDispatchEnabled).toBe(false);
      expect(toolsets.toolsets.map((entry) => entry.name)).toEqual([
        "github",
        "review_follow_up",
        "ci_debug",
        "publish_changes",
      ]);
      expect(toolsets.toolsets.every((entry) => entry.defaultVisibleCount > 0)).toBe(true);

      const searched = await call<Array<{ name: string; tier: string }>>(
        client,
        "github_search_tools",
        { query: "workflow logs", skills: ["ci_debug"], limit: 10 },
      );
      expect(searched).toContainEqual(expect.objectContaining({
        name: "fetch_workflow_job_logs",
        tier: "essential",
      }));

      const exact = await call<{
        name: string;
        firstPartyTool: string | null;
        dispatchEnabled: boolean;
        recommendedAction: string;
      }>(client, "github_get_tool", { name: "search_issues" });
      expect(exact).toMatchObject({
        name: "search_issues",
        firstPartyTool: "github_search_issues",
        dispatchEnabled: true,
      });
      expect(exact.recommendedAction).toContain("github_search_issues");
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textContent(result));
  return JSON.parse(textContent(result)) as T;
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result had no content");
  }
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return first.text;
}
