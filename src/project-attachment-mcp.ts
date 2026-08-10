import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import {
  projectAttachmentRecovery,
  repositorySetupWorkProfiles,
} from "./project-attachment-setup-plan.js";
import {
  prepareProjectRepositorySetupObservation,
  projectRepositorySetupObservationSourceKinds,
} from "./project-repository-setup-observation.js";
import {
  projectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-ledger.js";

const projectSlug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");

export function registerProjectAttachmentTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "remember_project_repository_setup",
    {
      description: "Durably remember one non-authorizing repository/default-branch proposal for a project before attachment acceptance. Use github_conversation_context when the repository facts came from the current conversation and operator_supplied for explicit operator configuration. Exact replay is idempotent. Replacing a different saved proposal requires the current observation id returned by get_project_attachment. The write is compare-and-swap fenced to that observed state and grants zero provider or attachment authority.",
      inputSchema: {
        project: projectSlug,
        repositoryFullName: z.string().min(3).max(140),
        defaultBranch: z.string().min(1).max(240),
        sourceKind: z.enum(projectRepositorySetupObservationSourceKinds)
          .default("github_conversation_context"),
        replaceObservationId: z.string().min(20).max(160).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({
      project,
      repositoryFullName,
      defaultBranch,
      sourceKind,
      replaceObservationId,
    }) => asToolResult(async () => {
      const observations = projectRepositorySetupObservationLedger(ledger);
      if (!observations) {
        throw new Error("Repository setup observations are unavailable on this backend");
      }
      const current = await observations.getProjectRepositorySetupObservation(project);
      const input = {
        project,
        repositoryFullName,
        defaultBranch,
        sourceKind,
      } as const;
      const prepared = prepareProjectRepositorySetupObservation(current, input);
      if (
        current
        && !prepared.replay
        && replaceObservationId !== current.id
      ) {
        throw new Error(
          `Repository setup proposal replacement requires current observation id ${current.id}`,
        );
      }
      if (!current && replaceObservationId) {
        throw new Error("Repository setup proposal replacement requires a current observation");
      }
      const result = await observations.recordProjectRepositorySetupObservation({
        ...input,
        expectedCurrentObservationId: current?.id ?? null,
      });
      return {
        project,
        observation: result.observation,
        replayed: result.replayed,
        replacedObservationId: result.replacedObservationId,
        authorityNotice: "This saved repository proposal grants zero provider, attachment, claim, lease, approval, or runner authority. Accepted attachment state remains authoritative for repository routing.",
      };
    }),
  );

  server.registerTool(
    "get_project_attachment",
    {
      description: "Read the current accepted repository attachment and saved pre-attachment repository proposal for a project. When the attachment is missing, optionally pass repositorySetup facts already observed through GitHub to receive one advisory setup plan. This is project policy and context, not a live authority grant.",
      inputSchema: {
        project: projectSlug,
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
      const observations = projectRepositorySetupObservationLedger(ledger);
      const [attachment, repositorySetupObservation] = await Promise.all([
        attachments.getProjectAttachment(project),
        observations?.getProjectRepositorySetupObservation(project) ?? Promise.resolve(null),
      ]);
      return {
        project,
        attachment,
        repositorySetupObservation,
        recovery: projectAttachmentRecovery(
          project,
          attachment,
          repositorySetup,
        ),
        authorityNotice: "The accepted attachment is not a live authority grant. Saved repository setup observations and recovery plans are advisory only. Live claims, run leases, approvals, and operation authority remain server-owned state.",
      };
    }),
  );
}
