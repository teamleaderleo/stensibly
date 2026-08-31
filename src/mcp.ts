import { McpServer as ModernMcpServer } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactKinds } from "./artifact-contracts.js";
import { artifactMetadataSchema } from "./artifact-metadata.js";
import {
  completionContinuationLedger,
  continuationDraftSchema,
} from "./completion-continuation-contracts.js";
import { registerContinuationTools } from "./continuation-mcp.js";
import { registerContextPacketTools } from "./context-mcp.js";
import { registerGitHubIssueProviderTools } from "./github-issue-provider-mcp.js";
import type { WorkLedger } from "./ledger.js";
import { executionEnvelopeSchema } from "./execution-envelope-contracts.js";
import {
  createMcpCapabilityRegistrationGuard,
} from "./mcp-capability-policy.js";
import type { McpRequestContext } from "./mcp-context.js";
import type { McpCapabilityExposureProfile } from "./mcp-exposure-selection.js";
import {
  compileMcpExposureRegistrationPlan,
  createMcpExposureRegistrationFilter,
  type McpExposureRegistrationPlan,
} from "./mcp-exposure-registration.js";
import { withSuccessfulMcpReadObservation } from "./mcp-successful-read-observation.js";
import { asToolResult } from "./mcp-tool-result.js";
import { withMcpToolObservation } from "./mcp-tool-observation.js";
import { registerOperationReceiptTools } from "./operation-receipt-mcp.js";
import { registerProjectAttachmentTools } from "./project-attachment-mcp.js";
import {
  actorSchema,
  itemKinds,
  itemStatuses,
} from "./schemas.js";
import { buildWorkspaceSurvey } from "./survey.js";
import { registerWorkerEnrolmentTools } from "./worker-enrolment-mcp.js";

const FULL_INTERNAL_MCP_SERVER_INSTRUCTIONS = [
  "Stensibly is a shared scrapbook for work in motion.",
  "Use survey_workspace for centralized triage and repeat polling across projects.",
  "Pass the previous survey fingerprint to distinguish material ledger changes from an unchanged check.",
  "Start with get_brief when entering an existing project, then use get_project_attachment to read its accepted repository policy and durable context.",
  "When participating as a worker, call enrol_worker once with a stable session ID so your presence can survive this chat without granting authority.",
  "Treat the accepted project attachment as declared policy, not a claim, run lease, approval, or live authority grant.",
  "Use github_list_issues, github_search_issues, and github_get_issue only for repositories explicitly bound to the project through a server-side GitHub provider connection.",
  "List relevant work before claiming it.",
  "Claims are temporary leases; renew active work and release work you abandon.",
  "Use the current claim generation returned by the server when renewing, releasing, completing, handing off, blocking, or unblocking work.",
  "Use the same idempotency key for an exact mutation retry. When a mutation response is ambiguous, call get_operation_receipt before choosing whether to retry.",
  "Use handoffs, blocks, and unblocks to leave an explicit next state for other actors.",
  "Attach artifact references for files, links, commits, logs, and other outputs another actor may need.",
  "Record discoveries and progress as events so another actor can continue.",
  "Use continuation proposals when useful work should survive the current run and wait for approval or dispatch.",
  "Use get_runner_context before starting or resuming a run so execution begins from a bounded canonical handoff.",
].join(" ");

const PUBLISHED_DEFAULT_MCP_SERVER_INSTRUCTIONS = [
  "Coordinate runner-neutral execution.",
  "Start with get_brief; read policy with get_project_attachment.",
  "Use get_runner_context before run or resume.",
  "Work transitions require the current claim generation; exact retries reuse one idempotency key.",
  "Attach durable references, not copied evidence.",
  "dispatch_work binds one item and profile; the runner owns machine execution.",
  "Attachments are policy, not authority.",
  "GitHub actions require a bound repository and their exact fences; follow returned recovery before retrying an ambiguous write.",
].join(" ");

const PUBLISHED_SEARCHABLE_MCP_SERVER_INSTRUCTIONS = [
  PUBLISHED_DEFAULT_MCP_SERVER_INSTRUCTIONS,
  "Use get_item only when complete item history is required beyond the bounded runner packet.",
  "Use continuation tools for explicit durable follow-up and the searchable GitHub catalogue for a concrete provider capability that the default outcome-level actions do not cover.",
  "Use repository setup memory and branch tidying only for their named setup or maintenance workflows.",
].join(" ");

