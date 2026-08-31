import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  requireRunnerTransitionAuthority,
  runAuthorityFence,
  runnerAuthorityCommands,
} from "./authority-fence.js";
import { getRunnerContextPacket } from "./context-packets.js";
import { executionActualSchema } from "./execution-envelope-contracts.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import {
  runnerAdapterCommandLedger,
  type RunnerAdapterCommandLedger,
  type RunnerAdapterCommandReservationRecord,
} from "./runner-adapter-command-contracts.js";
import type { RunnerAdapterCommandRecoveryLedger } from "./runner-adapter-command-recovery.js";
import { normalizeRunnerConcurrencyPolicy } from "./runner-concurrency.js";
import {
  runnerLedger,
  type RunnerConcurrencyPolicy,
  type RunnerLedger,
} from "./runner-contracts.js";
import {
  runnerProfileClaimMatchesV1,
  runnerProfileProvenanceV1,
} from "./runner-profile-provenance.js";
import { runStatuses } from "./run-statuses.js";
import { actorSchema } from "./schemas.js";
import type { WorkstationCommandLedgerV1 } from "./workstation-command-adapter.js";

export interface RunnerMcpServerOptions {
  concurrency?: Partial<RunnerConcurrencyPolicy>;
}

const restartableClaimStatuses = new Set(["starting", "running", "waiting"]);

