import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactKinds } from "./artifact-contracts.js";
import {
  completionContinuationLedger,
  continuationDraftSchema,
} from "./completion-continuation-contracts.js";
import { registerContinuationTools } from "./continuation-mcp.js";
import { registerContextPacketTools } from "./context-mcp.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import {
  actorSchema,
  itemKinds,
  itemStatuses,
} from "./schemas.js";
import { buildWorkspaceSurvey } from "./survey.js";

export function createMcpServer(ledger: WorkLedger): McpServer {
  const server = new McpServer(
    { name: "stensibly", version: "0.0.1" },
    {
      instructions: [
        "Stensibly is a shared scrapbook for work in motion.",
        "Use survey_workspace for centralized triage and repeat polling across projects.",
        "Pass the previous survey fingerprint to distinguish material ledger changes from an unchanged check.",
        "Start with get_brief when entering an existing project.",
        "List relevant work before claiming it.",
        "Claims are temporary fenced leases; use the returned claimGeneration for renewal or release.",
        "Use handoffs, blocks, and unblocks to leave an explicit next state for other actors.",
        "Attach artifact references for files, links, commits, logs, and other outputs another actor may need.",
        "Record discoveries and progress as events so another actor can continue.",
        "Use continuation proposals when useful work should survive the current run and wait for approval or dispatch.",
        "Use get_runner_context before starting or resuming a run so execution begins from a bounded canonical handoff.",
      ].join(" "),
    },
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
      description: "Atomically claim an item for a limited fenced lease. A competing live claim returns an error.",
      inputSchema: claimSchema(),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.claimWork(input)),
  );

  server.registerTool(
    "renew_claim",
    {
      description: "Extend a live claim held by the same actor and current claim generation.",
      inputSchema: {
        ...claimSchema(),
        expectedClaimGeneration: claimGenerationSchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.renewClaim(input)),
  );

  server.registerTool(
    "handoff_work",
    {
      description: "Release work to ready state with a compact summary and an explicit next action.",
      inputSchema: {
        id: idSchema(),
        actor: actorSchema,
        summary: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000),
        toActorId: z.string().trim().min(1).max(120).optional(),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.handoffWork(input)),
  );

  server.registerTool(
    "block_work",
    {
      description: "Mark work blocked, record the reason, and release any current lease.",
      inputSchema: {
        id: idSchema(),
        actor: actorSchema,
        reason: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000).optional(),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.blockWork(input)),
  );

  server.registerTool(
    "unblock_work",
    {
      description: "Return blocked work to ready state and optionally replace its next action.",
      inputSchema: {
        id: idSchema(),
        actor: actorSchema,
        nextAction: z.string().trim().min(1).max(2_000).optional(),
        idempotencyKey: idempotencySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => ledger.unblockWork(input)),
  );

  server.registerTool(
    "release_work",
    {
      description: "Release an item held by this actor and exact claim generation, then return it to ready work.",
      inputSchema: {
        ...actorActionSchema(),
        expectedClaimGeneration: claimGenerationSchema(),
      },
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
      description: "Complete an item, clear its lease, optionally replace its summary, and optionally propose durable next actions in the same transaction.",
      inputSchema: {
        ...actorActionSchema(),
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

  registerContextPacketTools(server, ledger);
  registerContinuationTools(server, ledger);
  return server;
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

function actorActionSchema() {
  return {
    id: idSchema(),
    actor: actorSchema,
    idempotencyKey: idempotencySchema(),
  };
}

function claimSchema() {
  return {
    ...actorActionSchema(),
    leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  };
}

function claimGenerationSchema() {
  return z.number().int().min(1);
}
