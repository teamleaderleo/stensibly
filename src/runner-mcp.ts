import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRunnerContextPacket } from "./context-packets.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import { normalizeRunnerConcurrencyPolicy } from "./runner-concurrency.js";
import { runnerLedger, type RunnerConcurrencyPolicy } from "./runner-contracts.js";
import { runCommands, runStatuses } from "./runs.js";
import { actorSchema } from "./schemas.js";

export interface RunnerMcpServerOptions {
  concurrency?: Partial<RunnerConcurrencyPolicy>;
}

export function createRunnerMcpServer(
  ledger: WorkLedger,
  options: RunnerMcpServerOptions = {},
): McpServer {
  const runs = runnerLedger(ledger);
  if (!runs) throw new Error("Runner lifecycle is unavailable on this backend");
  const concurrency = normalizeRunnerConcurrencyPolicy(options.concurrency);

  const server = new McpServer(
    { name: "stensibly-runner", version: "0.1.0" },
    {
      instructions: [
        "This endpoint is for runner processes, not general ledger clients.",
        "Claim one queued or retry-eligible run, then use the returned generation and lease generation for every guarded mutation.",
        "Move a claimed run from starting to running, heartbeat before the lease expires, and finish it with a terminal transition.",
        "The returned context packet is bounded and redacted; durable item state remains authoritative.",
        "Global and project concurrency limits are server-owned policy and cannot be changed by a runner call.",
      ].join(" "),
    },
  );

  server.registerTool(
    "claim_runner_work",
    {
      description: "Atomically claim and start the oldest matching queued or retry-eligible run when server-owned global and project capacity are available, transfer its item lease to this runner, and return its bounded context packet.",
      inputSchema: {
        actor: actorSchema,
        runnerType: z.string().trim().min(1).max(80),
        runnerProfile: z.string().trim().min(1).max(160),
        project: projectSchema().optional(),
        runId: z.string().trim().min(1).max(240).optional(),
        externalRunId: z.string().trim().min(1).max(240).optional(),
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        maxContextCharacters: z.number().int().min(2_000).max(50_000).default(12_000),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ maxContextCharacters, ...input }) => asToolResult(async () => {
      const run = await runs.claimRunnerWork({ ...input, concurrency });
      if (!run) return null;
      return {
        run,
        item: (await ledger.getItem(run.itemId)).item,
        context: await getRunnerContextPacket(ledger, run.itemId, {
          maxCharacters: maxContextCharacters,
        }),
      };
    }),
  );

  server.registerTool(
    "get_runner_run",
    {
      description: "Read one durable runner execution record.",
      inputSchema: { id: z.string().trim().min(1).max(240) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => asToolResult(() => runs.getRun(id)),
  );

  server.registerTool(
    "list_runner_runs",
    {
      description: "List durable runs, optionally filtered by project, item, actor, or status.",
      inputSchema: {
        project: projectSchema().optional(),
        itemId: z.string().trim().min(1).max(240).optional(),
        actorId: z.string().trim().min(1).max(120).optional(),
        status: z.enum(runStatuses).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit, ...input }) => asToolResult(async () => {
      const listed = await runs.listRuns(input);
      if (!project) return listed.slice(0, limit);
      const output = [];
      for (const run of listed) {
        if ((await ledger.getItem(run.itemId)).item.project === project) output.push(run);
        if (output.length >= limit) break;
      }
      return output;
    }),
  );

  server.registerTool(
    "heartbeat_runner_run",
    {
      description: "Renew a live runner lease and publish a bounded checkpoint and cumulative usage counters without advancing run generation.",
      inputSchema: {
        id: z.string().trim().min(1).max(240),
        actor: actorSchema,
        expectedGeneration: z.number().int().min(1),
        expectedLeaseGeneration: z.number().int().min(1),
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        checkpoint: z.string().trim().min(1).max(10_000).optional(),
        usage: usageSchema().optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => runs.heartbeatRun(input)),
  );

  server.registerTool(
    "transition_runner_run",
    {
      description: "Apply a generation- and lease-guarded run transition such as run, wait, block, resume, succeed, fail, retry, or cancel.",
      inputSchema: {
        id: z.string().trim().min(1).max(240),
        actor: actorSchema,
        command: z.enum(runCommands),
        expectedGeneration: z.number().int().min(1),
        expectedLeaseGeneration: z.number().int().min(1),
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        checkpoint: z.string().trim().min(1).max(10_000).optional(),
        outcome: z.string().trim().min(1).max(10_000).optional(),
        continuationRef: z.string().trim().min(1).max(500).optional(),
        usage: usageSchema().optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(() => runs.transitionRun(input)),
  );

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

function usageSchema() {
  return z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    toolCalls: z.number().int().min(0).optional(),
    childAgents: z.number().int().min(0).optional(),
  });
}