export function createRunnerMcpServer(
  ledger: WorkLedger,
  options: RunnerMcpServerOptions = {},
): McpServer {
  const runs = runnerLedger(ledger);
  if (!runs) throw new Error("Runner lifecycle is unavailable on this backend");
  const commands = runnerAdapterCommandLedger(ledger);
  const workstations = workstationCommandLedger(ledger);
  const recoveries = runnerAdapterCommandRecoveryLedger(ledger);
  const concurrency = normalizeRunnerConcurrencyPolicy(options.concurrency);

  const server = new McpServer(
    { name: "stensibly-runner", version: "0.1.0" },
    {
      instructions: [
        "This endpoint is for runner processes, not general ledger clients.",
        "Claim one queued or retry-eligible run, then use the returned authority fence, generation, and lease generation for every guarded mutation.",
        "Reserve adapter command identity before external execution and settle the same durable command after consuming its bounded observations.",
        "A stranded reservation may be claimed for recovery ownership only; recovery claims do not authorize redispatch or resume.",
        "Move a claimed run from starting to running, heartbeat before the lease expires, and finish it with a terminal transition.",
        "Retry admission, blocked-run reassignment, and cancellation remain server- or supervisor-owned operations.",
        "The returned context packet is bounded and redacted; durable item state remains authoritative.",
        "Global and project concurrency limits are server-owned policy and cannot be changed by a runner call.",
      ].join(" "),
    },
  );

  server.registerTool(
    "claim_runner_work",
    {
      description: "Atomically claim and start the oldest matching queued or retry-eligible run when server-owned global and project capacity are available, transfer its item lease to this runner, and return its authority fence and bounded context packet.",
      inputSchema: {
        actor: actorSchema,
        runnerType: z.string().trim().min(1).max(80),
        runnerProfile: z.string().trim().min(1).max(160),
        runnerProfileVersion: z.string().trim().min(1).max(160).nullable().optional(),
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
      const current = await runs.getRun(run.id);
      if (!restartableClaimStatuses.has(current.status)) return null;
      const authorityFence = runAuthorityFence(run);
      if (!authorityFence) throw new Error("Claimed run did not return an authority fence");
      return {
        run,
        authorityFence,
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
      description: "Renew a live runner authority lease and publish a bounded checkpoint and cumulative usage counters without advancing run generation.",
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
      description: "Apply a generation- and authority-fence-guarded transition under the current runner lease. Terminal transitions may append bounded execution actuals without rewriting the original envelope. Retry admission, blocked-run reassignment, and cancellation are not runner operations.",
      inputSchema: {
        id: z.string().trim().min(1).max(240),
        actor: actorSchema,
        command: z.enum(runnerAuthorityCommands),
        expectedGeneration: z.number().int().min(1),
        expectedLeaseGeneration: z.number().int().min(1),
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        checkpoint: z.string().trim().min(1).max(10_000).optional(),
        outcome: z.string().trim().min(1).max(10_000).optional(),
        continuationRef: z.string().trim().min(1).max(500).optional(),
        usage: usageSchema().optional(),
        executionActual: executionActualSchema.optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => asToolResult(async () => {
      const current = await runs.getRun(input.id);
      requireRunnerTransitionAuthority(current, input.command);
      return await runs.transitionRun(input);
    }),
  );

  if (commands) {
    registerRunnerAdapterCommandTools(server, runs, commands, workstations, recoveries);
  }

  return server;
}

function registerRunnerAdapterCommandTools(
  server: McpServer,
  runs: RunnerLedger,
  commands: RunnerAdapterCommandLedger,
  workstations: WorkstationCommandLedgerV1 | null,
  recoveries: RunnerAdapterCommandRecoveryLedger | null,
): void {
  server.registerTool(
    "get_runner_adapter_command",
    {
      description: "Read one durable runner adapter command reservation and any terminal settlement by its exact idempotency identity. The caller supplies project scope and the server verifies it against the stored reservation.",
      inputSchema: {
        project: projectSchema(),
        idempotencyKey: z.string().trim().min(1).max(240),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, idempotencyKey }) => asToolResult(async () => {
      const lookup = await commands.getRunnerAdapterCommand({ idempotencyKey });
      if (!lookup) return null;
      requireReservationProject(lookup.command, project);
      return lookup;
    }),
  );

  server.registerTool(
    "reserve_runner_adapter_command",
    {
      description: "Atomically reserve one adapter dispatch under the current run authority. Exact replay returns the stored reservation without authorizing another dispatch.",
      inputSchema: {
        project: projectSchema(),
        itemId: z.string().trim().min(1).max(240),
        runId: z.string().trim().min(1).max(240),
        runGeneration: z.number().int().min(1),
        leaseGeneration: z.number().int().min(1),
        actor: actorSchema,
        adapterId: z.string().trim().min(1).max(80),
        profileId: z.string().trim().min(1).max(79),
        profileVersion: z.string().trim().min(1).max(160).nullable().optional(),
        requestFingerprint: fingerprintSchema(),
        commandId: z.string().trim().min(1).max(160),
        commandFingerprint: fingerprintSchema(),
        idempotencyKey: z.string().trim().min(1).max(240),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(async () => {
      const run = await runs.getRun(input.runId);
      const requestedProfileVersion = runnerProfileProvenanceV1(
        input.profileId,
        input.profileVersion ?? null,
      ).profileVersion;
      requireReservationRunnerProfile(run, input.adapterId, input.profileId, requestedProfileVersion);
      return await commands.reserveRunnerAdapterCommand({
        ...input,
        profileVersion: requestedProfileVersion,
      });
    }),
  );

  if (workstations) {
    server.registerTool(
      "reserve_workstation_adapter_command",
      {
        description: "Atomically reserve one workstation adapter dispatch under the exact current item claim and run authority fence. Exact replay returns the stored reservation without authorizing another physical dispatch.",
        inputSchema: {
          project: projectSchema(),
          itemId: z.string().trim().min(1).max(240),
          itemClaimGeneration: z.number().int().min(0),
          runId: z.string().trim().min(1).max(240),
          runGeneration: z.number().int().min(1),
          leaseGeneration: z.number().int().min(1),
          authorityHolderId: z.string().trim().min(1).max(240),
          authorityExpiresAt: z.string().datetime({ offset: true }),
          actor: actorSchema,
          adapterId: z.string().trim().min(1).max(80),
          profileId: z.string().trim().min(1).max(79),
          profileVersion: z.string().trim().min(1).max(160).nullable().optional(),
          requestFingerprint: fingerprintSchema(),
          commandId: z.string().trim().min(1).max(160),
          commandFingerprint: fingerprintSchema(),
          idempotencyKey: z.string().trim().min(1).max(240),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async ({
        itemClaimGeneration,
        authorityHolderId,
        authorityExpiresAt,
        ...reservation
      }) => asToolResult(async () => {
        const run = await runs.getRun(reservation.runId);
        const requestedProfileVersion = runnerProfileProvenanceV1(
          reservation.profileId,
          reservation.profileVersion ?? null,
        ).profileVersion;
        requireReservationRunnerProfile(
          run,
          reservation.adapterId,
          reservation.profileId,
          requestedProfileVersion,
        );
        return await workstations.reserveWorkstationCommand({
          itemClaimGeneration,
          authority: {
            holderId: authorityHolderId,
            expiresAt: authorityExpiresAt,
          },
          reservation: {
            ...reservation,
            profileVersion: requestedProfileVersion,
          },
        });
      }),
    );
  }

  server.registerTool(
    "settle_runner_adapter_command",
    {
      description: "Settle the exact reserved adapter command with bounded terminal episode evidence. Project and reservation identity are cross-checked before settlement.",
      inputSchema: {
        project: projectSchema(),
        reservationIdempotencyKey: z.string().trim().min(1).max(240),
        commandId: z.string().trim().min(1).max(160),
        commandFingerprint: fingerprintSchema(),
        outcome: commandOutcomeSchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, reservationIdempotencyKey, ...input }) => asToolResult(async () => {
      await requireStoredReservation(
        commands,
        project,
        reservationIdempotencyKey,
        input.commandId,
        input.commandFingerprint,
      );
      return await commands.settleRunnerAdapterCommand(input);
    }),
  );

  if (!recoveries) return;
  server.registerTool(
    "claim_runner_adapter_command_recovery",
    {
      description: "Claim temporary recovery ownership for an exact stranded adapter command. The returned claim can coordinate reconciliation only and never authorizes redispatch or resume.",
      inputSchema: {
        project: projectSchema(),
        reservationIdempotencyKey: z.string().trim().min(1).max(240),
        commandId: z.string().trim().min(1).max(160),
        commandFingerprint: fingerprintSchema(),
        actor: actorSchema,
        leaseSeconds: z.number().int().min(30).max(3_600),
        idempotencyKey: z.string().trim().min(1).max(240),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, reservationIdempotencyKey, ...input }) => asToolResult(async () => {
      await requireStoredReservation(
        commands,
        project,
        reservationIdempotencyKey,
        input.commandId,
        input.commandFingerprint,
      );
      return await recoveries.claimRunnerAdapterCommandRecovery(input);
    }),
  );
}

async function requireStoredReservation(
  commands: RunnerAdapterCommandLedger,
  project: string,
  idempotencyKey: string,
  commandId: string,
  commandFingerprint: string,
): Promise<void> {
  const lookup = await commands.getRunnerAdapterCommand({ idempotencyKey });
  if (!lookup) {
    throw new RangeError("Runner adapter command reservation does not exist");
  }
  requireReservationProject(lookup.command, project);
  if (
    lookup.command.commandId !== commandId
    || lookup.command.commandFingerprint !== commandFingerprint
  ) {
    throw new RangeError("Runner adapter command reservation identity changed");
  }
}

function requireReservationProject(
  command: RunnerAdapterCommandReservationRecord,
  project: string,
): void {
  if (command.project !== project) {
    throw new RangeError("Runner adapter command reservation belongs to another project");
  }
}

function requireReservationRunnerProfile(
  run: { runnerType: string; runnerProfile: string; runnerProfileVersion?: string | null },
  adapterId: string,
  profileId: string,
  profileVersion: string | null,
): void {
  if (run.runnerType !== adapterId || run.runnerProfile !== profileId) {
    throw new RangeError("Runner adapter command adapter or profile does not match the run");
  }
  if (
    !runnerProfileClaimMatchesV1(
      runnerProfileProvenanceV1(run.runnerProfile, run.runnerProfileVersion ?? null),
      runnerProfileProvenanceV1(profileId, profileVersion),
    )
  ) {
    throw new RangeError(
      "Runner adapter command profile version does not match the durable run; start a successor run",
    );
  }
}

function runnerAdapterCommandRecoveryLedger(
  value: unknown,
): RunnerAdapterCommandRecoveryLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RunnerAdapterCommandRecoveryLedger>;
  return typeof candidate.claimRunnerAdapterCommandRecovery === "function"
    ? candidate as RunnerAdapterCommandRecoveryLedger
    : null;
}

function workstationCommandLedger(value: unknown): WorkstationCommandLedgerV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkstationCommandLedgerV1>;
  return typeof candidate.reserveWorkstationCommand === "function"
    && typeof candidate.settleRunnerAdapterCommand === "function"
    ? candidate as WorkstationCommandLedgerV1
    : null;
}

function projectSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");
}

function fingerprintSchema() {
  return z.string().trim().regex(/^sha256:[a-f0-9]{64}$/u);
}

function commandOutcomeSchema() {
  return z.object({
    version: z.literal(1),
    kind: z.literal("bounded_episode_completed"),
    observationCount: z.number().int().min(1).max(32),
    observationsSha256: fingerprintSchema(),
    terminalObservationId: z.string().trim().min(1).max(160),
    terminalObservationType: z.string().trim().min(1).max(80),
    latestCheckpointExternalId: z.string().trim().min(1).max(512).nullable(),
    latestCheckpointSha256: fingerprintSchema().nullable(),
    containsPrivateContent: z.literal(false),
    containsCredentials: z.literal(false),
  }).strict();
}

function usageSchema() {
  return z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    toolCalls: z.number().int().min(0).optional(),
    childAgents: z.number().int().min(0).optional(),
  });
}
