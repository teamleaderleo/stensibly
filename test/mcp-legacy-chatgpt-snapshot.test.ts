import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

interface LegacyToolInputs {
  properties: string[];
  required: string[];
}

interface ActionSnapshot {
  legacySnapshot: {
    toolCount: number;
    tools: string[];
    topLevelInputs: Record<string, LegacyToolInputs>;
  };
}

const snapshot = JSON.parse(
  readFileSync(new URL("../docs/chatgpt-app-actions.json", import.meta.url), "utf8"),
) as ActionSnapshot;

const actor = {
  id: "chatgpt:legacy-25",
  name: "Legacy ChatGPT Snapshot",
  kind: "agent" as const,
};

describe("legacy ChatGPT MCP snapshot compatibility", () => {
  test("preserves every legacy action and accepted top-level input while allowing new actions", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(new SqliteWorkLedger(store));
    const client = new Client(
      { name: "chatgpt-legacy-schema-check", version: "25-actions" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const current = new Map(listed.tools.map((tool) => [tool.name, tool]));

      expect(snapshot.legacySnapshot.tools).toHaveLength(
        snapshot.legacySnapshot.toolCount,
      );
      for (const name of snapshot.legacySnapshot.tools) {
        const tool = current.get(name);
        if (!tool) throw new Error(`Missing legacy action ${name}`);
        const baseline = snapshot.legacySnapshot.topLevelInputs[name];
        if (!baseline) throw new Error(`Missing legacy input checkpoint for ${name}`);

        const inputSchema = asRecord(tool.inputSchema, `${name} input schema`);
        const properties = asRecord(
          inputSchema.properties,
          `${name} input properties`,
        );
        const currentProperties = Object.keys(properties);
        for (const property of baseline.properties) {
          expect(
            currentProperties,
            `${name} removed legacy input ${property}`,
          ).toContain(property);
        }

        const currentRequired = stringArray(inputSchema.required);
        for (const property of currentRequired) {
          expect(
            baseline.required,
            `${name} made ${property} newly required`,
          ).toContain(property);
        }
      }

      expect(listed.tools.length).toBeGreaterThanOrEqual(snapshot.legacySnapshot.toolCount);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("runs a cached 25-action lifecycle after server recreation without rediscovery", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const firstServer = createMcpServer(ledger);
    const firstClient = new Client(
      { name: "chatgpt-before-receipts", version: "25-actions" },
      { capabilities: {} },
    );
    const [firstClientTransport, firstServerTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await firstServer.connect(firstServerTransport);
      await firstClient.connect(firstClientTransport);
      const firstScan = await firstClient.listTools();
      const firstNames = firstScan.tools.map((tool) => tool.name);
      for (const legacyName of snapshot.legacySnapshot.tools) {
        expect(firstNames).toContain(legacyName);
      }
    } finally {
      await firstClient.close();
      await firstServer.close();
    }

    const secondServer = createMcpServer(new SqliteWorkLedger(store));
    const cachedClient = new Client(
      { name: "chatgpt-cached-legacy-actions", version: "25-actions" },
      { capabilities: {} },
    );
    const [cachedClientTransport, secondServerTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await secondServer.connect(secondServerTransport);
      await cachedClient.connect(cachedClientTransport);

      // Deliberately do not call listTools(). This client behaves as though ChatGPT
      // retained an earlier approved action snapshot across a server reconnect.
      const created = await call<{
        id: string;
        status: string;
        claimGeneration: number;
      }>(cachedClient, "create_item", {
        project: "oauth-dogfood",
        title: "Legacy snapshot compatibility lifecycle",
        nextAction: "Complete the cached-action lifecycle.",
        actor,
        idempotencyKey: "legacy-25-create-1",
      });
      expect(created.status).toBe("ready");

      const brief = await call<{ ready: Array<{ id: string }> }>(
        cachedClient,
        "get_brief",
        { project: "oauth-dogfood", limit: 10 },
      );
      expect(brief.ready.map((item) => item.id)).toContain(created.id);

      const claimed = await call<{ claimGeneration: number; status: string }>(
        cachedClient,
        "claim_work",
        {
          id: created.id,
          actor,
          leaseSeconds: 900,
          idempotencyKey: "legacy-25-claim-1",
        },
      );
      expect(claimed.status).toBe("active");

      const event = await call<{ type: string }>(cachedClient, "record_event", {
        id: created.id,
        actor,
        type: "compatibility.proved",
        payload: { snapshot: 25, rediscovered: false },
        idempotencyKey: "legacy-25-event-1",
      });
      expect(event.type).toBe("compatibility.proved");

      const artifact = await call<{ id: string; kind: string }>(
        cachedClient,
        "attach_artifact",
        {
          id: created.id,
          actor,
          kind: "issue",
          label: "P0 connector reliability",
          uri: "https://github.com/teamleaderleo/stensibly/issues/490",
          idempotencyKey: "legacy-25-artifact-1",
        },
      );
      expect(artifact.kind).toBe("issue");

      const completed = await call<{ status: string; claimGeneration: number }>(
        cachedClient,
        "complete_work",
        {
          id: created.id,
          actor,
          expectedClaimGeneration: claimed.claimGeneration,
          summary: "Cached legacy actions remained executable after reconnect.",
          idempotencyKey: "legacy-25-complete-1",
        },
      );
      expect(completed.status).toBe("done");

      const detail = await call<{
        item: { status: string };
        artifacts: Array<{ id: string }>;
        events: Array<{ type: string }>;
      }>(cachedClient, "get_item", { id: created.id });
      expect(detail.item.status).toBe("done");
      expect(detail.artifacts.map((entry) => entry.id)).toContain(artifact.id);
      expect(detail.events.map((entry) => entry.type)).toContain(
        "compatibility.proved",
      );

      const survey = await call<{
        scope: { project: string | null };
        recentDone: Array<{ id: string }>;
      }>(cachedClient, "survey_workspace", {
        project: "oauth-dogfood",
        limit: 10,
      });
      expect(survey.scope.project).toBe("oauth-dogfood");
      expect(survey.recentDone.map((item) => item.id)).toContain(created.id);
    } finally {
      await cachedClient.close();
      await secondServer.close();
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("MCP required input list is invalid");
  }
  return value as string[];
}
