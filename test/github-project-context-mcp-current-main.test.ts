import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  GetGitHubProjectContextInput,
  GitHubProjectContextLedger,
  GitHubProjectContextProjection,
} from "../src/github-project-context.ts";
import type { WorkLedger } from "../src/ledger.ts";
import { getMcpCapabilityPolicy } from "../src/mcp-capability-policy.ts";
import { MCP_TOOL_NAMES } from "../src/mcp-diagnostics.ts";
import { createMcpServer } from "../src/mcp.ts";

const project = "scrapbook";
const externalId = "github:teamleaderleo/stensibly#403";

describe("GitHub project context MCP on current hosted boundary", () => {
  test("registers one project-scoped read and serves the backend-neutral ledger projection", async () => {
    const calls: GetGitHubProjectContextInput[] = [];
    const ledger = fakeLedger(calls);
    const server = createMcpServer(ledger);
    const client = new Client(
      { name: "github-project-context-current-main", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name))
        .toContain("get_github_project_context");
      const descriptor = tools.tools.find((tool) =>
        tool.name === "get_github_project_context"
      );
      expect(descriptor?.annotations?.readOnlyHint).toBe(true);

      const result = await client.callTool({
        name: "get_github_project_context",
        arguments: {
          project,
          externalId,
          limit: 5,
          historyLimit: 3,
        },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(textContent(result)) as {
        context: GitHubProjectContextProjection;
        authorityNotice: string;
      };
      expect(payload.context).toEqual(projection());
      expect(payload.authorityNotice).toContain("do not grant execution");
      expect(calls).toEqual([{
        project,
        externalId,
        limit: 5,
        historyLimit: 3,
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("declares the tool in the public manifest and capability policy", () => {
    expect(MCP_TOOL_NAMES).toContain("get_github_project_context");
    expect(getMcpCapabilityPolicy("get_github_project_context")).toMatchObject({
      scope: "read",
      riskClass: "read",
      projectResolution: { kind: "project_argument", argument: "project" },
      approvalPolicy: "none",
      receiptPolicy: "none",
      reconciliationPolicy: "none",
    });
  });
});

function fakeLedger(calls: GetGitHubProjectContextInput[]) {
  const contextLedger: GitHubProjectContextLedger = {
    async getGitHubProjectContext(input) {
      calls.push(input);
      return projection();
    },
  };
  return contextLedger as unknown as WorkLedger & GitHubProjectContextLedger;
}

function projection(): GitHubProjectContextProjection {
  return {
    version: 1,
    workspace: "default",
    project,
    mode: "issue",
    requestedExternalId: externalId,
    issues: [{
      externalId,
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/403",
      repositoryFullName: "teamleaderleo/stensibly",
      issueNumber: 403,
      title: "Render item activity as an attributable response thread",
      state: "open",
      stateReason: null,
      labels: ["triage:ready"],
      assignees: ["teamleaderleo"],
      milestone: null,
      relationships: [],
      provider: {
        sourceRevision: "issue-403-r1",
        createdAt: "2026-07-28T10:00:00.000Z",
        updatedAt: "2026-07-29T11:30:00.000Z",
      },
      synchronization: {
        status: "degraded",
        degradedReasonCode: "github-connector-unavailable",
        observedAt: "2026-07-29T11:40:00.000Z",
        acceptedAt: "2026-07-29T11:41:00.000Z",
        acceptedBy: "actor:cedar",
        outcome: "initial",
      },
      instructions: {
        id: `sha256:${"a".repeat(64)}`,
        sourcePaths: ["AGENTS.md", "STENSIBLY.md"],
      },
    }],
    history: [],
    recovery: {
      canonicalSource: "github",
      stensiblyProjection: "last_known_accepted_context",
      incidentUrl: "https://github.com/teamleaderleo/stensibly/issues/490",
      directGitHubUrls: [
        "https://github.com/teamleaderleo/stensibly/issues/403",
      ],
      guidance: [],
    },
  };
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
