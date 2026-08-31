import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  compileMcpCapabilitySubmissionAnnotations,
  requireMcpCapabilityPolicy,
} from "../src/mcp-capability-policy.ts";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { compileMcpExposureRegistrationPlan } from "../src/mcp-exposure-registration.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { withHostedMcpProviders } from "./support/hosted-mcp-ledger.ts";

describe("ChatGPT MCP exposure", () => {
  test("publishes the reviewed default profile with complete canonical risk hints", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withHostedMcpProviders(new SqliteWorkLedger(store));
    const plan = compileMcpExposureRegistrationPlan(ledger, "published_default");
    const server = createChatGptMcpServer(ledger);
    const client = new Client(
      { name: "chatgpt-exposure-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      expect([...names].sort()).toEqual([...plan.manifest.tools].sort());
      expect(names).toHaveLength(20);
      expect(names).toContain("get_brief");
      expect(names).toContain("github_create_issue");
      expect(names).toContain("github_publish_change");
      expect(names).toContain("github_land_pr");
      expect(names).not.toContain("get_operation_receipt");
      expect(names).not.toContain("get_operation_workflow");
      expect(names).not.toContain("github_call_tool");
      expect(names).not.toContain("github_create_branch");
      expect(names).not.toContain("github_create_file");
      expect(names).not.toContain("github_create_pull_request");
      expect(names).not.toContain("enrol_worker");
      expect(names).not.toContain("survey_workspace");

      for (const tool of listed.tools) {
        const expected = compileMcpCapabilitySubmissionAnnotations(
          requireMcpCapabilityPolicy(tool.name),
        );
        expect(tool.annotations?.readOnlyHint).toBe(expected.readOnlyHint);
        expect(tool.annotations?.destructiveHint).toBe(expected.destructiveHint);
        expect(tool.annotations?.openWorldHint).toBe(expected.openWorldHint);
      }
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
