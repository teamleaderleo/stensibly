import { createHash } from "node:crypto";
import { runAuthorityFence, type RunAuthorityFence } from "./authority-fence.js";
import { sha256, stableJson } from "./canonical-json.js";
import { editContinuation } from "./continuation-edit.js";
import { getRunnerContextPacket } from "./context-packets.js";
import { getContinuation, type ContinuationProposal } from "./continuations.js";
import type {
  EffectiveToolSurfaceClass,
  EffectiveToolSurfaceSnapshot,
  ToolSurfaceCapabilityInput,
  ToolSurfaceCapabilityRequirementInput,
  ToolSurfaceClassInput,
  ToolSurfaceRecoveryAction,
} from "./effective-tool-surface.js";
import type { WorkLedger } from "./ledger.js";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
  type RunnerCapabilityCommandBindingV1,
} from "./runner-capability-binding.js";
import {
  RUNNER_ADAPTER_V1,
  assertRunnerObservationBinding,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
} from "./runner-adapter-v1.js";
import {
  admitRunnerAdapterCommandSettlementRecord,
  type RunnerAdapterCommandLedger,
  type RunnerAdapterCommandLookup,
  type RunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";
import {
  ensureRunnerAdapterCommandSchema,
  getSqliteRunnerAdapterCommand,
} from "./runner-adapter-command-sqlite.js";
import type { RunnerLedger } from "./runner-contracts.js";
import {
  compileRunnerResumeInspectionV1,
  type RunnerResumeAuthorizationRefV1,
  type RunnerResumeCheckpointSourceV1,
  type RunnerResumeExpectedRuntimeV1,
  type RunnerResumeInspectionReceiptV1,
  type RunnerResumeInterruptionV1,
} from "./runner-resume-inspection.js";
import type { WorkRun } from "./runs.js";
import type { ActorInput } from "./schemas.js";
import type { StensiblyStore } from "./store.js";

export const RUNNER_AUTHORITATIVE_RESUME_V1 = 1 as const;
export type RunnerAuthoritativeResumeLedgerV1 = WorkLedger & RunnerLedger & RunnerAdapterCommandLedger;

export interface RunnerAuthoritativeResumeEvidenceV1 {
  checkpoint: RunnerResumeCheckpointSourceV1;
  latestCheckpointGeneration: number | null;
  checkpointToolSurface: EffectiveToolSurfaceSnapshot | null;
  grantRefs: readonly RunnerResumeAuthorizationRefV1[] | null;
  requiredApprovalRefs: readonly string[];
  approvalRefs: readonly RunnerResumeAuthorizationRefV1[] | null;
  interruption: RunnerResumeInterruptionV1;
  latestEvidenceRefs?: readonly RunnerExternalReferenceV1[];
}

export interface RunnerAuthoritativeResumeEvidenceSourceV1 {
  read(input: {
    command: RunnerResumeCommandV1;
    run: WorkRun;
    checkpoint: RunnerExternalReferenceV1;
    observedAt: string;
  }): Promise<RunnerAuthoritativeResumeEvidenceV1> | RunnerAuthoritativeResumeEvidenceV1;
}

export interface RunnerAuthoritativeResumeOptionsV1 {
  store: StensiblyStore;
  ledger: RunnerAuthoritativeResumeLedgerV1;
  adapter: RunnerAdapterV1;
  actor: ActorInput;
  profileId: string;
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  evidenceSource: RunnerAuthoritativeResumeEvidenceSourceV1;
  requiredCapabilities?: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs?: readonly string[];
  transport?: string;
  clientProduct?: string;
  clientBuild?: string | null;
  modelProfile?: string | null;
  recoveryActions?: readonly ToolSurfaceRecoveryAction[];
  maxContextCharacters?: number;
  leaseSeconds?: number;
  now?: () => Date;
}

export interface RunnerAuthoritativeResumePreviewV1 {
  version: typeof RUNNER_AUTHORITATIVE_RESUME_V1;
  runId: string;
  itemId: string;
  project: string;
  decision: RunnerResumeInspectionReceiptV1["decision"];
  resumeFenceFingerprint: string;
  inspectionFingerprint: string;
  commandId: string;
  consequences: readonly string[];
  authorizesMutation: false;
  authorizesResume: false;
}

export interface RunnerAuthoritativeResumeInputV1 {
  runId: string;
  idempotencyKey: string;
  expectedResumeFenceFingerprint: string;
}

export interface RunnerAuthoritativeResumeTerminalObservationV1 {
  observationId: string;
  type: RunnerObservationV1["type"];
}

export interface RunnerAuthoritativeResumeRunProjectionV1 {
  status: WorkRun["status"];
  generation: number;
  leaseGeneration: number;
}

export interface RunnerAuthoritativeResumeResultV1 {
  version: typeof RUNNER_AUTHORITATIVE_RESUME_V1;
  disposition: "executed" | "settled_replay" | "waiting_reconciliation";
  runId: string;
  commandId: string;
  commandFingerprint: string;
  resumeFenceFingerprint: string;
  observationCount: number;
  observationsSha256: string;
  terminalObservation: RunnerAuthoritativeResumeTerminalObservationV1 | null;
  latestCheckpoint: RunnerExternalReferenceV1 | null;
  settlement: RunnerAdapterCommandSettlementRecord | null;
  run: RunnerAuthoritativeResumeRunProjectionV1;
  containsPrivateContent: false;
  containsCredentials: false;
}

export class RunnerAuthoritativeResumeConflictError extends Error {
  readonly code = "runner_authoritative_resume_conflict";
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "RunnerAuthoritativeResumeConflictError";
  }
}

interface Options {
  store: StensiblyStore;
  ledger: RunnerAuthoritativeResumeLedgerV1;
  adapter: RunnerAdapterV1;
  descriptor: RunnerAdapterDescriptorV1;
  actor: ActorInput;
  profile: RunnerAdapterDescriptorV1["profiles"][number];
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  evidenceSource: RunnerAuthoritativeResumeEvidenceSourceV1;
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs: readonly string[];
  transport: string;
  clientProduct: string;
  clientBuild: string | null;
  modelProfile: string | null;
  recoveryActions: readonly ToolSurfaceRecoveryAction[];
  maxContextCharacters: number;
  leaseSeconds: number;
  now: () => Date;
}

interface Candidate {
  command: RunnerResumeCommandV1;
  run: WorkRun;
  project: string;
  checkpoint: RunnerExternalReferenceV1;
  prior: RunnerAdapterCommandLookup;
  unresolvedPriorCommands: readonly RunnerAdapterCommandLookup[];
  inspection: RunnerResumeInspectionReceiptV1;
  fence: string;
}

