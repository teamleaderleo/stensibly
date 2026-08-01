import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactKinds } from "./artifact-contracts.js";
import {
  completionContinuationLedger,
  continuationDraftSchema,
} from "./completion-continuation-contracts.js";
import { registerContinuationTools } from "./continuation-mcp.js";
import { registerContextPacketTools } from "./context-mcp.js";
import { registerGitHubIssueProviderTools } from "./github-issue-provider-mcp.js";
import type { WorkLedger } from "./ledger.js";
import {
  createMcpCapabilityRegistrationGuard,
} from "./mcp-capability-policy.js";
import type { McpRequestContext } from "./mcp-context.js";
import { MCP_SERVER_VERSION } from "./mcp-diagnostics.js";
import { asToolResult } from "./mcp-tool-result.js";
import { registerOperationReceiptTools } from "./operation-receipt-mcp.js";
import { registerProjectAttachmentTools } from "./project-attachment-mcp.js";
import {
  actorSchema,
  itemKinds,
  itemStatuses,
} from "./schemas.js";
import { buildWorkspaceSurvey } from "./survey.js";

export function createMcpServer(
  ledger: WorkLedger,
  context: McpRequestContext = {},
): McpServer {
  const rawServer = new McpServer(
    { name: "stensibly", version: MCP_SERVER_VERSION },
    {
      instructions: [
        "Stensibly is a shared scrapbook for work in motion.",
        "Use survey_workspace for centralized triage and repeat polling across projects.",
        "Pass the previous survey fingerprint to distinguish material ledger changes from an unchanged check.",
        "Start with get_brief when entering an existing project, then use get_project_attachment to read its accepted repository policy and durable context.",
        "Treat the accepted project attachment as declared policy, not a claim, run lease, approval, or live authority grant.",
        "Use github_list_issues, github_search_issues, and github_get_issue only for repositories explicitly bound to the project through a server-side GitHub provider connection.",
        "Use github_create_issue, github_update_issue, and github_add_issue_comment with one exact idempotency key; reconcile the returned provider receipt before retrying any ambiguous write.",
        "List relevant work before claiming it.",
        "Claims are temporary leases; renew active work and release work you abandon.",
        "Use the current claim generation returned by the server when renewing, releasing, completing, handing off, blocking, or unblocking work.",
        "Use the same idempotency key for an exact mutation retry. When a mutation response is ambiguous, call get_operation_receipt before choosing whether to retry.",
        "Use handoffs, blocks, and unblocks to leave an explicit next state for other actors.",
        "Attach artifact references for files, links, commits, logs, and other outputs another actor may need.",
        "Record discoveries and progress as events so another actor can continue.",
        "Use continuation proposals when useful work should survive the current run and wait for approval or dispatch.",
        "Use get_runner_context before starting or resuming a run so execution begins from a bounded canonical handoff.",
      ].join(" "),
    },
  );
  const registration = createMcpCapabilityRegistrationGuard(rawServer);
  const server = registration.server;

  server.registerTool(
    "get_brief",
    {
      description: "Get a compact project briefing with counts, ready work, active claims, blockers, knowledge, recent completions, and recent artifacts.",
      inputSchema: {
        project: projectSchema(),
        limit: z.number().int().min(1).max(100).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit }) => asToolResult(() => ledger.getBrief(project, limit)),
  );

  server.registerTool(
    "survey_workspace",
    {
      description: "Get one deterministic read-only survey for dispatching new chats: project counts, urgent lease states, ready candidates, active work, blockers, recent completions, and a material-change fingerprint.",
      inputSchema: {
        project: projectSchema().optional(),
        limit: z.number().int().min(1).max(100).default(10),
        expiringWithinSeconds: z.number().int().min(60).max(86_400).default(900),
        previousFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit, expiringWithinSeconds, previousFingerprint }) =>
      asToolResult(async () => buildWorkspaceSurvey(
        await ledger.listWork(project ? { project } : {}),
        {
          ...(project ? { project } : {}),
          limit,
          expiringWithinSeconds,
          ...(previousFingerprint ? { previousFingerprint } : {}),
        },
      )),
  );

  server.registerTool(
    "list_work",
    {
      description: "List current work, optionally filtered by project and status.",
      inputSchema: {
        project: z.string().trim().min(1).max(80).optional(),
        status: z.enum(itemStatuses).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, status }) =>
      asToolResult(() => ledger.listWork({
        ...(project ? { project } : {}),
        ...(status ? { status } : {}),
      })),
  );

  server.registerTool(
    "get_item",
    {
      description: "Read one item together with its event history, artifact references, runs, and dependencies.",
      inputSchema: { id: idSchema() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => asToolResult(() => ledger.getItem(id)),
  );

  server.registerTool(
    "list_artifacts",
    {
      description: "List every artifact reference attached to one work item.",
      inputSchema: { id: idSchema() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => asToolResult(() => ledger.listArtifacts(id)),
  );

  server.registerTool(
    "attach_artifact",
    {
      description: "Attach a pointer to a file, URL, commit, issue, document, image, log, dataset, or other output.",
      inputSchema: {
        id: idSchema(),
        actor: actorSchema,
        kind: z.enum(artifactKinds),
        label: z.string().trim().min(1).max(240),
        uri: z.string().trim().min(1).max(4096),
        mimeType: z.string().trim().min(1).max(255).optional(),
        metadata: z.record(z.string(), z.unknown()).default({}),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.attachArtifact(input)),
  );

  server.registerTool(
    "create_item",
    {
      description: "Create a task, finding, question, decision, tip, handoff, or note.",
      inputSchema: {
        project: projectSchema(),
        kind: z.enum(itemKinds).default("task"),
        title: z.string().trim().min(1).max(240),
        summary: z.string().trim().max(10_000).optional(),
        nextAction: z.string().trim().max(2_000).optional(),
        priority: z.number().int().min(0).max(100).default(50),
        actor: actorSchema.optional(),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.createItem(input)),
  );

  server.registerTool(
    "claim_work",
    {
      description: "Atomically claim an item for a limited lease. A competing live claim returns an error.",
      inputSchema: claimSchema(),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.claimWork(input)),
  );

  server.registerTool(
    "renew_claim",
    {
      description: "Extend a live claim held by the same actor using the current server-returned claim generation.",
      inputSchema: renewClaimInputSchema(),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.renewClaim(input)),
  );

  server.registerTool(
    "handoff_work",
    {
      description: "Release work to ready state with a compact summary and an explicit next action using the current server-returned claim generation.",
      inputSchema: {
        ...semanticActionSchema(),
        summary: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000),
        toActorId: z.string().trim().min(1).max(120).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.handoffWork(input)),
  );

  server.registerTool(
    "block_work",
    {
      description: "Mark work blocked, record the reason, and release any current lease using the current server-returned claim generation.",
      inputSchema: {
        ...semanticActionSchema(),
        reason: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.blockWork(input)),
  );

  server.registerTool(
    "unblock_work",
    {
      description: "Return blocked work to ready state and optionally replace its next action using the current server-returned claim generation.",
      inputSchema: {
        ...semanticActionSchema(),
        nextAction: z.string().trim().min(1).max(2_000).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.unblockWork(input)),
  );

  server.registerTool(
    "release_work",
    {
      description: "Release an item currently claimed by this actor using the current server-returned claim generation.",
      inputSchema: claimActionSchema(),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.releaseWork(input)),
  );

  server.registerTool(
    "record_event",
    {
      description: "Append progress, a discovery, a warning, or another event to an item's history.",
      inputSchema: {
        id: idSchema(),
        actor: actorSchema.optional(),
        type: z.string().trim().min(1).max(120).regex(/^[a-z0-9._-]+$/),
        payload: z.record(z.string(), z.unknown()).default({}),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.recordEvent(input)),
  );

  server.registerTool(
    "complete_work",
    {
      description: "Complete an item at the current server-returned claim generation, clear its lease, optionally replace its summary, and optionally propose durable next actions in the same transaction.",
      inputSchema: {
        ...semanticActionSchema(),
        summary: z.string().trim().max(10_000).optional(),
        continuations: z.array(continuationDraftSchema).max(20).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(async () => {
      if (input.continuations?.length) {
        const atomic = completionContinuationLedger(ledger);
        if (!atomic) {
          throw new Error(
            "Atomic completion continuations are unavailable on this backend",
          );
        }
        return await atomic.completeWorkWithContinuations({
          ...input,
          continuations: input.continuations,
        });
      }
      const { continuations: _continuations, ...legacyInput } = input;
      return await ledger.completeWork(legacyInput);
    }),
  );

  registerOperationReceiptTools(server, ledger);
  registerProjectAttachmentTools(server, ledger);
  registerGitHubIssueProviderTools(server, ledger, context);
  registerContextPacketTools(server, ledger);
  registerContinuationTools(server, ledger);
  registration.complete();
  return rawServer;
}

function projectSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");
}

function idSchema() {
  return z.string().trim().min(1);
}

function idempotencySchema() {
  return z.string().trim().min(1).max(240).optional();
}

function expectedClaimGenerationSchema() {
  return z.number().int().min(1);
}

function currentClaimGenerationSchema() {
  return z.number().int().min(0);
}

function actorActionSchema() {
  return {
    id: idSchema(),
    actor: actorSchema,
    idempotencyKey: idempotencySchema(),
  };
}

function semanticActionSchema() {
  return {
    ...actorActionSchema(),
    expectedClaimGeneration: currentClaimGenerationSchema(),
  };
}

function claimActionSchema() {
  return {
    ...actorActionSchema(),
    expectedClaimGeneration: expectedClaimGenerationSchema(),
  };
}

function claimSchema() {
  return {
    ...actorActionSchema(),
    leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  };
}

function renewClaimInputSchema() {
  return {
    ...claimActionSchema(),
    leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  };
}
