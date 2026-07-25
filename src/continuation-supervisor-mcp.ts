import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  continuationSupervisorLedger,
  queueContinuationForSupervisorSchema,
  runContinuationSupervisorPolicySchema,
} from "./continuation-supervisor-contracts.js";
import type { WorkLedger } from "./ledger.js";

const idSchema = z.string().trim().min(1).max(240);
const idempotencySchema = z.string().trim().min(1).max(240).optional();

export function registerContinuationSupervisorTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  const supervisor = continuationSupervisorLedger(ledger);
  if (!supervisor) return;

  server.registerTool(
    "queue_continuation_for_supervisor",
    {
      description: "Approve one generation-guarded continuation, materialize its typed action, queue the exact target run through supervisor dispatch, and consume the proposal with the resulting item and run references.",
      inputSchema: {
        id: idSchema,
        ...queueContinuationForSupervisorSchema.shape,
        idempotencyKey: idempotencySchema,
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asToolResult(() =>
      supervisor.queueContinuationForSupervisor(input)
    ),
  );

  server.registerTool(
    "run_continuation_supervisor_policy",
    {
      description: "Dispatch eligible supervisor-delivery continuations using automatic or notify approval policy. Human-approval and decision-request proposals remain untouched.",
      inputSchema: runContinuationSupervisorPolicySchema.shape,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asToolResult(() =>
      supervisor.runContinuationSupervisorPolicy(input)
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
