import { createHash } from "node:crypto";
import { runAuthorityFence } from "./authority-fence.js";
import { sha256, stableJson } from "./canonical-json.js";
import { getRunnerContextPacket } from "./context-packets.js";
import { getContinuation, type ContinuationProposal } from "./continuations.js";
import { recordEffectiveToolSurfaceEvent } from "./effective-tool-surface-events.js";
import type {
  EffectiveToolSurfaceClass,
  EffectiveToolSurfaceSnapshot,
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

export interface RunnerAuthoritativeResumeResultV1 {
  version: typeof RUNNER_AUTHORITATIVE_RESUME_V1;
  disposition: "executed" | "settled_replay" | "waiting_reconciliation";
  runId: string;
  commandId: string;
  commandFingerprint: string;
  resumeFenceFingerprint: string;
  observations: readonly RunnerObservationV1[];
  latestCheckpoint: RunnerExternalReferenceV1 | null;
  settlement: RunnerAdapterCommandSettlementRecord | null;
  run: WorkRun;
  containsPrivateContent: false;
  containsCredentials: false;
}

export class RunnerAuthoritativeResumeConflictError extends Error {
  readonly code = "runner_authoritative_resume_conflict";
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "RunnerAuthoritativeResumeConflictError";
    this.reason = reason;
  }
}

interface NormalizedOptions {
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

interface ResumeCandidate {
  command: RunnerResumeCommandV1;
  run: WorkRun;
  project: string;
  checkpoint: RunnerExternalReferenceV1;
  priorCommand: RunnerAdapterCommandLookup;
  inspection: RunnerResumeInspectionReceiptV1;
  resumeFenceFingerprint: string;
}

interface LatestCommandRow {
  idempotency_key: string;
}

const maximumEpisodeObservations = 32;
const maximumEpisodeObservationBytes = 256 * 1024;
const executableResumeStatuses = new Set(["starting", "running", "waiting"]);
const blockedContinuationStatuses = new Set(["rejected", "cancelled", "superseded", "expired"]);

/**
 * Server-owned authoritative resume boundary for one interrupted runner lineage.
 *
 * Public callers supply only intent, one idempotency identity, and a stale-state
 * fence. All authority, checkpoint, continuation, capability, grant, approval,
 * and prior-settlement evidence is rebuilt from server-owned sources.
 */
export class RunnerAuthoritativeResumeServiceV1 {
  readonly #options: NormalizedOptions;
  #active = false;

  constructor(options: RunnerAuthoritativeResumeOptionsV1) {
    this.#options = normalizeOptions(options);
  }

  async preview(input: { runId: string; idempotencyKey: string }): Promise<RunnerAuthoritativeResumePreviewV1> {
    const runId = identifier(input.runId, "Runner resume run ID", 240);
    const idempotencyKey = identifier(input.idempotencyKey, "Runner resume idempotency key", 240);
    const candidate = await this.#buildFreshCandidate(runId, idempotencyKey);
    return Object.freeze({
      version: RUNNER_AUTHORITATIVE_RESUME_V1,
      runId: candidate.run.id,
      itemId: candidate.run.itemId,
      project: candidate.project,
      decision: candidate.inspection.decision,
      resumeFenceFingerprint: candidate.resumeFenceFingerprint,
      inspectionFingerprint: candidate.inspection.receiptFingerprint,
      commandId: candidate.command.commandId,
      consequences: Object.freeze([
        "Reserve one exact durable runner resume command under the current run authority fence.",
        "Invoke the admitted runner adapter resume path at most once for this command identity.",
        "Persist only bounded observation fingerprints, checkpoint references, and terminal settlement evidence.",
        "Leave any reserved command without proven settlement in reconciliation-required state.",
      ]),
      authorizesMutation: false,
      authorizesResume: false,
    });
  }

  async resume(rawInput: RunnerAuthoritativeResumeInputV1): Promise<RunnerAuthoritativeResumeResultV1> {
    if (this.#active) {
      throw new RunnerAuthoritativeResumeConflictError(
        "service_busy",
        "Runner authoritative resume service already has an active command",
      );
    }
    this.#active = true;
    try {
      return await this.#resume(rawInput);
    } finally {
      this.#active = false;
    }
  }

  async #resume(rawInput: RunnerAuthoritativeResumeInputV1): Promise<RunnerAuthoritativeResumeResultV1> {
    const input = normalizeResumeInput(rawInput);
    const requestFingerprint = resumeRequestFingerprint(input, this.#options);
    const existing = await this.#options.ledger.getRunnerAdapterCommand({
      idempotencyKey: input.idempotencyKey,
    });
    if (existing !== null) {
      return await this.#replayExisting(input, requestFingerprint, existing);
    }