export interface McpServerConstructionOptions {
  readonly exposureProfile?: McpCapabilityExposureProfile;
}

export function createMcpServer(
  ledger: WorkLedger,
  context: McpRequestContext = {},
  options: McpServerConstructionOptions = {},
): McpServer {
  const exposure = compileMcpExposureRegistrationPlan(
    ledger,
    options.exposureProfile ?? "full_internal",
  );
  const rawServer = new McpServer(
    { name: "stensibly", version: exposure.manifest.serverVersion },
    { instructions: mcpServerInstructions(exposure.profile) },
  );
  return configureMcpServer(rawServer, ledger, context, exposure);
}

export function createModernMcpServer(
  ledger: WorkLedger,
  context: McpRequestContext = {},
  options: McpServerConstructionOptions = {},
): ModernMcpServer {
  const exposure = compileMcpExposureRegistrationPlan(
    ledger,
    options.exposureProfile ?? "full_internal",
  );
  const modernServer = new ModernMcpServer(
    { name: "stensibly", version: exposure.manifest.serverVersion },
    {
      instructions: mcpServerInstructions(exposure.profile),
      cacheHints: {
        "server/discover": { ttlMs: 60_000, cacheScope: "private" },
        "tools/list": { ttlMs: 60_000, cacheScope: "private" },
      },
    },
  );
  // Keep protocol and transport objects inside their own SDK era. The v2 server's
  // high-level registerTool API is intentionally backward-compatible, so only the
  // plain registration calls are shared with the existing ChatGPT/v1 catalogue.
  configureMcpServer(modernServer as unknown as McpServer, ledger, context, exposure);
  return modernServer;
}

function mcpServerInstructions(profile: McpCapabilityExposureProfile): string {
  if (profile === "published_default") return PUBLISHED_DEFAULT_MCP_SERVER_INSTRUCTIONS;
  if (profile === "published_plus_searchable") {
    return PUBLISHED_SEARCHABLE_MCP_SERVER_INSTRUCTIONS;
  }
  return FULL_INTERNAL_MCP_SERVER_INSTRUCTIONS;
}

function configureMcpServer(
  rawServer: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
  exposure: McpExposureRegistrationPlan,
): McpServer {
  const registration = createMcpCapabilityRegistrationGuard(rawServer);
  const filteredRegistration = createMcpExposureRegistrationFilter(
    registration.server,
    exposure.manifest.tools,
  );
  const observedReads = withSuccessfulMcpReadObservation(
    filteredRegistration.server,
    context.onSuccessfulReadToolCall,
  );
  const server = withMcpToolObservation(
    observedReads,
    context.requestId ?? null,
    context.onToolCall,
  );

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
        metadata: artifactMetadataSchema.default({}),
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
    "dispatch_work",
    {
      description: "Atomically claim one exact ready work generation and queue one runner-neutral run. Attach or record exact source/evidence references before dispatch; the selected runner profile owns machine-specific execution.",
      inputSchema: {
        project: projectSchema(),
        itemId: idSchema(),
        expectedClaimGeneration: z.number().int().min(0),
        actor: actorSchema,
        runnerType: z.string().trim().min(1).max(80),
        runnerProfile: z.string().trim().min(1).max(240),
        runnerProfileVersion: z.string().trim().min(1).max(240).nullable(),
        executionEnvelope: executionEnvelopeSchema,
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        maxAttempts: z.number().int().min(1).max(20).default(3),
        retryBackoffSeconds: z.number().int().min(0).max(86_400).default(60),
        idempotencyKey: z.string().trim().min(1).max(240),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => asToolResult(() => ledger.dispatchWork(input)),
  );

  server.registerTool(
    "claim_work",
    {
      description: "Atomically claim an item for a limited lease. A competing live claim returns an error.",
      inputSchema: claimSchema(),
      annotations: { destructiveHint: true, idempotentHint: false },
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
      annotations: { destructiveHint: true, idempotentHint: false },
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
      annotations: { destructiveHint: true, idempotentHint: false },
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
      annotations: { destructiveHint: true, idempotentHint: false },
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
      annotations: { destructiveHint: true, idempotentHint: false },
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
  registerWorkerEnrolmentTools(server, ledger, context);
  filteredRegistration.complete(registration.complete());
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
