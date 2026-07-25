import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRunnerContextPacket } from "./context-packets.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";

export function registerContextPacketTools(server: McpServer, ledger: WorkLedger): void {
  server.registerTool(
    "get_runner_context",
    {
      description: "Generate a bounded runner handoff packet from canonical item state, protected blocker and decision events, artifacts, runs, and dependencies. Sensitive credential fields are redacted.",
      inputSchema: {
        id: z.string().trim().min(1),
        maxEvents: z.number().int().min(1).max(100).default(20),
        maxArtifacts: z.number().int().min(0).max(50).default(10),
        maxRuns: z.number().int().min(0).max(25).default(5),
        maxDependencies: z.number().int().min(0).max(100).default(20),
        maxCharacters: z.number().int().min(2_000).max(50_000).default(12_000),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => getRunnerContextPacket(ledger, input.id, input)),
  );
}
