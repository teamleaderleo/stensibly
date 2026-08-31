import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  compileMcpCapabilitySubmissionAnnotations,
  mcpCapabilityPolicyRegistry,
  requireMcpCapabilityPolicy,
} from "../src/mcp-capability-policy.ts";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { compileMcpPublishedContract } from "../src/mcp-published-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { withHostedMcpProviders } from "./support/hosted-mcp-ledger.ts";

interface ChatGptAppContractSnapshot {
  toolCount: number;
  toolContractFingerprint: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);

function readSnapshot(): ChatGptAppContractSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppContractSnapshot;
}

const publishedDefaultNames = [
  "attach_artifact",
  "block_work",
  "claim_work",
  "complete_work",
  "create_item",
  "dispatch_work",
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

const submissionAnnotationKeys = [
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
] as const;

describe("ChatGPT curated publication preflight", () => {
  test("serves the reviewed 21-tool default with complete canonical action metadata", async () => {
    const snapshot = readSnapshot();
    const store = new StensiblyStore(":memory:");
    const server = createChatGptMcpServer(withHostedMcpProviders(
      new SqliteWorkLedger(store),
    ));
    const client = new Client(
      { name: "chatgpt-published-contract-preflight", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();

      expect(listed.tools).toHaveLength(21);
      expect(snapshot.toolCount).toBe(21);
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        [...publishedDefaultNames].sort(),
      );

      const listedByName = new Map(listed.tools.map((tool) => [tool.name, tool] as const));
      const annotationMismatches: string[] = [];
      for (const toolName of publishedDefaultNames) {
        const tool = listedByName.get(toolName);
        if (!tool) {
          annotationMismatches.push(`${toolName}:missing`);
          continue;
        }
        const expected = compileMcpCapabilitySubmissionAnnotations(
          requireMcpCapabilityPolicy(toolName),
        );
        const actual = tool.annotations ?? {};
        for (const key of submissionAnnotationKeys) {
          if (!Object.hasOwn(actual, key) || actual[key] !== expected[key]) {
            annotationMismatches.push(
              `${toolName}.${key}:${String(actual[key])}!=${String(expected[key])}`,
            );
          }
        }
      }
      expect(annotationMismatches).toEqual([]);

      const contract = compileMcpPublishedContract(
        listed.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.annotations === undefined
            ? {}
            : { annotations: tool.annotations as Record<string, unknown> }),
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
        mcpCapabilityPolicyRegistry,
        "published_default",
      );

      expect(contract.sourceManifestDigest).toBe(snapshot.toolContractFingerprint);
      expect(contract.publishedManifest.tools.map((tool) => tool.name)).toEqual(
        [...publishedDefaultNames],
      );
      expect(contract.publishedManifest.tools).toHaveLength(21);
      expect(contract.publishedManifest.digest).toBe(snapshot.toolContractFingerprint);
      expect(contract.publishedContractFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(contract.grantsAuthority).toBe(false);
      expect(contract.authorizesToolRegistration).toBe(false);
      expect(contract.authorizesPublication).toBe(false);

      for (const tool of contract.publishedManifest.tools) {
        const expected = compileMcpCapabilitySubmissionAnnotations(
          requireMcpCapabilityPolicy(tool.name),
        );
        expect(tool.annotations.readOnlyHint).toBe(expected.readOnlyHint);
        expect(tool.annotations.destructiveHint).toBe(expected.destructiveHint);
        expect(tool.annotations.openWorldHint).toBe(expected.openWorldHint);
      }

      const selectedPolicyNames = mcpCapabilityPolicyRegistry.policies
        .filter((policy) => policy.defaultExposure === "core")
        .map((policy) => policy.toolName);
      expect(selectedPolicyNames).toEqual([...publishedDefaultNames]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
