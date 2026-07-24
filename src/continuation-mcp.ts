import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  continuationLedger,
  listContinuationsSchema,
  proposeContinuationSchema,
  resolveContinuationSchema,
} from "./continuation-contracts.js";
import type { WorkLedger } from "./ledger.js";

const idSchema = z.string().trim().min(1).max(240);
const idempotencySchema = z.string().trim().min(1).max(240).optional();

export function registerContinuationTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  const continuations = continuationLedger(ledger);
  if (!continuations) return;

  server.registerTool(
    "propose_continuation",
    {
      description: "Propose a durable typed next action for a work item. The current run may end after this command; approval or dispatch can happen later.",
      inputSchema: {
        sourceItemId: idSchema,
        ...proposeContinuationSchema.shape,
        idempotencyKey: idempotencySchema,
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => continuations.proposeContinuation(input)),
  );

  server.registerTool(
    "get_continuation",
    {
      description: "Read one durable continuation proposal and its current generation and lifecycle state.",
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => asToolResult(() => continuations.getContinuation(id)),
  );

  server.registerTool(
    "list_continuations",
    {
      description: "List continuation proposals for one source item, optionally filtered by status or delivery mode.",
      inputSchema: {
        sourceItemId: idSchema,
        ...listContinuationsSchema.shape,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => continuations.listContinuations(input)),
  );

  server.registerTool(
    "resolve_continuation",
    {
      description: "Apply one generation-guarded continuation lifecycle command such as approve, reject, defer, queue, start, succeed, fail, cancel, or supersede.",
      inputSchema: {
        id: idSchema,
        ...resolveContinuationSchema.shape,
        idempotencyKey: idempotencySchema,
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => continuations.resolveContinuation(input)),
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
