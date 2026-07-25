import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";

export function registerProjectAttachmentTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "get_project_attachment",
    {
      description: "Read the current accepted repository attachment for a project: declared repositories, runner profiles, limits, approval policy, checks, durable context, source revision, and acceptance metadata. This is project policy and context, not a live authority grant.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => asToolResult(async () => {
      const attachments = projectAttachmentLedger(ledger);
      if (!attachments) {
        throw new Error("Project attachments are unavailable on this backend");
      }
      return {
        project,
        attachment: await attachments.getProjectAttachment(project),
        authorityNotice: "The accepted attachment is not a live authority grant. Live claims, run leases, approvals, and operation authority remain server-owned state.",
      };
    }),
  );
}
