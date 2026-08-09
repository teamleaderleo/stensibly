import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import {
  projectAttachmentRecovery,
  repositorySetupWorkProfiles,
} from "./project-attachment-setup-plan.js";

export function registerProjectAttachmentTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "get_project_attachment",
    {
      description: "Read the current accepted repository attachment for a project: declared repositories, runner profiles, limits, approval policy, checks, durable context, source revision, and acceptance metadata. When the attachment is missing, optionally pass repositorySetup facts already observed through GitHub to receive one advisory setup plan. This is project policy and context, not a live authority grant.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
        repositorySetup: z.object({
          repositoryFullName: z.string().min(3).max(140),
          defaultBranch: z.string().min(1).max(240),
          runnerProfiles: z.array(z.string().min(1).max(120)).min(1).max(16),
          workProfile: z.enum(repositorySetupWorkProfiles),
          checks: z.array(z.string().min(1).max(512)).max(32),
        }).strict().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, repositorySetup }) => asToolResult(async () => {
      const attachments = projectAttachmentLedger(ledger);
      if (!attachments) {
        throw new Error("Project attachments are unavailable on this backend");
      }
      const attachment = await attachments.getProjectAttachment(project);
      return {
        project,
        attachment,
        recovery: projectAttachmentRecovery(
          project,
          attachment,
          repositorySetup,
        ),
        authorityNotice: "The accepted attachment is not a live authority grant. Repository setup recovery is advisory only. Live claims, run leases, approvals, and operation authority remain server-owned state.",
      };
    }),
  );
}