interface RunnerCommandState {
  latest: RunnerAdapterCommandLookup | null;
  unresolved: readonly RunnerAdapterCommandLookup[];
}

interface DurableObservationEventRow {
  actor_id: string | null;
  type: string;
  payload_json: string;
}

const executableStatuses = new Set(["starting", "running", "waiting"]);
const closedContinuationStatuses = new Set(["rejected", "cancelled", "superseded", "expired"]);
const terminalObservationTypes = new Set<RunnerObservationV1["type"]>([
  "paused",
  "completion_proposed",
  "failure_observed",
  "interrupted",
]);
const maxObservations = 32;
const maxObservationBytes = 256 * 1024;
const maxPriorCommands = 64;

/**
 * Authority-bearing resume stays separate from the read-only Control Room receipt.
 * Callers provide only intent, idempotency identity, and a stale-state fence; every
 * decisive fact is rebuilt from the local ledger, adapter inspection, and a trusted
 * server-side evidence source.
 */
export class RunnerAuthoritativeResumeServiceV1 {
  readonly #o: Options;
  #active = false;

  constructor(options: RunnerAuthoritativeResumeOptionsV1) {
    this.#o = normalizeOptions(options);
  }

  async preview(input: { runId: string; idempotencyKey: string }): Promise<RunnerAuthoritativeResumePreviewV1> {
    const candidate = await this.#fresh(
      identifier(input.runId, "Runner resume run ID", 240),
      identifier(input.idempotencyKey, "Runner resume idempotency key", 240),
    );
    return Object.freeze({
      version: RUNNER_AUTHORITATIVE_RESUME_V1,
      runId: candidate.run.id,
      itemId: candidate.run.itemId,
      project: candidate.project,
      decision: candidate.inspection.decision,
      resumeFenceFingerprint: candidate.fence,
      inspectionFingerprint: candidate.inspection.receiptFingerprint,
      commandId: candidate.command.commandId,
      consequences: Object.freeze([
        "Reserve one exact durable resume command under the current run authority generation.",
        "Invoke the admitted adapter resume path at most once for this command identity.",
        "Retain only bounded observation fingerprints, checkpoint references, and terminal settlement evidence.",
        "Leave any reserved command without proven settlement in reconciliation-required state.",
      ]),
      authorizesMutation: false,
      authorizesResume: false,
    });
  }

  async resume(raw: RunnerAuthoritativeResumeInputV1): Promise<RunnerAuthoritativeResumeResultV1> {
    if (this.#active) throw conflict("service_busy", "Runner resume service already has an active command");
    this.#active = true;
    try {
      return await this.#resume(normalizeInput(raw));
    } finally {
      this.#active = false;
    }
  }

  async #resume(input: ReturnType<typeof normalizeInput>): Promise<RunnerAuthoritativeResumeResultV1> {
    const requestFingerprint = digest({
      version: RUNNER_AUTHORITATIVE_RESUME_V1,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      expectedResumeFenceFingerprint: input.expectedResumeFenceFingerprint,
      actorId: this.#o.actor.id,
      adapterId: this.#o.descriptor.adapterId,
      profileId: this.#o.profile.id,
    });
    const existing = await this.#o.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey });
    if (existing) return await this.#replay(input, requestFingerprint, existing);

    const candidate = await this.#fresh(input.runId, input.idempotencyKey);
    requireFence(input.expectedResumeFenceFingerprint, candidate);
    requireEligible(candidate.inspection);
    const commandFingerprint = digest(candidate.command);
    const reservation = await this.#o.ledger.reserveRunnerAdapterCommand({
      project: candidate.project,
      itemId: candidate.run.itemId,
      runId: candidate.run.id,
      runGeneration: candidate.run.generation,
      leaseGeneration: candidate.run.leaseGeneration,
      actor: this.#o.actor,
      adapterId: candidate.command.adapterId,
      profileId: candidate.command.profileId,
      requestFingerprint,
      commandId: candidate.command.commandId,
      commandFingerprint,
      idempotencyKey: input.idempotencyKey,
    });
    if (!reservation.dispatchAuthorized) {
      return await this.#reservationResult(
        reservation.command,
        input.expectedResumeFenceFingerprint,
        reservation.settlement,
      );
    }

    const sourcePrior = await this.#o.ledger.getRunnerAdapterCommand({
      idempotencyKey: candidate.prior.command.idempotencyKey,
    });
    if (!sourcePrior) throw conflict("prior_command_disappeared", "Prior runner command disappeared after resume reservation");
    const rechecked = await this.#evaluate(candidate.command, sourcePrior, []);
    requireFence(input.expectedResumeFenceFingerprint, rechecked);
    requireEligible(rechecked.inspection);
    await this.#assertDispatchState(candidate.command, input.idempotencyKey, commandFingerprint);

    await this.#o.ledger.recordEvent({
      id: candidate.run.itemId,
      actor: this.#o.actor,
      type: "run.adapter.command_dispatched",
      payload: {
        version: RUNNER_AUTHORITATIVE_RESUME_V1,
        commandKind: "resume",
        commandId: candidate.command.commandId,
        commandFingerprint,
        resumeFenceFingerprint: input.expectedResumeFenceFingerprint,
        runId: candidate.command.runId,
        runGeneration: candidate.command.runGeneration,
        leaseGeneration: candidate.command.leaseGeneration,
        adapterId: candidate.command.adapterId,
        adapterVersion: candidate.command.adapterVersion,
        profileId: candidate.command.profileId,
        profileVersion: candidate.command.profileVersion,
        checkpointExternalId: candidate.command.checkpointRef?.externalId ?? null,
        checkpointDigest: candidate.command.checkpointRef?.digest ?? null,
        continuationId: candidate.command.continuation.id,
        continuationGeneration: candidate.command.continuation.generation,
        containsPrivateContent: false,
        containsCredentials: false,
      },
      idempotencyKey: `runner-resume-dispatch:${candidate.command.commandId}`,
    });

    const consumer = new ResumeConsumer({
      store: this.#o.store,
      ledger: this.#o.ledger,
      descriptor: this.#o.descriptor,
      command: candidate.command,
      actor: this.#o.actor,
      run: rechecked.run,
      leaseSeconds: this.#o.leaseSeconds,
      now: this.#o.now,
    });
    let consumed: Awaited<ReturnType<ResumeConsumer["consume"]>>;
    try {
      consumed = await consumer.consume(this.#o.adapter.resume(candidate.command));
    } catch {
      return result(
        "waiting_reconciliation",
        candidate.command.runId,
        candidate.command.commandId,
        commandFingerprint,
        input.expectedResumeFenceFingerprint,
        0,
        digest([]),
        null,
        null,
        null,
        await this.#o.ledger.getRun(candidate.command.runId),
      );
    }

    const observationsSha256 = digest(consumed.observations);
    const terminal = consumed.observations.at(-1) ?? null;
    if (
      terminal === null
      || !terminalObservationTypes.has(terminal.type)
      || !this.#hasDurableTerminalObservation(candidate.command, terminal)
      || !terminalCheckpointLineageIsComplete(candidate.command, terminal, consumed.latestCheckpoint)
    ) {
      return result(
        "waiting_reconciliation",
        candidate.command.runId,
        candidate.command.commandId,
        commandFingerprint,
        input.expectedResumeFenceFingerprint,
        consumed.observations.length,
        observationsSha256,
        null,
        consumed.latestCheckpoint,
        null,
        consumed.run,
      );
    }

    if (terminal.type === "interrupted") {
      try {
        await this.#advanceContinuationAfterInterruption(candidate.command, terminal);
      } catch {
        return result(
          "waiting_reconciliation",
          candidate.command.runId,
          candidate.command.commandId,
          commandFingerprint,
          input.expectedResumeFenceFingerprint,
          consumed.observations.length,
          observationsSha256,
          terminalProjection(terminal),
          consumed.latestCheckpoint,
          null,
          await this.#o.ledger.getRun(candidate.command.runId),
        );
      }
    }

    const settled = await this.#o.ledger.settleRunnerAdapterCommand({
      commandId: candidate.command.commandId,
      commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: consumed.observations.length,
        observationsSha256,
        terminalObservationId: terminal.observationId,
        terminalObservationType: terminal.type,
        latestCheckpointExternalId: consumed.latestCheckpoint?.externalId ?? null,
        latestCheckpointSha256: consumed.latestCheckpoint ? digest(consumed.latestCheckpoint) : null,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
    return result(
      "executed",
      candidate.command.runId,
      candidate.command.commandId,
      commandFingerprint,
      input.expectedResumeFenceFingerprint,
      consumed.observations.length,
      observationsSha256,
      terminalProjection(terminal),
      consumed.latestCheckpoint,
      settled.settlement,
      consumed.run,
    );
  }

  async #replay(
    input: ReturnType<typeof normalizeInput>,
    requestFingerprint: string,
    existing: RunnerAdapterCommandLookup,
  ): Promise<RunnerAuthoritativeResumeResultV1> {
    if (
      existing.command.runId !== input.runId
      || existing.command.actor.id !== this.#o.actor.id
      || existing.command.adapterId !== this.#o.descriptor.adapterId
      || existing.command.profileId !== this.#o.profile.id
      || existing.command.requestFingerprint !== requestFingerprint
    ) {
      throw conflict("idempotency_conflict", "Runner resume idempotency key belongs to a different command request");
    }
    return await this.#reservationResult(
      existing.command,
      input.expectedResumeFenceFingerprint,
      existing.settlement,
    );
  }

  async #reservationResult(
    command: RunnerAdapterCommandReservationRecord,
    fence: string,
    settlement: RunnerAdapterCommandSettlementRecord | null,
  ): Promise<RunnerAuthoritativeResumeResultV1> {
    const run = await this.#o.ledger.getRun(command.runId);
    if (!settlement) {
      return result(
        "waiting_reconciliation",
        command.runId,
        command.commandId,
        command.commandFingerprint,
        fence,
        0,
        digest([]),
        null,
        null,
        null,
        run,
      );
    }
    const admitted = admitRunnerAdapterCommandSettlementRecord(settlement);
    if (!this.#hasDurableSettlementTerminalObservation(command, admitted)) {
      return result(
        "waiting_reconciliation",
        command.runId,
        command.commandId,
        command.commandFingerprint,
        fence,
        admitted.outcome.observationCount,
        admitted.outcome.observationsSha256,
        null,
        null,
        null,
        run,
      );
    }
    return result(
      "settled_replay",
      command.runId,
      command.commandId,
      command.commandFingerprint,
      fence,
      admitted.outcome.observationCount,
      admitted.outcome.observationsSha256,
      Object.freeze({
        observationId: admitted.outcome.terminalObservationId,
        type: admitted.outcome.terminalObservationType as RunnerObservationV1["type"],
      }),
      null,
      admitted,
      run,
    );
  }

  async #fresh(runId: string, idempotencyKey: string): Promise<Candidate> {
    const observedAt = time(this.#o.now).toISOString();
    const run = await this.#o.ledger.getRun(runId);
    const detail = await this.#o.ledger.getItem(run.itemId);
    this.#assertRun(run, detail.item.project, observedAt);
    const checkpoint = currentCheckpoint(run);
    const continuation = currentContinuation(this.#o.store, run);
    const command = await this.#command(run, detail.item.project, checkpoint, continuation, idempotencyKey, observedAt);
    const commandState = runnerCommandState(this.#o.store, run.id);
    if (!commandState.latest) throw conflict("prior_command_missing", "Runner resume requires a durable prior runner command");
    const prior = commandState.unresolved[0] ?? commandState.latest;
    return await this.#evaluate(command, prior, commandState.unresolved);
  }

  async #evaluate(
    command: RunnerResumeCommandV1,
    prior: RunnerAdapterCommandLookup,
    unresolvedPriorCommands: readonly RunnerAdapterCommandLookup[],
  ): Promise<Candidate> {
    const observedAt = time(this.#o.now).toISOString();
    const run = await this.#o.ledger.getRun(command.runId);
    const detail = await this.#o.ledger.getItem(run.itemId);
    const project = detail.item.project;
    this.#assertRun(run, project, observedAt);
    if (
      run.itemId !== command.itemId
      || project !== command.project
      || run.generation !== command.runGeneration
      || run.leaseGeneration !== command.leaseGeneration
    ) throw conflict("run_identity_changed", "Runner resume run, item, project, or generation changed");
    const authority = runAuthorityFence(run);
    requireCompatibleAuthority(command.authority, authority, observedAt, true, "authority_changed");
    const checkpoint = currentCheckpoint(run);
    if (stableJson(checkpoint) !== stableJson(command.checkpointRef)) {
      throw conflict("checkpoint_changed", "Runner resume checkpoint reference changed");
    }
    const continuation = currentContinuation(this.#o.store, run);
    if (stableJson(continuation) !== stableJson(command.continuation)) {
      throw conflict("continuation_changed", "Runner resume continuation identity or generation changed");
    }

    const probe = parseRunnerCapabilityProbeV1({
      version: RUNNER_ADAPTER_V1,
      probeId: deterministicId("resume-probe", command.commandId, observedAt),
      adapterId: command.adapterId,
      adapterVersion: command.adapterVersion,
      profileId: command.profileId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      transport: this.#o.transport,
      transition: "resume",
      clientProduct: this.#o.clientProduct,
      clientBuild: this.#o.clientBuild,
      modelProfile: this.#o.modelProfile,
      externalSurfaceRef: checkpoint.externalId,
      requiredCapabilities: command.requiredCapabilities,
      recoveryActions: this.#o.recoveryActions,
      observedAt,
      traceId: command.correlationId,
    });
    let adapterSnapshot: EffectiveToolSurfaceSnapshot;
    try {
      adapterSnapshot = await this.#o.adapter.inspectCapabilities(probe);
    } catch {
      throw conflict("capability_inspection_failed", "Runner resume capability inspection failed");
    }
    const capabilityBinding = bindSnapshot(this.#o.descriptor, probe, adapterSnapshot, command);
    let evidence: RunnerAuthoritativeResumeEvidenceV1;
    try {
      evidence = await this.#o.evidenceSource.read({ command, run, checkpoint, observedAt });
    } catch {
      throw conflict("evidence_unavailable", "Runner resume authoritative evidence read failed");
    }
    let inspection: RunnerResumeInspectionReceiptV1;
    try {
      inspection = compileRunnerResumeInspectionV1({
        command,
        descriptor: this.#o.descriptor,
        expectedRuntime: this.#o.expectedRuntime,
        checkpoint: evidence.checkpoint,
        latestCheckpointGeneration: evidence.latestCheckpointGeneration,
        currentContinuation: continuation,
        checkpointToolSurface: evidence.checkpointToolSurface,
        currentCapabilityBinding: capabilityBinding,
        currentAuthority: command.authority,
        grantRefs: evidence.grantRefs,
        requiredApprovalRefs: evidence.requiredApprovalRefs,
        approvalRefs: evidence.approvalRefs,
        priorCommand: prior,
        interruption: evidence.interruption,
        latestEvidenceRefs: evidence.latestEvidenceRefs ?? [],
        observedAt,
      });
    } catch {
      throw conflict("evidence_malformed", "Runner resume authoritative evidence is malformed");
    }
    return {
      command,
      run,
      project,
      checkpoint,
      prior,
      unresolvedPriorCommands: Object.freeze([...unresolvedPriorCommands]),
      inspection,
      fence: fenceFingerprint({
        run,
        project,
        checkpoint,
        continuation,
        descriptor: this.#o.descriptor,
        expectedRuntime: this.#o.expectedRuntime,
        capabilityBinding,
        evidence,
        prior,
        unresolvedPriorCommands,
        requiredCapabilities: command.requiredCapabilities,
        capabilityGrantRefs: command.capabilityGrantRefs,
      }),
    };
  }

  async #command(
    run: WorkRun,
    project: string,
    checkpoint: RunnerExternalReferenceV1,
    continuation: RunnerResumeCommandV1["continuation"],
    idempotencyKey: string,
    issuedAt: string,
  ): Promise<RunnerResumeCommandV1> {
    const authority = runAuthorityFence(run);
    if (!authority) throw conflict("authority_missing", "Runner resume requires current run authority");
    if (!run.executionEnvelope) throw conflict("execution_envelope_missing", "Runner resume requires the durable execution envelope");
    return parseRunnerResumeCommandV1({
      version: RUNNER_ADAPTER_V1,
      kind: "resume",
      commandId: deterministicId("resume", idempotencyKey, run.id, run.generation, run.leaseGeneration),
      correlationId: deterministicId("resume-correlation", idempotencyKey, run.id),
      adapterId: this.#o.descriptor.adapterId,
      adapterVersion: this.#o.descriptor.adapterVersion,
      profileId: this.#o.profile.id,
      profileVersion: this.#o.profile.version,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      authority,
      itemId: run.itemId,
      project,
      executionEnvelope: run.executionEnvelope,
      context: await getRunnerContextPacket(this.#o.ledger, run.itemId, {
        maxCharacters: this.#o.maxContextCharacters,
        now: new Date(issuedAt),
      }),
      requiredCapabilities: this.#o.requiredCapabilities,
      capabilityGrantRefs: this.#o.capabilityGrantRefs,
      issuedAt,
      continuation,
      adapterResumeRef: checkpoint,
      checkpointRef: checkpoint,
      reason: "recovery",
    });
  }

  #assertRun(run: WorkRun, project: string, observedAt: string): void {
    if (!executableStatuses.has(run.status)) throw conflict("run_not_resumable", `Runner resume cannot execute while run is ${run.status}`);
    if (run.runnerType !== this.#o.descriptor.adapterId || run.runnerProfile !== this.#o.profile.id) {
      throw conflict("adapter_profile_mismatch", "Runner resume adapter or profile does not match the durable run");
    }
    if (!project) throw conflict("project_missing", "Runner resume project is unavailable");
    const authority = runAuthorityFence(run);
    if (!authority || authority.holderId !== this.#o.actor.id) {
      throw conflict("authority_holder_mismatch", "Runner resume caller is not the current run authority holder");
    }
    if (Date.parse(authority.expiresAt) <= Date.parse(observedAt)) {
      throw conflict("authority_expired", "Runner resume authority is expired");
    }
  }

  async #assertDispatchState(command: RunnerResumeCommandV1, idempotencyKey: string, commandFingerprint: string): Promise<void> {
    const observedAt = time(this.#o.now).toISOString();
    const run = await this.#o.ledger.getRun(command.runId);
    const detail = await this.#o.ledger.getItem(run.itemId);
    this.#assertRun(run, detail.item.project, observedAt);
    requireCompatibleAuthority(command.authority, runAuthorityFence(run), observedAt, true, "dispatch_fence_changed");
    if (
      run.itemId !== command.itemId
      || detail.item.project !== command.project
      || run.generation !== command.runGeneration
      || run.leaseGeneration !== command.leaseGeneration
      || stableJson(currentCheckpoint(run)) !== stableJson(command.checkpointRef)
      || stableJson(currentContinuation(this.#o.store, run)) !== stableJson(command.continuation)
    ) throw conflict("dispatch_fence_changed", "Runner resume decisive run evidence changed before dispatch");
    const commandState = runnerCommandState(this.#o.store, command.runId);
    const reserved = await this.#o.ledger.getRunnerAdapterCommand({ idempotencyKey });
    const otherUnresolved = commandState.unresolved.filter((entry) => entry.command.commandId !== command.commandId);
    if (
      commandState.latest?.command.commandId !== command.commandId
      || otherUnresolved.length > 0
      || !reserved
      || reserved.command.commandId !== command.commandId
      || reserved.command.commandFingerprint !== commandFingerprint
      || reserved.settlement !== null
    ) throw conflict("reservation_changed", "Runner resume reservation or outstanding command state changed before dispatch");
  }

  #hasDurableTerminalObservation(
    command: RunnerResumeCommandV1,
    terminal: RunnerObservationV1,
  ): boolean {
    return this.#hasDurableTerminalEvent(
      {
        itemId: command.itemId,
        actorId: this.#o.actor.id,
        commandId: command.commandId,
        runId: command.runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        adapterId: command.adapterId,
        adapterVersion: command.adapterVersion,
        profileId: command.profileId,
        profileVersion: command.profileVersion,
      },
      terminal.observationId,
      terminal.type,
      digest(terminal),
    );
  }

  #hasDurableSettlementTerminalObservation(
    command: RunnerAdapterCommandReservationRecord,
    settlement: RunnerAdapterCommandSettlementRecord,
  ): boolean {
    const type = settlement.outcome.terminalObservationType;
    if (!terminalObservationTypes.has(type as RunnerObservationV1["type"])) return false;
    if (
      type === "interrupted"
      && (settlement.outcome.latestCheckpointExternalId === null || settlement.outcome.latestCheckpointSha256 === null)
    ) return false;
    return this.#hasDurableTerminalEvent(
      {
        itemId: command.itemId,
        actorId: command.actor.id,
        commandId: command.commandId,
        runId: command.runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        adapterId: command.adapterId,
        adapterVersion: this.#o.descriptor.adapterVersion,
        profileId: command.profileId,
        profileVersion: this.#o.profile.version,
      },
      settlement.outcome.terminalObservationId,
      type,
      null,
    );
  }

  #hasDurableTerminalEvent(
    identity: {
      itemId: string;
      actorId: string;
      commandId: string;
      runId: string;
      runGeneration: number;
      leaseGeneration: number;
      adapterId: string;
      adapterVersion: string;
      profileId: string;
      profileVersion: string;
    },
    observationId: string,
    observationType: string,
    expectedObservationFingerprint: string | null,
  ): boolean {
    const key = `runner-resume-observation:${identity.commandId}:${observationId}`;
    const row = this.#o.store.db.query<DurableObservationEventRow, [string, string]>(`
      SELECT actor_id, type, payload_json
      FROM events
      WHERE item_id = ?1 AND idempotency_key = ?2
      LIMIT 1
    `).get(identity.itemId, key);
    if (!row || row.actor_id !== identity.actorId || row.type !== "run.adapter.observation") return false;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      return false;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const value = payload as Record<string, unknown>;
    const observationFingerprint = value.observationFingerprint;
    return value.version === RUNNER_AUTHORITATIVE_RESUME_V1
      && value.observationId === observationId
      && value.observationType === observationType
      && typeof observationFingerprint === "string"
      && /^sha256:[a-f0-9]{64}$/u.test(observationFingerprint)
      && (expectedObservationFingerprint === null || observationFingerprint === expectedObservationFingerprint)
      && value.commandId === identity.commandId
      && value.runId === identity.runId
      && value.runGeneration === identity.runGeneration
      && value.leaseGeneration === identity.leaseGeneration
      && value.adapterId === identity.adapterId
      && value.adapterVersion === identity.adapterVersion
      && value.profileId === identity.profileId
      && value.profileVersion === identity.profileVersion
      && value.containsPrivateContent === false
      && value.containsCredentials === false;
  }

  async #advanceContinuationAfterInterruption(
    command: RunnerResumeCommandV1,
    terminal: Extract<RunnerObservationV1, { type: "interrupted" }>,
  ): Promise<void> {
    const current = getContinuation(this.#o.store, command.continuation.id);
    if (
      current.generation !== command.continuation.generation
      || (current.status !== "proposed" && current.status !== "deferred")
    ) throw conflict("continuation_changed", "Runner resume continuation changed before interruption settlement");
    const advanced = editContinuation(this.#o.store, {
      id: current.id,
      actor: this.#o.actor,
      expectedGeneration: current.generation,
      instruction: current.instruction,
      note: "Advance continuation lineage after a durable runner interruption.",
      idempotencyKey: deterministicId("resume-continuation", command.commandId, terminal.observationId),
    });
    if (advanced.generation !== command.continuation.generation + 1) {
      throw conflict("continuation_lineage_not_advanced", "Runner resume interruption did not advance continuation lineage exactly once");
    }
    const run = await this.#o.ledger.getRun(command.runId);
    const durable = currentContinuation(this.#o.store, run);
    if (durable.id !== command.continuation.id || durable.generation !== advanced.generation) {
      throw conflict("continuation_lineage_not_durable", "Runner resume interruption continuation lineage was not durably readable");
    }
  }
}

class ResumeConsumer {
  readonly #store: StensiblyStore;
  readonly #ledger: RunnerAuthoritativeResumeLedgerV1;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #command: RunnerResumeCommandV1;
  readonly #actor: ActorInput;
  readonly #leaseSeconds: number;
  readonly #now: () => Date;
  #run: WorkRun;
  #latestCheckpoint: RunnerExternalReferenceV1 | null;
  readonly #observations: RunnerObservationV1[] = [];
  readonly #seen = new Map<string, string>();
  #bytes = 0;

  constructor(input: {
    store: StensiblyStore;
    ledger: RunnerAuthoritativeResumeLedgerV1;
    descriptor: RunnerAdapterDescriptorV1;
    command: RunnerResumeCommandV1;
    actor: ActorInput;
    run: WorkRun;
    leaseSeconds: number;
    now: () => Date;
  }) {
    this.#store = input.store;
    this.#ledger = input.ledger;
    this.#descriptor = parseRunnerAdapterDescriptorV1(input.descriptor);
    this.#command = parseRunnerResumeCommandV1(input.command);
    this.#actor = Object.freeze({ ...input.actor });
    this.#run = input.run;
    this.#leaseSeconds = input.leaseSeconds;
    this.#now = input.now;
    this.#latestCheckpoint = this.#command.checkpointRef;
    this.#assertRun(this.#run);
  }

  async consume(stream: AsyncIterable<RunnerObservationV1>) {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        await this.#refresh();
        const next = await iterator.next();
        if (next.done) break;
        await this.#refresh();
        const observation = assertRunnerObservationBinding(this.#descriptor, this.#command, next.value);
        const canonical = stableJson(observation);
        const existing = this.#seen.get(observation.observationId);
        if (existing !== undefined) {
          if (existing !== canonical) throw new RangeError("Runner observation replay changed content");
          continue;
        }
        if (this.#seen.size >= maxObservations) throw new RangeError("Runner resume episode exceeds the observation count bound");
        this.#bytes += new TextEncoder().encode(canonical).byteLength;
        if (this.#bytes > maxObservationBytes) throw new RangeError("Runner resume episode exceeds the observation byte bound");
        this.#seen.set(observation.observationId, canonical);
        await this.#receipt(observation);
        await this.#evidence(observation);
        this.#observations.push(observation);
      }
    } finally {
      await iterator.return?.();
    }
    return {
      observations: Object.freeze([...this.#observations]),
      latestCheckpoint: this.#latestCheckpoint,
      run: this.#run,
    };
  }

  async #refresh(): Promise<void> {
    this.#run = await this.#ledger.getRun(this.#command.runId);
    this.#assertRun(this.#run);
  }

  #assertRun(run: WorkRun): void {
    const observedAt = time(this.#now).toISOString();
    if (
      !executableStatuses.has(run.status)
      || run.id !== this.#command.runId
      || run.itemId !== this.#command.itemId
      || run.generation !== this.#command.runGeneration
      || run.leaseGeneration !== this.#command.leaseGeneration
    ) throw conflict("authority_changed_during_resume", "Runner resume no longer matches current durable run authority");
    requireCompatibleAuthority(
      this.#command.authority,
      runAuthorityFence(run),
      observedAt,
      false,
      "authority_changed_during_resume",
    );
    if (stableJson(currentContinuation(this.#store, run)) !== stableJson(this.#command.continuation)) {
      throw conflict("continuation_changed_during_resume", "Runner resume continuation changed during adapter execution");
    }
    if (stableJson(currentCheckpoint(run)) !== stableJson(this.#latestCheckpoint)) {
      throw conflict("checkpoint_changed_during_resume", "Runner resume checkpoint changed without an admitted adapter observation");
    }
    const state = runnerCommandState(this.#store, run.id);
    if (state.latest?.command.commandId !== this.#command.commandId) {
      throw conflict("command_changed_during_resume", "Runner resume command is no longer the latest durable command");
    }
  }

  async #receipt(observation: RunnerObservationV1): Promise<void> {
    await this.#ledger.recordEvent({
      id: this.#run.itemId,
      actor: this.#actor,
      type: "run.adapter.observation",
      payload: {
        version: RUNNER_AUTHORITATIVE_RESUME_V1,
        observationId: observation.observationId,
        observationType: observation.type,
        observationFingerprint: digest(observation),
        commandId: observation.commandId,
        runId: observation.runId,
        runGeneration: observation.runGeneration,
        leaseGeneration: observation.leaseGeneration,
        adapterId: observation.adapterId,
        adapterVersion: observation.adapterVersion,
        profileId: observation.profileId,
        profileVersion: observation.profileVersion,
        observedAt: observation.observedAt,
        referenceCount: observation.references.length,
        referencesFingerprint: digest(observation.references),
        containsPrivateContent: false,
        containsCredentials: false,
      },
      idempotencyKey: `runner-resume-observation:${observation.commandId}:${observation.observationId}`,
    });
  }

  async #evidence(observation: RunnerObservationV1): Promise<void> {
    if (observation.type === "heartbeat") {
      if (observation.checkpointRef) this.#checkpoint(observation.checkpointRef, false);
      this.#latestCheckpoint = observation.checkpointRef ?? this.#latestCheckpoint;
      this.#run = await this.#ledger.heartbeatRun({
        id: this.#run.id,
        actor: this.#actor,
        expectedGeneration: this.#run.generation,
        expectedLeaseGeneration: this.#run.leaseGeneration,
        leaseSeconds: this.#remainingLease(),
        usage: observation.usage,
        ...(observation.checkpointRef ? { checkpoint: serializeReference(observation.checkpointRef) } : {}),
        idempotencyKey: `runner-resume-heartbeat:${observation.commandId}:${observation.observationId}`,
      });
      return;
    }
    if (observation.type === "checkpoint_published") {
      this.#checkpoint(observation.reference, true);
      this.#latestCheckpoint = observation.reference;
      this.#run = await this.#ledger.heartbeatRun({
        id: this.#run.id,
        actor: this.#actor,
        expectedGeneration: this.#run.generation,
        expectedLeaseGeneration: this.#run.leaseGeneration,
        leaseSeconds: this.#remainingLease(),
        checkpoint: serializeReference(observation.reference),
        idempotencyKey: `runner-resume-checkpoint:${observation.commandId}:${observation.observationId}`,
      });
    }
  }

  #checkpoint(reference: RunnerExternalReferenceV1, requireNewer: boolean): void {
    const previous = this.#latestCheckpoint?.generation;
    if (
      reference.kind !== "checkpoint"
      || reference.adapterId !== this.#command.adapterId
      || reference.uri !== null
      || reference.externalId === null
      || reference.digest === null
      || reference.generation === null
      || (requireNewer && previous !== null && previous !== undefined && reference.generation <= previous)
    ) throw new RangeError("Runner resume checkpoint reference does not match the active command lineage");
  }

  #remainingLease(): number {
    const expiresAt = runAuthorityFence(this.#run)?.expiresAt;
    if (!expiresAt) throw conflict("authority_missing_during_resume", "Runner resume authority disappeared during adapter execution");
    const seconds = Math.floor((Date.parse(expiresAt) - time(this.#now).getTime()) / 1_000);
    return Math.max(30, Math.min(this.#leaseSeconds, seconds));
  }
}

function normalizeOptions(input: RunnerAuthoritativeResumeOptionsV1): Options {
  const descriptor = parseRunnerAdapterDescriptorV1(input.adapter.describe());
  if (!descriptor.supports.resume || !descriptor.supports.capabilityInspection || descriptor.checkpointMode === "none") {
    throw new RangeError("Runner authoritative resume requires resume, capability inspection, and checkpoints");
  }
  const profile = descriptor.profiles.find((entry) => entry.id === input.profileId);
  if (!profile) throw new RangeError("Runner authoritative resume profile is absent from adapter descriptor");
  const transport = input.transport ?? descriptor.transports[0];
  if (!transport || !descriptor.transports.includes(transport)) throw new RangeError("Runner authoritative resume transport is unsupported");
  return {
    store: input.store,
    ledger: input.ledger,
    adapter: input.adapter,
    descriptor,
    actor: Object.freeze({ ...input.actor }),
    profile,
    expectedRuntime: Object.freeze({ ...input.expectedRuntime }),
    evidenceSource: input.evidenceSource,
    requiredCapabilities: Object.freeze([...(input.requiredCapabilities ?? [])]),
    capabilityGrantRefs: Object.freeze([...(input.capabilityGrantRefs ?? [])]),
    transport,
    clientProduct: input.clientProduct ?? "stensibly-authoritative-resume",
    clientBuild: input.clientBuild ?? "1.0.0",
    modelProfile: input.modelProfile ?? profile.id,
    recoveryActions: Object.freeze([...(input.recoveryActions ?? ["resume_with_current_tools"])]),
    maxContextCharacters: integer(input.maxContextCharacters ?? 12_000, 2_000, 50_000, "Runner resume context characters"),
    leaseSeconds: integer(input.leaseSeconds ?? 900, 30, 86_400, "Runner resume lease seconds"),
    now: input.now ?? (() => new Date()),
  };
}

function normalizeInput(input: RunnerAuthoritativeResumeInputV1) {
  return Object.freeze({
    runId: identifier(input.runId, "Runner resume run ID", 240),
    idempotencyKey: identifier(input.idempotencyKey, "Runner resume idempotency key", 240),
    expectedResumeFenceFingerprint: fingerprint(input.expectedResumeFenceFingerprint, "Runner resume expected fence fingerprint"),
  });
}

function currentContinuation(store: StensiblyStore, run: WorkRun): RunnerResumeCommandV1["continuation"] {
  if (!run.continuationRef) throw conflict("continuation_missing", "Runner resume requires a durable continuation identity");
  let continuation: ContinuationProposal;
  try {
    continuation = getContinuation(store, run.continuationRef);
  } catch {
    throw conflict("continuation_missing", "Runner resume continuation is unavailable");
  }
  if (closedContinuationStatuses.has(continuation.status)) {
    throw conflict("continuation_superseded", `Runner resume continuation is ${continuation.status}`);
  }
  if (
    continuation.sourceRunId !== null
    && continuation.sourceRunId !== run.id
    && continuation.result?.runId !== run.id
  ) throw conflict("continuation_run_mismatch", "Runner resume continuation belongs to another run lineage");
  return Object.freeze({ id: continuation.id, generation: continuation.generation });
}

function currentCheckpoint(run: WorkRun): RunnerExternalReferenceV1 {
  if (!run.checkpoint) throw conflict("checkpoint_missing", "Runner resume requires a durable checkpoint reference");
  let checkpoint: RunnerExternalReferenceV1;
  try {
    checkpoint = parseRunnerExternalReferenceV1(JSON.parse(run.checkpoint) as unknown);
  } catch {
    throw conflict("checkpoint_malformed", "Runner resume checkpoint reference is malformed");
  }
  if (
    checkpoint.kind !== "checkpoint"
    || checkpoint.externalId === null
    || checkpoint.digest === null
    || checkpoint.generation === null
  ) throw conflict("checkpoint_incomplete", "Runner resume checkpoint reference lacks exact identity, digest, or generation");
  return checkpoint;
}

function runnerCommandState(store: StensiblyStore, runId: string): RunnerCommandState {
  ensureRunnerAdapterCommandSchema(store);
  const rows = store.db.query<{ idempotency_key: string }, [string, number]>(`
    SELECT idempotency_key FROM runner_adapter_commands
    WHERE run_id = ?1
    ORDER BY reserved_at DESC, command_id DESC
    LIMIT ?2
  `).all(runId, maxPriorCommands + 1);
  if (rows.length > maxPriorCommands) {
    throw conflict("prior_command_history_unbounded", "Runner resume prior command history exceeds the bounded authoritative scan");
  }
  const commands = rows.map((row) => getSqliteRunnerAdapterCommand(store, { idempotencyKey: row.idempotency_key }));
  if (commands.some((entry) => entry === null)) {
    throw conflict("prior_command_missing", "Runner resume prior command lookup became incomplete");
  }
  const admitted = commands as RunnerAdapterCommandLookup[];
  return Object.freeze({
    latest: admitted[0] ?? null,
    unresolved: Object.freeze(admitted.filter((entry) => entry.settlement === null)),
  });
}

function bindSnapshot(
  descriptor: RunnerAdapterDescriptorV1,
  probe: ReturnType<typeof parseRunnerCapabilityProbeV1>,
  snapshot: EffectiveToolSurfaceSnapshot,
  command: RunnerResumeCommandV1,
): RunnerCapabilityCommandBindingV1 {
  const classes = {} as Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
  for (const [name, value] of Object.entries(snapshot.classes)) {
    classes[name as EffectiveToolSurfaceClass] = {
      catalogue: value.catalogueCapabilities.map(capabilityInput),
      executable: value.executableCapabilities.map(capabilityInput),
      provenance: value.provenance,
    };
  }
  const inspection = buildRunnerCapabilityInspectionV1(descriptor, probe, classes);
  if (
    inspection.snapshot.surfaceFingerprint !== snapshot.surfaceFingerprint
    || inspection.snapshot.requiredFingerprint !== snapshot.requiredFingerprint
    || inspection.snapshot.snapshotFingerprint !== snapshot.snapshotFingerprint
  ) throw conflict("capability_snapshot_mismatch", "Runner adapter capability inspection changed while being admitted");
  return bindRunnerCapabilityInspectionToCommandV1(inspection, command);
}

function capabilityInput(value: { id: string; name: string | null }): ToolSurfaceCapabilityInput {
  return value.name === null ? { id: value.id } : { id: value.id, name: value.name };
}

function fenceFingerprint(input: {
  run: WorkRun;
  project: string;
  checkpoint: RunnerExternalReferenceV1;
  continuation: RunnerResumeCommandV1["continuation"];
  descriptor: RunnerAdapterDescriptorV1;
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  capabilityBinding: RunnerCapabilityCommandBindingV1;
  evidence: RunnerAuthoritativeResumeEvidenceV1;
  prior: RunnerAdapterCommandLookup;
  unresolvedPriorCommands: readonly RunnerAdapterCommandLookup[];
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs: readonly string[];
}): string {
  const current = input.capabilityBinding.inspection.snapshot;
  return digest({
    version: RUNNER_AUTHORITATIVE_RESUME_V1,
    project: input.project,
    itemId: input.run.itemId,
    runId: input.run.id,
    runGeneration: input.run.generation,
    leaseGeneration: input.run.leaseGeneration,
    authority: authorityGeneration(runAuthorityFence(input.run)),
    checkpoint: input.checkpoint,
    continuation: input.continuation,
    adapter: {
      id: input.descriptor.adapterId,
      version: input.descriptor.adapterVersion,
      profileId: input.capabilityBinding.inspection.profileId,
      profileVersion: input.capabilityBinding.inspection.profileVersion,
    },
    expectedRuntime: input.expectedRuntime,
    requiredCapabilities: [...input.requiredCapabilities],
    capabilityGrantRefs: [...input.capabilityGrantRefs],
    currentCapabilities: {
      surfaceFingerprint: current.surfaceFingerprint,
      requiredFingerprint: current.requiredFingerprint,
      missingRequiredCapabilities: current.missingRequiredCapabilities,
    },
    checkpointCapabilities: input.evidence.checkpointToolSurface
      ? {
        surfaceFingerprint: input.evidence.checkpointToolSurface.surfaceFingerprint,
        requiredFingerprint: input.evidence.checkpointToolSurface.requiredFingerprint,
      }
      : null,
    checkpointSource: input.evidence.checkpoint,
    latestCheckpointGeneration: input.evidence.latestCheckpointGeneration,
    grants: input.evidence.grantRefs,
    requiredApprovalRefs: [...input.evidence.requiredApprovalRefs],
    approvals: input.evidence.approvalRefs,
    priorCommand: commandIdentity(input.prior),
    unresolvedPriorCommands: input.unresolvedPriorCommands.map(commandIdentity),
    interruption: input.evidence.interruption,
  });
}

function commandIdentity(input: RunnerAdapterCommandLookup) {
  return {
    commandId: input.command.commandId,
    commandFingerprint: input.command.commandFingerprint,
    idempotencyKey: input.command.idempotencyKey,
    runGeneration: input.command.runGeneration,
    leaseGeneration: input.command.leaseGeneration,
    settlementOutcomeSha256: input.settlement?.outcomeSha256 ?? null,
  };
}

function authorityGeneration(authority: RunAuthorityFence | null) {
  return authority === null
    ? null
    : {
      resource: authority.resource,
      holderId: authority.holderId,
      generation: authority.generation,
    };
}

function requireCompatibleAuthority(
  expected: RunAuthorityFence,
  current: RunAuthorityFence | null,
  observedAt: string,
  requireNoExpiryNarrowing: boolean,
  reason: string,
): void {
  const observedMs = Date.parse(observedAt);
  if (
    current === null
    || current.resource !== expected.resource
    || current.holderId !== expected.holderId
    || current.generation !== expected.generation
    || current.generation < 1
    || Date.parse(current.expiresAt) <= observedMs
    || (requireNoExpiryNarrowing && Date.parse(current.expiresAt) < Date.parse(expected.expiresAt))
  ) throw conflict(reason, "Runner resume authoritative lease generation, holder, or freshness changed");
}

function terminalCheckpointLineageIsComplete(
  command: RunnerResumeCommandV1,
  terminal: RunnerObservationV1,
  latestCheckpoint: RunnerExternalReferenceV1 | null,
): boolean {
  if (terminal.type !== "interrupted") return true;
  const checkpoint = terminal.checkpointRef;
  const priorGeneration = command.checkpointRef?.generation;
  return checkpoint !== null
    && latestCheckpoint !== null
    && checkpoint.kind === "checkpoint"
    && checkpoint.externalId !== null
    && checkpoint.digest !== null
    && checkpoint.generation !== null
    && priorGeneration !== null
    && priorGeneration !== undefined
    && checkpoint.generation > priorGeneration
    && stableJson(checkpoint) === stableJson(latestCheckpoint);
}

function requireFence(expected: string, candidate: Candidate): void {
  if (candidate.fence !== expected) throw conflict("stale_resume_fence", "Runner resume evidence changed from the expected authoritative fence");
}

function requireEligible(receipt: RunnerResumeInspectionReceiptV1): void {
  if (receipt.decision === "eligible" && receipt.resumeEligible) return;
  const failed = receipt.checks.find((check) => check.state !== "pass");
  throw conflict(failed?.code ?? "resume_not_eligible", failed?.summary ?? "Runner resume evidence is not fully eligible");
}

function terminalProjection(terminal: RunnerObservationV1): RunnerAuthoritativeResumeTerminalObservationV1 {
  return Object.freeze({ observationId: terminal.observationId, type: terminal.type });
}

function publicRun(run: WorkRun): RunnerAuthoritativeResumeRunProjectionV1 {
  return Object.freeze({
    status: run.status,
    generation: run.generation,
    leaseGeneration: run.leaseGeneration,
  });
}

function result(
  disposition: RunnerAuthoritativeResumeResultV1["disposition"],
  runId: string,
  commandId: string,
  commandFingerprint: string,
  resumeFenceFingerprint: string,
  observationCount: number,
  observationsSha256: string,
  terminalObservation: RunnerAuthoritativeResumeTerminalObservationV1 | null,
  latestCheckpoint: RunnerExternalReferenceV1 | null,
  settlement: RunnerAdapterCommandSettlementRecord | null,
  run: WorkRun,
): RunnerAuthoritativeResumeResultV1 {
  return Object.freeze({
    version: RUNNER_AUTHORITATIVE_RESUME_V1,
    disposition,
    runId,
    commandId,
    commandFingerprint,
    resumeFenceFingerprint,
    observationCount,
    observationsSha256,
    terminalObservation,
    latestCheckpoint,
    settlement,
    run: publicRun(run),
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function serializeReference(reference: RunnerExternalReferenceV1): string {
  const value = stableJson(reference);
  if (value.length > 10_000) throw new RangeError("Runner resume checkpoint reference exceeds the durable run bound");
  return value;
}

function deterministicId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(stableJson(parts)).digest("hex")}`;
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
}

function time(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RangeError("Runner authoritative resume clock is invalid");
  return new Date(value.getTime());
}

function identifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new RangeError(`${label} is invalid`);
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}`);
  }
  return Number(value);
}

function conflict(reason: string, message: string): RunnerAuthoritativeResumeConflictError {
  return new RunnerAuthoritativeResumeConflictError(reason, message);
}
