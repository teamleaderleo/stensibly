import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { continuationLedger } from "./continuation-contracts.js";
import { buildDecisionInbox } from "./decision-inbox.js";
import type { WorkLedger } from "./ledger.js";

export function registerDecisionInboxTool(
  server: McpServer,
  ledger: WorkLedger,
): void {
  if (!continuationLedger(ledger)) return;

  server.registerTool(
    "list_decision_inbox",
    {
      description: "List unresolved human approval requests from continuation proposals, with source-item context, urgency, evidence, generation, and allowed commands.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug")
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit }) => asToolResult(() =>
      buildDecisionInbox(ledger, {
        ...(project ? { project } : {}),
        limit,
      })
    ),
  );
}

async function asToolResult(read: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await read(), null, 2) }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
}