    const candidate = await this.#buildFreshCandidate(input.runId, input.idempotencyKey);
    this.#requireExpectedFence(input.expectedResumeFenceFingerprint, candidate);
    this.#requireEligible(candidate.inspection);

    const commandFingerprint = digest(candidate.command);
    const reservation = await this.#options.ledger.reserveRunnerAdapterCommand({
      project: candidate.project,
      itemId: candidate.run.itemId,
      runId: candidate.run.id,
      runGeneration: candidate.run.generation,
      leaseGeneration: candidate.run.leaseGeneration,
      actor: this.#options.actor,
      adapterId: candidate.command.adapterId,
      profileId: candidate.command.profileId,
      requestFingerprint,
      commandId: candidate.command.commandId,
      commandFingerprint,
      idempotencyKey: input.idempotencyKey,
    });
    if (!reservation.dispatchAuthorized) {
      return this.#resultFromReservation(
        candidate.run,
        input.expectedResumeFenceFingerprint,
        reservation.command.commandId,
        reservation.command.commandFingerprint,
        reservation.settlement,
      );
    }
    if (
      reservation.command.commandId !== candidate.command.commandId
      || reservation.command.commandFingerprint !== commandFingerprint
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "reservation_identity_changed",
        "Runner resume reservation changed exact command identity",
      );
    }

    // Rebuild every decisive fact around the exact reserved command immediately
    // before adapter dispatch. The source prior command is re-read by its exact
    // durable key so the resume reservation itself is not mistaken for prior work.
    const sourcePrior = await this.#options.ledger.getRunnerAdapterCommand({
      idempotencyKey: candidate.priorCommand.command.idempotencyKey,
    });
    if (sourcePrior === null) {
      throw new RunnerAuthoritativeResumeConflictError(
        "prior_command_disappeared",
        "Runner resume source command disappeared after reservation",
      );
    }
    const rechecked = await this.#evaluateCommand(candidate.command, sourcePrior);
    this.#requireExpectedFence(input.expectedResumeFenceFingerprint, rechecked);
    this.#requireEligible(rechecked.inspection);
    const latest = latestRunnerCommand(this.#options.store, candidate.command.runId);
    if (latest?.command.commandId !== candidate.command.commandId) {
      throw new RunnerAuthoritativeResumeConflictError(
        "newer_command_reserved",
        "Another runner command became current before resume dispatch",
      );
    }
    const currentReservation = await this.#options.ledger.getRunnerAdapterCommand({
      idempotencyKey: input.idempotencyKey,
    });
    if (
      currentReservation === null
      || currentReservation.command.commandId !== candidate.command.commandId
      || currentReservation.command.commandFingerprint !== commandFingerprint
      || currentReservation.settlement !== null
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "reservation_changed",
        "Runner resume reservation changed before adapter dispatch",
      );
    }

    await this.#options.ledger.recordEvent({
      id: candidate.run.itemId,
      actor: this.#options.actor,
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

    const consumer = new ResumeObservationConsumerV1({
      ledger: this.#options.ledger,
      descriptor: this.#options.descriptor,
      command: candidate.command,
      actor: this.#options.actor,
      initialRun: rechecked.run,
      leaseSeconds: this.#options.leaseSeconds,
      now: this.#options.now,
    });

    let consumed: Awaited<ReturnType<ResumeObservationConsumerV1["consume"]>>;
    try {
      consumed = await consumer.consume(this.#options.adapter.resume(candidate.command));
    } catch {
      const run = await this.#options.ledger.getRun(candidate.command.runId);
      return result(
        "waiting_reconciliation",
        candidate.command.runId,
        candidate.command.commandId,
        commandFingerprint,
        input.expectedResumeFenceFingerprint,
        [],
        null,
        null,
        run,
      );
    }
    const terminal = consumed.observations.at(-1);
    if (!terminal) {
      return result(
        "waiting_reconciliation",
        candidate.command.runId,
        candidate.command.commandId,
        commandFingerprint,
        input.expectedResumeFenceFingerprint,
        [],
        consumed.latestCheckpoint,
        null,
        consumed.run,
      );
    }
    const settlement = await this.#options.ledger.settleRunnerAdapterCommand({
      commandId: candidate.command.commandId,
      commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: consumed.observations.length,
        observationsSha256: digest(consumed.observations),
        terminalObservationId: terminal.observationId,
        terminalObservationType: terminal.type,
        latestCheckpointExternalId: consumed.latestCheckpoint?.externalId ?? null,
        latestCheckpointSha256: consumed.latestCheckpoint === null
          ? null
          : digest(consumed.latestCheckpoint),
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
      consumed.observations,
      consumed.latestCheckpoint,
      settlement.settlement,
      consumed.run,
    );
  }

  async #replayExisting(
    input: ReturnType<typeof normalizeResumeInput>,
    requestFingerprint: string,
    existing: RunnerAdapterCommandLookup,
  ): Promise<RunnerAuthoritativeResumeResultV1> {
    const descriptor = this.#options.descriptor;
    if (
      existing.command.runId !== input.runId
      || existing.command.actor.id !== this.#options.actor.id
      || existing.command.adapterId !== descriptor.adapterId
      || existing.command.profileId !== this.#options.profile.id
      || existing.command.requestFingerprint !== requestFingerprint
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "idempotency_conflict",
        "Runner resume idempotency key was already used for a different command request",
      );
    }
    const run = await this.#options.ledger.getRun(existing.command.runId);
    if (existing.settlement === null) {
      return result(
        "waiting_reconciliation",
        existing.command.runId,
        existing.command.commandId,
        existing.command.commandFingerprint,
        input.expectedResumeFenceFingerprint,
        [],
        null,
        null,
        run,
      );
    }
    const settlement = admitRunnerAdapterCommandSettlementRecord(existing.settlement);
    return result(
      "settled_replay",
      existing.command.runId,
      existing.command.commandId,
      existing.command.commandFingerprint,
      input.expectedResumeFenceFingerprint,
      [],
      null,
      settlement,
      run,
    );
  }

  async #buildFreshCandidate(runId: string, idempotencyKey: string): Promise<ResumeCandidate> {
    const observedAt = invocationTime(this.#options.now).toISOString();
    const run = await this.#options.ledger.getRun(runId);
    const detail = await this.#options.ledger.getItem(run.itemId);
    const project = detail.item.project;
    this.#assertCurrentRunIdentity(run, project, observedAt);
    const checkpoint = parseCurrentCheckpoint(run);
    const continuation = currentContinuation(this.#options.store, run);
    const command = await this.#buildCommand(
      run,
      project,
      checkpoint,
      continuation,
      idempotencyKey,
      observedAt,
    );
    const prior = latestRunnerCommand(this.#options.store, run.id);
    if (prior === null) {
      throw new RunnerAuthoritativeResumeConflictError(
        "prior_command_missing",
        "Runner resume requires one latest durable prior runner command",
      );
    }
    return await this.#evaluateCommand(command, prior);
  }

  async #evaluateCommand(
    command: RunnerResumeCommandV1,
    priorCommand: RunnerAdapterCommandLookup,
  ): Promise<ResumeCandidate> {
    const observedAt = invocationTime(this.#options.now).toISOString();
    const run = await this.#options.ledger.getRun(command.runId);
    const detail = await this.#options.ledger.getItem(run.itemId);
    const project = detail.item.project;
    this.#assertCurrentRunIdentity(run, project, observedAt);
    if (
      run.itemId !== command.itemId
      || project !== command.project
      || run.generation !== command.runGeneration
      || run.leaseGeneration !== command.leaseGeneration
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "run_identity_changed",
        "Runner resume run, project, item, or generation changed",
      );
    }
    const currentAuthority = runAuthorityFence(run);
    if (
      currentAuthority === null
      || stableJson(currentAuthority) !== stableJson(command.authority)
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_changed",
        "Runner resume authority fence changed",
      );
    }
    const checkpoint = parseCurrentCheckpoint(run);
    if (stableJson(checkpoint) !== stableJson(command.checkpointRef)) {
      throw new RunnerAuthoritativeResumeConflictError(
        "checkpoint_changed",
        "Runner resume checkpoint reference changed",
      );
    }
    const continuation = currentContinuation(this.#options.store, run);
    if (stableJson(continuation) !== stableJson(command.continuation)) {
      throw new RunnerAuthoritativeResumeConflictError(
        "continuation_changed",
        "Runner resume continuation identity or generation changed",
      );
    }

    const probe = parseRunnerCapabilityProbeV1({
      version: RUNNER_ADAPTER_V1,
      probeId: deterministicId("resume-probe", command.commandId, observedAt),
      adapterId: command.adapterId,
      adapterVersion: command.adapterVersion,
      profileId: command.profileId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      transport: this.#options.transport,
      transition: "resume",
      clientProduct: this.#options.clientProduct,
      clientBuild: this.#options.clientBuild,
      modelProfile: this.#options.modelProfile,
      externalSurfaceRef: checkpoint.externalId,
      requiredCapabilities: command.requiredCapabilities,
      recoveryActions: this.#options.recoveryActions,
      observedAt,
      traceId: command.correlationId ?? deterministicId("resume-trace", command.commandId),
    });
    const adapterSnapshot = await this.#options.adapter.inspectCapabilities(probe);
    const currentCapabilityBinding = bindAdapterSnapshotToCommand(
      this.#options.descriptor,
      probe,
      adapterSnapshot,
      command,
    );
    const evidence = await this.#options.evidenceSource.read({
      command,
      run,
      checkpoint,
      observedAt,
    });
    const inspection = compileRunnerResumeInspectionV1({
      command,
      descriptor: this.#options.descriptor,
      expectedRuntime: this.#options.expectedRuntime,
      checkpoint: evidence.checkpoint,
      latestCheckpointGeneration: evidence.latestCheckpointGeneration,
      currentContinuation: continuation,
      checkpointToolSurface: evidence.checkpointToolSurface,
      currentCapabilityBinding,
      currentAuthority,
      grantRefs: evidence.grantRefs,
      requiredApprovalRefs: evidence.requiredApprovalRefs,
      approvalRefs: evidence.approvalRefs,
      priorCommand,
      interruption: evidence.interruption,
      latestEvidenceRefs: evidence.latestEvidenceRefs ?? [],
      observedAt,
    });
    const resumeFenceFingerprint = resumeFenceFingerprintFor({
      run,
      project,
      checkpoint,
      continuation,
      descriptor: this.#options.descriptor,
      expectedRuntime: this.#options.expectedRuntime,
      requiredCapabilities: command.requiredCapabilities,
      capabilityGrantRefs: command.capabilityGrantRefs,
      currentCapabilityBinding,
      evidence,
      priorCommand,
    });
    return { command, run, project, checkpoint, priorCommand, inspection, resumeFenceFingerprint };
  }

  async #buildCommand(
    run: WorkRun,
    project: string,
    checkpoint: RunnerExternalReferenceV1,
    continuation: RunnerResumeCommandV1["continuation"],
    idempotencyKey: string,
    issuedAt: string,
  ): Promise<RunnerResumeCommandV1> {
    const authority = runAuthorityFence(run);
    if (!authority) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_missing",
        "Runner resume requires a current run authority fence",
      );
    }
    const envelope = run.executionEnvelope;
    if (!envelope) {
      throw new RunnerAuthoritativeResumeConflictError(
        "execution_envelope_missing",
        "Runner resume requires the durable execution envelope",
      );
    }
    return parseRunnerResumeCommandV1({
      version: RUNNER_ADAPTER_V1,
      kind: "resume",
      commandId: deterministicId(
        "resume",
        idempotencyKey,
        run.id,
        run.generation,
        run.leaseGeneration,
      ),
      correlationId: deterministicId("resume-correlation", idempotencyKey, run.id),
      adapterId: this.#options.descriptor.adapterId,
      adapterVersion: this.#options.descriptor.adapterVersion,
      profileId: this.#options.profile.id,
      profileVersion: this.#options.profile.version,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      authority,
      itemId: run.itemId,
      project,
      executionEnvelope: envelope,
      context: await getRunnerContextPacket(this.#options.ledger, run.itemId, {
        maxCharacters: this.#options.maxContextCharacters,
        now: new Date(issuedAt),
      }),
      requiredCapabilities: this.#options.requiredCapabilities,
      capabilityGrantRefs: this.#options.capabilityGrantRefs,
      issuedAt,
      continuation,
      adapterResumeRef: checkpoint,
      checkpointRef: checkpoint,
      reason: "recovery",
    });
  }

  #assertCurrentRunIdentity(run: WorkRun, project: string, observedAt: string): void {
    if (!executableResumeStatuses.has(run.status)) {
      throw new RunnerAuthoritativeResumeConflictError(
        "run_not_resumable",
        `Runner resume cannot execute while run is ${run.status}`,
      );
    }
    if (
      run.runnerType !== this.#options.descriptor.adapterId
      || run.runnerProfile !== this.#options.profile.id
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "adapter_profile_mismatch",
        "Runner resume adapter or profile does not match the durable run",
      );
    }
    if (!project) {
      throw new RunnerAuthoritativeResumeConflictError(
        "project_missing",
        "Runner resume project is unavailable",
      );
    }
    const authority = runAuthorityFence(run);
    if (authority === null || authority.holderId !== this.#options.actor.id) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_holder_mismatch",
        "Runner resume caller is not the current run authority holder",
      );
    }
    if (Date.parse(authority.expiresAt) <= Date.parse(observedAt)) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_expired",
        "Runner resume authority is expired",
      );
    }
  }

  #requireExpectedFence(expected: string, candidate: ResumeCandidate): void {
    if (candidate.resumeFenceFingerprint !== expected) {
      throw new RunnerAuthoritativeResumeConflictError(
        "stale_resume_fence",
        "Runner resume evidence changed from the expected authoritative fence",
      );
    }
  }

  #requireEligible(inspection: RunnerResumeInspectionReceiptV1): void {
    if (inspection.decision !== "eligible" || !inspection.resumeEligible) {
      const failed = inspection.checks.find((check) => check.state !== "pass");
      throw new RunnerAuthoritativeResumeConflictError(
        failed?.code ?? "resume_not_eligible",
        failed?.summary ?? "Runner resume evidence is not fully eligible",
      );
    }
  }

  async #resultFromReservation(
    fallbackRun: WorkRun,
    fence: string,
    commandId: string,
    commandFingerprint: string,
    settlement: RunnerAdapterCommandSettlementRecord | null,
  ): Promise<RunnerAuthoritativeResumeResultV1> {
    const run = await this.#options.ledger.getRun(fallbackRun.id);
    if (settlement === null) {
      return result(
        "waiting_reconciliation",
        run.id,
        commandId,
        commandFingerprint,
        fence,
        [],
        null,
        null,
        run,
      );
    }
    return result(
      "settled_replay",
      run.id,
      commandId,
      commandFingerprint,
      fence,
      [],
      null,
      admitRunnerAdapterCommandSettlementRecord(settlement),
      run,
    );
  }
}

