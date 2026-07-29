import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import { operationReceiptLedger } from "./operation-receipt-contracts.js";

export function registerOperationReceiptTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "get_operation_receipt",
    {
      description: "Reconcile an ambiguous mutation by its project and idempotency key. Returns a bounded durable record when the operation committed, or guidance to retry the exact same request with the same key when no record exists.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
        idempotencyKey: z.string().trim().min(1).max(240),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const receipts = operationReceiptLedger(ledger);
      if (!receipts) {
        throw new Error("Operation receipts are unavailable on this backend");
      }
      return await receipts.getOperationReceipt(input);
    }),
  );
}