class ResumeObservationConsumerV1 {
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
  #observationBytes = 0;

  constructor(input: {
    ledger: RunnerAuthoritativeResumeLedgerV1;
    descriptor: RunnerAdapterDescriptorV1;
    command: RunnerResumeCommandV1;
    actor: ActorInput;
    initialRun: WorkRun;
    leaseSeconds: number;
    now: () => Date;
  }) {
    this.#ledger = input.ledger;
    this.#descriptor = parseRunnerAdapterDescriptorV1(input.descriptor);
    this.#command = parseRunnerResumeCommandV1(input.command);
    this.#actor = Object.freeze({ ...input.actor });
    this.#run = input.initialRun;
    this.#leaseSeconds = input.leaseSeconds;
    this.#now = input.now;
    this.#latestCheckpoint = this.#command.checkpointRef;
    this.#assertCurrentRun(this.#run);
  }

  async consume(stream: AsyncIterable<RunnerObservationV1>): Promise<{
    observations: readonly RunnerObservationV1[];
    latestCheckpoint: RunnerExternalReferenceV1 | null;
    run: WorkRun;
  }> {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        await this.#assertAuthorityBeforeAdvance();
        const next = await iterator.next();
        if (next.done) break;
        this.#run = await this.#ledger.getRun(this.#command.runId);
        this.#assertCurrentRun(this.#run);
        const observation = assertRunnerObservationBinding(
          this.#descriptor,
          this.#command,
          next.value,
        );
        const canonical = stableJson(observation);
        const prior = this.#seen.get(observation.observationId);
        if (prior !== undefined) {
          if (prior !== canonical) {
            throw new RangeError(
              `Runner observation ${observation.observationId} was replayed with different content`,
            );
          }
          continue;
        }
        this.#admitEpisodeBound(canonical);
        this.#seen.set(observation.observationId, canonical);
        await this.#recordReceipt(observation);
        await this.#applyEvidence(observation);
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

  async #assertAuthorityBeforeAdvance(): Promise<void> {
    const now = invocationTime(this.#now);
    if (Date.parse(this.#command.authority.expiresAt) <= now.getTime()) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_expired_during_resume",
        "Runner resume authority expired during adapter execution",
      );
    }
    this.#run = await this.#ledger.getRun(this.#command.runId);
    this.#assertCurrentRun(this.#run);
  }

  #assertCurrentRun(run: WorkRun): void {
    const authority = runAuthorityFence(run);
    if (
      !executableResumeStatuses.has(run.status)
      || run.id !== this.#command.runId
      || run.itemId !== this.#command.itemId
      || run.generation !== this.#command.runGeneration
      || run.leaseGeneration !== this.#command.leaseGeneration
      || authority === null
      || stableJson(authority) !== stableJson(this.#command.authority)
      || authority.holderId !== this.#actor.id
      || Date.parse(authority.expiresAt) <= invocationTime(this.#now).getTime()
    ) {
      throw new RunnerAuthoritativeResumeConflictError(
        "authority_changed_during_resume",
        "Runner resume no longer matches current durable authority",
      );
    }
  }

  #admitEpisodeBound(canonical: string): void {
    if (this.#seen.size >= maximumEpisodeObservations) {
      throw new RangeError("Runner resume episode exceeds the observation count bound");
    }
    this.#observationBytes += new TextEncoder().encode(canonical).byteLength;
    if (this.#observationBytes > maximumEpisodeObservationBytes) {
      throw new RangeError("Runner resume episode exceeds the observation byte bound");
    }
  }

  async #recordReceipt(observation: RunnerObservationV1): Promise<void> {
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

  async #applyEvidence(observation: RunnerObservationV1): Promise<void> {
    if (observation.type === "heartbeat") {
      if (observation.checkpointRef) this.#assertCheckpointReference(observation.checkpointRef, false);
      this.#latestCheckpoint = observation.checkpointRef ?? this.#latestCheckpoint;
      this.#run = await this.#ledger.heartbeatRun({
        id: this.#run.id,
        actor: this.#actor,
        expectedGeneration: this.#run.generation,
        expectedLeaseGeneration: this.#run.leaseGeneration,
        leaseSeconds: this.#remainingLeaseSeconds(),
        usage: observation.usage,
        ...(observation.checkpointRef
          ? { checkpoint: serializeReference(observation.checkpointRef) }
          : {}),
        idempotencyKey: `runner-resume-heartbeat:${observation.commandId}:${observation.observationId}`,
      });
      return;
    }
    if (observation.type === "checkpoint_published") {
      this.#assertCheckpointReference(observation.reference, true);
      this.#latestCheckpoint = observation.reference;
      this.#run = await this.#ledger.heartbeatRun({
        id: this.#run.id,
        actor: this.#actor,
        expectedGeneration: this.#run.generation,
        expectedLeaseGeneration: this.#run.leaseGeneration,
        leaseSeconds: this.#remainingLeaseSeconds(),
        checkpoint: serializeReference(observation.reference),
        idempotencyKey: `runner-resume-checkpoint:${observation.commandId}:${observation.observationId}`,
      });
      return;
    }
    if (observation.type === "tool_surface_observed") {
      await recordEffectiveToolSurfaceEvent({
        ledger: this.#ledger,
        run: this.#run,
        snapshot: observation.snapshot,
        actor: this.#actor,
      });
    }
  }

  #assertCheckpointReference(reference: RunnerExternalReferenceV1, requireNewer: boolean): void {
    const currentGeneration = this.#command.checkpointRef?.generation;
    if (
      reference.kind !== "checkpoint"
      || reference.adapterId !== this.#command.adapterId
      || reference.uri !== null
      || reference.externalId === null
      || reference.digest === null
      || reference.generation === null
      || (requireNewer && currentGeneration !== null && currentGeneration !== undefined
        && reference.generation <= currentGeneration)
    ) {
      throw new RangeError("Runner resume checkpoint reference does not match the active command lineage");
    }
  }

  #remainingLeaseSeconds(): number {
    const remaining = Math.floor(
      (Date.parse(this.#command.authority.expiresAt) - invocationTime(this.#now).getTime()) / 1_000,
    );
    return Math.max(30, Math.min(this.#leaseSeconds, remaining));
  }
}

function normalizeOptions(options: RunnerAuthoritativeResumeOptionsV1): NormalizedOptions {
  const descriptor = parseRunnerAdapterDescriptorV1(options.adapter.describe());
  if (!descriptor.supports.resume || !descriptor.supports.capabilityInspection || descriptor.checkpointMode === "none") {
    throw new RangeError("Runner authoritative resume requires an adapter with resume, capability inspection, and checkpoints");
  }
  const profile = descriptor.profiles.find((entry) => entry.id === options.profileId);
  if (!profile) throw new RangeError("Runner authoritative resume profile is absent from adapter descriptor");
  const transport = options.transport ?? descriptor.transports[0];
  if (!transport || !descriptor.transports.includes(transport)) {
    throw new RangeError("Runner authoritative resume transport is unsupported by adapter");
  }
  return {
    store: options.store,
    ledger: options.ledger,
    adapter: options.adapter,
    descriptor,
    actor: Object.freeze({ ...options.actor }),
    profile,
    expectedRuntime: Object.freeze({ ...options.expectedRuntime }),
    evidenceSource: options.evidenceSource,
    requiredCapabilities: Object.freeze([...(options.requiredCapabilities ?? [])]),
    capabilityGrantRefs: Object.freeze([...(options.capabilityGrantRefs ?? [])]),
    transport,
    clientProduct: options.clientProduct ?? "stensibly-authoritative-resume",
    clientBuild: options.clientBuild ?? "1.0.0",
    modelProfile: options.modelProfile ?? profile.id,
    recoveryActions: Object.freeze([...(options.recoveryActions ?? ["resume_with_current_tools"])]),
    maxContextCharacters: boundedInteger(options.maxContextCharacters ?? 12_000, 2_000, 50_000, "Runner resume context characters"),
    leaseSeconds: boundedInteger(options.leaseSeconds ?? 900, 30, 86_400, "Runner resume lease seconds"),
    now: options.now ?? (() => new Date()),
  };
}

function normalizeResumeInput(input: RunnerAuthoritativeResumeInputV1) {
  return Object.freeze({
    runId: identifier(input.runId, "Runner resume run ID", 240),
    idempotencyKey: identifier(input.idempotencyKey, "Runner resume idempotency key", 240),
    expectedResumeFenceFingerprint: fingerprint(
      input.expectedResumeFenceFingerprint,
      "Runner resume expected fence fingerprint",
    ),
  });
}

function currentContinuation(store: StensiblyStore, run: WorkRun): RunnerResumeCommandV1["continuation"] {
  if (!run.continuationRef) {
    throw new RunnerAuthoritativeResumeConflictError(
      "continuation_missing",
      "Runner resume requires a durable continuation identity",
    );
  }
  let continuation: ContinuationProposal;
  try {
    continuation = getContinuation(store, run.continuationRef);
  } catch {
    throw new RunnerAuthoritativeResumeConflictError(
      "continuation_missing",
      "Runner resume continuation is unavailable",
    );
  }
  if (blockedContinuationStatuses.has(continuation.status)) {
    throw new RunnerAuthoritativeResumeConflictError(
      "continuation_superseded",
      `Runner resume continuation is ${continuation.status}`,
    );
  }
  if (
    continuation.sourceRunId !== null
    && continuation.sourceRunId !== run.id
    && continuation.result?.runId !== run.id
  ) {
    throw new RunnerAuthoritativeResumeConflictError(
      "continuation_run_mismatch",
      "Runner resume continuation belongs to another run lineage",
    );
  }
  return Object.freeze({ id: continuation.id, generation: continuation.generation });
}

function parseCurrentCheckpoint(run: WorkRun): RunnerExternalReferenceV1 {
  if (!run.checkpoint) {
    throw new RunnerAuthoritativeResumeConflictError(
      "checkpoint_missing",
      "Runner resume requires a durable checkpoint reference",
    );
  }
  let checkpoint: RunnerExternalReferenceV1;
  try {
    checkpoint = parseRunnerExternalReferenceV1(JSON.parse(run.checkpoint) as unknown);
  } catch {
    throw new RunnerAuthoritativeResumeConflictError(
      "checkpoint_malformed",
      "Runner resume checkpoint reference is malformed",
    );
  }
  if (
    checkpoint.kind !== "checkpoint"
    || checkpoint.externalId === null
    || checkpoint.digest === null
    || checkpoint.generation === null
  ) {
    throw new RunnerAuthoritativeResumeConflictError(
      "checkpoint_incomplete",
      "Runner resume checkpoint reference lacks exact external identity, digest, or generation",
    );
  }
  return checkpoint;
}

function latestRunnerCommand(store: StensiblyStore, runId: string): RunnerAdapterCommandLookup | null {
  ensureRunnerAdapterCommandSchema(store);
  const row = store.db.query<LatestCommandRow, [string]>(`
    SELECT idempotency_key
    FROM runner_adapter_commands
    WHERE run_id = ?1
    ORDER BY reserved_at DESC, command_id DESC
    LIMIT 1
  `).get(runId);
  return row
    ? getSqliteRunnerAdapterCommand(store, { idempotencyKey: row.idempotency_key })
    : null;
}

function bindAdapterSnapshotToCommand(
  descriptor: RunnerAdapterDescriptorV1,
  probe: ReturnType<typeof parseRunnerCapabilityProbeV1>,
  snapshot: EffectiveToolSurfaceSnapshot,
  command: RunnerResumeCommandV1,
): RunnerCapabilityCommandBindingV1 {
  const classes = {} as Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
  for (const [className, classSnapshot] of Object.entries(snapshot.classes)) {
    classes[className as EffectiveToolSurfaceClass] = {
      catalogue: classSnapshot.catalogueCapabilities,
      executable: classSnapshot.executableCapabilities,
      provenance: classSnapshot.provenance,
    };
  }
  const inspection = buildRunnerCapabilityInspectionV1(descriptor, probe, classes);
  if (
    inspection.snapshot.surfaceFingerprint !== snapshot.surfaceFingerprint
    || inspection.snapshot.requiredFingerprint !== snapshot.requiredFingerprint
    || inspection.snapshot.snapshotFingerprint !== snapshot.snapshotFingerprint
  ) {
    throw new RunnerAuthoritativeResumeConflictError(
      "capability_snapshot_mismatch",
      "Runner adapter capability inspection changed while being admitted",
    );
  }
  return bindRunnerCapabilityInspectionToCommandV1(inspection, command);
}

function resumeFenceFingerprintFor(input: {
  run: WorkRun;
  project: string;
  checkpoint: RunnerExternalReferenceV1;
  continuation: RunnerResumeCommandV1["continuation"];
  descriptor: RunnerAdapterDescriptorV1;
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs: readonly string[];
  currentCapabilityBinding: RunnerCapabilityCommandBindingV1;
  evidence: RunnerAuthoritativeResumeEvidenceV1;
  priorCommand: RunnerAdapterCommandLookup;
}): string {
  const currentSnapshot = input.currentCapabilityBinding.inspection.snapshot;
  return digest({
    version: RUNNER_AUTHORITATIVE_RESUME_V1,
    project: input.project,
    itemId: input.run.itemId,
    runId: input.run.id,
    runGeneration: input.run.generation,
    leaseGeneration: input.run.leaseGeneration,
    authority: runAuthorityFence(input.run),
    checkpoint: input.checkpoint,
    continuation: input.continuation,
    adapter: {
      id: input.descriptor.adapterId,
      version: input.descriptor.adapterVersion,
      profileId: input.currentCapabilityBinding.inspection.profileId,
      profileVersion: input.currentCapabilityBinding.inspection.profileVersion,
    },
    expectedRuntime: input.expectedRuntime,
    requiredCapabilities: [...input.requiredCapabilities],
    capabilityGrantRefs: [...input.capabilityGrantRefs],
    currentCapabilities: {
      surfaceFingerprint: currentSnapshot.surfaceFingerprint,
      requiredFingerprint: currentSnapshot.requiredFingerprint,
      missingRequiredCapabilities: currentSnapshot.missingRequiredCapabilities,
    },
    checkpointCapabilities: input.evidence.checkpointToolSurface === null
      ? null
      : {
        surfaceFingerprint: input.evidence.checkpointToolSurface.surfaceFingerprint,
        requiredFingerprint: input.evidence.checkpointToolSurface.requiredFingerprint,
      },
    checkpointSource: input.evidence.checkpoint,
    latestCheckpointGeneration: input.evidence.latestCheckpointGeneration,
    grants: input.evidence.grantRefs,
    requiredApprovalRefs: [...input.evidence.requiredApprovalRefs],
    approvals: input.evidence.approvalRefs,
    priorCommand: {
      commandId: input.priorCommand.command.commandId,
      commandFingerprint: input.priorCommand.command.commandFingerprint,
      idempotencyKey: input.priorCommand.command.idempotencyKey,
      settlementOutcomeSha256: input.priorCommand.settlement?.outcomeSha256 ?? null,
    },
    interruption: input.evidence.interruption,
  });
}

function resumeRequestFingerprint(
  input: ReturnType<typeof normalizeResumeInput>,
  options: NormalizedOptions,
): string {
  return digest({
    version: RUNNER_AUTHORITATIVE_RESUME_V1,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    expectedResumeFenceFingerprint: input.expectedResumeFenceFingerprint,
    actorId: options.actor.id,
    adapterId: options.descriptor.adapterId,
    profileId: options.profile.id,
  });
}

function result(
  disposition: RunnerAuthoritativeResumeResultV1["disposition"],
  runId: string,
  commandId: string,
  commandFingerprint: string,
  resumeFenceFingerprint: string,
  observations: readonly RunnerObservationV1[],
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
    observations: Object.freeze([...observations]),
    latestCheckpoint,
    settlement,
    run,
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function serializeReference(reference: RunnerExternalReferenceV1): string {
  const serialized = stableJson(reference);
  if (serialized.length > 10_000) {
    throw new RangeError("Runner resume checkpoint reference exceeds the durable run bound");
  }
  return serialized;
}

function deterministicId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(stableJson(parts)).digest("hex")}`;
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
}

function invocationTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("Runner authoritative resume clock is invalid");
  }
  return new Date(value.getTime());
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new RangeError(`${label} is invalid`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return Number(value);
}
