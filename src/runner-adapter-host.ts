import { createHash } from "node:crypto";
import { stableJson } from "./canonical-json.js";
import { getRunnerContextPacket } from "./context-packets.js";
import { recordEffectiveToolSurfaceEvent } from "./effective-tool-surface-events.js";
import type {
  ToolSurfaceCapabilityRequirementInput,
  ToolSurfaceRecoveryAction,
} from "./effective-tool-surface.js";
import type { WorkLedger } from "./ledger.js";
import {
  RUNNER_ADAPTER_V1,
  assertRunnerObservationBinding,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerStartCommandV1,
} from "./runner-adapter-v1.js";
import {
  VERCEL_AI_SDK_ADAPTER_ID,
  VERCEL_AI_SDK_ADAPTER_VERSION,
  VERCEL_AI_SDK_PROFILE_ID,
  VERCEL_AI_SDK_PROFILE_VERSION,
  VercelAISDKRunnerAdapter,
} from "./runner-adapters/vercel-ai-sdk.js";
import { assertRunnerCommandAuthorityActiveV1 } from "./runner-command-authority.js";
import type {
  RunnerAdapterCommandLedger,
  RunnerAdapterCommandReservation,
  RunnerAdapterCommandReservationRecord,
  RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";
import { admitRunnerAdapterCommandSettlementRecord } from "./runner-adapter-command-contracts.js";
import {
  admitRunnerAdapterCommandRecoveryClaimRecord,
  type ClaimRunnerAdapterCommandRecoveryInput,
  type RunnerAdapterCommandRecoveryClaim,
  type RunnerAdapterCommandRecoveryClaimRecord,
} from "./runner-adapter-command-recovery.js";
import { runAuthorityFence } from "./authority-fence.js";
import type { ClaimRunnerWorkInput, RunnerLedger } from "./runner-contracts.js";
import type { ActorInput } from "./schemas.js";
import type { WorkRun } from "./runs.js";

export const RUNNER_ADAPTER_HOST_V1 = 1 as const;
export const RUNNER_ADAPTER_HOST_VERSION = "0.1.0";

export type RunnerAdapterHostLedgerV1 =
  & WorkLedger
  & RunnerLedger
  & RunnerAdapterCommandLedger
  & {
    getRunnerAdapterCommandByIdempotencyKey(
      idempotencyKey: string,
    ): Promise<RunnerAdapterCommandReservation | null>;
    claimRunnerAdapterCommandRecovery(
      input: ClaimRunnerAdapterCommandRecoveryInput,
    ): Promise<RunnerAdapterCommandRecoveryClaim>;
  };

export interface RunnerAdapterHostOptionsV1 {
  ledger: RunnerAdapterHostLedgerV1;
  adapter: VercelAISDKRunnerAdapter;
  actor: ActorInput;
  profileId: string;
  transport?: string;
  clientProduct?: string;
  clientBuild?: string | null;
  modelProfile?: string | null;
  requiredCapabilities?: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs?: readonly string[];
  recoveryActions?: readonly ToolSurfaceRecoveryAction[];
  leaseSeconds?: number;
  maxContextCharacters?: number;
  now?: () => Date;
}

export interface RunnerAdapterHostStartInputV1 {
  operationId: string;
  project?: string;
  runId?: string;
  externalRunId?: string;
  correlationId?: string | null;
}

export interface RunnerAdapterHostExecutionV1 {
  version: typeof RUNNER_ADAPTER_HOST_V1;
  disposition: "executed" | "already_dispatched" | "settled_replay" | "recovery_claimed";
  command: RunnerStartCommandV1 | null;
  observations: readonly RunnerObservationV1[];
  latestCheckpoint: RunnerExternalReferenceV1 | null;
  settlement: RunnerAdapterCommandSettlementRecord | null;
  recovery: RunnerAdapterCommandRecoveryClaimRecord | null;
  run: WorkRun;
}

interface NormalizedHostOptions {
  ledger: RunnerAdapterHostLedgerV1;
  adapter: RunnerAdapterV1;
  inspectCapabilities: RunnerAdapterV1["inspectCapabilities"];
  start: RunnerAdapterV1["start"];
  descriptor: RunnerAdapterDescriptorV1;
  actor: ActorInput;
  profile: RunnerAdapterDescriptorV1["profiles"][number];
  transport: string;
  clientProduct: string;
  clientBuild: string | null;
  modelProfile: string | null;
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs: readonly string[];
  recoveryActions: readonly ToolSurfaceRecoveryAction[];
  leaseSeconds: number;
  maxContextCharacters: number;
  now: () => Date;
}

const maximumEpisodeObservations = 32;
const maximumEpisodeObservationBytes = 256 * 1024;
const maximumRecoveryLeaseSeconds = 3_600;

/**
 * One bounded Vercel AI SDK runner episode. The host reserves the adapter command in
 * the durable command ledger before advancing the async generator, so
 * concurrent hosts and response-loss retries cannot blindly redispatch model
 * work. A replay reads that reservation before command reconstruction; once
 * original run authority is gone, the host may acquire durable recovery
 * ownership while keeping adapter start/resume outside the recovery path.
 *
 * V1 intentionally keeps the durable run in `starting`. Adapter observations
 * are all bound to the claim generation, while canonical run transitions
 * advance that generation. A later command-inbox contract must bridge that
 * lifecycle mismatch before this host may project running/waiting/completion.
 */
export class RunnerAdapterHostV1 {
  readonly #options: NormalizedHostOptions;
  #active = false;

  constructor(options: RunnerAdapterHostOptionsV1) {
    this.#options = normalizeOptions(options);
  }

  async startNext(
    input: RunnerAdapterHostStartInputV1,
  ): Promise<RunnerAdapterHostExecutionV1 | null> {
    if (this.#active) {
      throw new RangeError("Runner adapter host already has an active episode");
    }
    this.#active = true;
    try {
      return await this.#startNext(input);
    } finally {
      this.#active = false;
    }
  }

  async #startNext(
    input: RunnerAdapterHostStartInputV1,
  ): Promise<RunnerAdapterHostExecutionV1 | null> {
    const operationId = boundedIdentifier(input.operationId, "Runner host operation ID");
    const correlationId = input.correlationId === null || input.correlationId === undefined
      ? null
      : boundedIdentifier(input.correlationId, "Runner host correlation ID");
    const claim: ClaimRunnerWorkInput = {
      actor: this.#options.actor,
      runnerType: this.#options.descriptor.adapterId,
      runnerProfile: this.#options.profile.id,
      leaseSeconds: this.#options.leaseSeconds,
      idempotencyKey: hostIdempotencyKey("claim", operationId),
      ...(input.project ? { project: boundedProject(input.project) } : {}),
      ...(input.runId ? { runId: boundedIdentifier(input.runId, "Runner host run ID") } : {}),
      ...(input.externalRunId
        ? { externalRunId: boundedIdentifier(input.externalRunId, "Runner host external run ID") }
        : {}),
    };
    const claimed = await this.#options.ledger.claimRunnerWork(claim);
    if (!claimed) return null;
    assertRunBinding(claimed, this.#options);

    const commandReceiptKey = hostIdempotencyKey("command", operationId, claimed.id);
    const prior = await this.#options.ledger.getRunnerAdapterCommandByIdempotencyKey(
      commandReceiptKey,
    );
    if (prior) {
      return await this.#replayReservedCommand(
        claim,
        operationId,
        correlationId,
        commandReceiptKey,
        claimed,
        prior,
      );
    }

    const run = await this.#options.ledger.getRun(claimed.id);
    assertRunBinding(run, this.#options);
    if (
      run.status !== "starting"
      || run.generation !== claimed.generation
      || run.leaseGeneration !== claimed.leaseGeneration
    ) {
      throw new RangeError("Runner claim replay no longer matches a starting durable run");
    }
    const detail = await this.#options.ledger.getItem(run.itemId);
    const project = detail.item.project;
    const command = await this.#buildCommand(
      operationId,
      run,
      project,
      correlationId,
    );
    const commandFingerprint = digest(command);
    const reservation = await this.#options.ledger.reserveRunnerAdapterCommand({
      project,
      itemId: run.itemId,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      actor: this.#options.actor,
      adapterId: command.adapterId,
      profileId: command.profileId,
      requestFingerprint: digest(
        this.#reservationRequest(claim, operationId, correlationId, run, project),
      ),
      commandId: command.commandId,
      commandFingerprint,
      idempotencyKey: commandReceiptKey,
    });
    if (!reservation.dispatchAuthorized) {
      const settlement = reservation.settlement === null
        ? null
        : admitRunnerAdapterCommandSettlementRecord(reservation.settlement);
      if (
        settlement !== null
        && (
          settlement.commandId !== reservation.command.commandId
          || settlement.commandFingerprint !== reservation.command.commandFingerprint
        )
      ) {
        throw new RangeError("Runner adapter command replay settlement changed command identity");
      }
      return executionResult(
        settlement === null ? "already_dispatched" : "settled_replay",
        null,
        [],
        null,
        settlement,
        null,
        run,
      );
    }
    if (
      reservation.command.commandId !== command.commandId
      || reservation.command.commandFingerprint !== commandFingerprint
    ) {
      throw new RangeError("Runner adapter command reservation winner is invalid");
    }
    await this.#options.ledger.recordEvent({
      id: run.itemId,
      actor: this.#options.actor,
      type: "run.adapter.command_dispatched",
      payload: {
        version: RUNNER_ADAPTER_HOST_V1,
        commandId: command.commandId,
        commandFingerprint,
        runId: command.runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        adapterId: command.adapterId,
        adapterVersion: command.adapterVersion,
        profileId: command.profileId,
        profileVersion: command.profileVersion,
        issuedAt: command.issuedAt,
        containsPrivateContent: false,
        containsCredentials: false,
      },
      idempotencyKey: commandReceiptKey,
    });

    const probe = parseRunnerCapabilityProbeV1({
      version: RUNNER_ADAPTER_V1,
      probeId: deterministicId("probe", command.commandId),
      adapterId: command.adapterId,
      adapterVersion: command.adapterVersion,
      profileId: command.profileId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      transport: this.#options.transport,
      transition: "new",
      clientProduct: this.#options.clientProduct,
      clientBuild: this.#options.clientBuild,
      modelProfile: this.#options.modelProfile,
      externalSurfaceRef: `run:${command.runId}`,
      requiredCapabilities: command.requiredCapabilities,
      recoveryActions: this.#options.recoveryActions,
      observedAt: command.issuedAt,
      traceId: command.correlationId ?? deterministicId("trace", command.commandId),
    });
    await this.#options.inspectCapabilities(probe);

    const consumer = new RunnerObservationConsumerV1({
      ledger: this.#options.ledger,
      descriptor: this.#options.descriptor,
      command,
      actor: this.#options.actor,
      initialRun: run,
      leaseSeconds: this.#options.leaseSeconds,
      now: this.#options.now,
    });
    const consumed = await consumer.consume(this.#options.start(command));
    const terminal = consumed.observations.at(-1);
    if (!terminal) {
      throw new RangeError("Runner adapter episode cannot settle without observations");
    }
    const settlement = await this.#options.ledger.settleRunnerAdapterCommand({
      commandId: command.commandId,
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
    return executionResult(
      "executed",
      command,
      consumed.observations,
      consumed.latestCheckpoint,
      settlement.settlement,
      null,
      consumed.run,
    );
  }

  async #replayReservedCommand(
    claim: ClaimRunnerWorkInput,
    operationId: string,
    correlationId: string | null,
    commandReceiptKey: string,
    claimed: WorkRun,
    reservation: RunnerAdapterCommandReservation,
  ): Promise<RunnerAdapterHostExecutionV1> {
    const command = reservation.command;
    this.#assertReservationReplayBinding(
      claim,
      operationId,
      correlationId,
      commandReceiptKey,
      claimed,
      command,
    );
    const run = await this.#options.ledger.getRun(command.runId);
    assertRunProfileBinding(run, this.#options);

    if (reservation.settlement !== null) {
      const settlement = admitRunnerAdapterCommandSettlementRecord(reservation.settlement);
      if (
        settlement.commandId !== command.commandId
        || settlement.commandFingerprint !== command.commandFingerprint
      ) {
        throw new RangeError("Runner adapter command replay settlement changed command identity");
      }
      return executionResult(
        "settled_replay",
        null,
        [],
        null,
        settlement,
        null,
        run,
      );
    }

    if (originalReservationAuthorityIsLive(run, command, invocationTime(this.#options.now))) {
      return executionResult(
        "already_dispatched",
        null,
        [],
        null,
        null,
        null,
        run,
      );
    }

    const recoveryResult = await this.#options.ledger.claimRunnerAdapterCommandRecovery({
      commandId: command.commandId,
      commandFingerprint: command.commandFingerprint,
      actor: this.#options.actor,
      leaseSeconds: Math.min(this.#options.leaseSeconds, maximumRecoveryLeaseSeconds),
      idempotencyKey: hostIdempotencyKey("recovery", operationId, command.commandId),
    });
    const recovery = admitRunnerAdapterCommandRecoveryClaimRecord(recoveryResult.claim);
    if (
      recovery.commandId !== command.commandId
      || recovery.commandFingerprint !== command.commandFingerprint
      || recovery.runId !== command.runId
      || recovery.runGeneration !== command.runGeneration
      || recovery.leaseGeneration !== command.leaseGeneration
      || recovery.actor.id !== this.#options.actor.id
      || recovery.authorizesRedispatch !== false
      || recovery.authorizesResume !== false
    ) {
      throw new RangeError("Runner adapter command recovery claim changed durable command identity");
    }
    return executionResult(
      "recovery_claimed",
      null,
      [],
      null,
      null,
      recovery,
      run,
    );
  }

  #assertReservationReplayBinding(
    claim: ClaimRunnerWorkInput,
    operationId: string,
    correlationId: string | null,
    commandReceiptKey: string,
    claimed: WorkRun,
    command: RunnerAdapterCommandReservationRecord,
  ): void {
    if (
      command.idempotencyKey !== commandReceiptKey
      || command.runId !== claimed.id
      || command.itemId !== claimed.itemId
      || command.runGeneration !== claimed.generation
      || command.leaseGeneration !== claimed.leaseGeneration
      || command.actor.id !== this.#options.actor.id
      || command.adapterId !== this.#options.descriptor.adapterId
      || command.profileId !== this.#options.profile.id
      || (claim.project !== undefined && command.project !== claim.project)
    ) {
      throw new RangeError("Runner adapter command replay no longer matches the original claim");
    }
    const expectedRequestFingerprint = digest(
      this.#reservationRequest(claim, operationId, correlationId, claimed, command.project),
    );
    if (command.requestFingerprint !== expectedRequestFingerprint) {
      throw new RangeError(
        "Runner adapter command idempotency key was already used for a different command",
      );
    }
  }

  #reservationRequest(
    claim: ClaimRunnerWorkInput,
    operationId: string,
    correlationId: string | null,
    run: WorkRun,
    project: string,
  ) {
    return {
      version: RUNNER_ADAPTER_HOST_V1,
      operationId,
      requestedProject: claim.project ?? null,
      requestedRunId: claim.runId ?? null,
      requestedExternalRunId: claim.externalRunId ?? null,
      correlationId,
      project,
      itemId: run.itemId,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      actor: this.#options.actor,
      adapterId: this.#options.descriptor.adapterId,
      adapterVersion: this.#options.descriptor.adapterVersion,
      profileId: this.#options.profile.id,
      profileVersion: this.#options.profile.version,
      executionEnvelopeFingerprint: digest(run.executionEnvelope),
      transport: this.#options.transport,
      clientProduct: this.#options.clientProduct,
      clientBuild: this.#options.clientBuild,
      modelProfile: this.#options.modelProfile,
      requiredCapabilities: this.#options.requiredCapabilities,
      capabilityGrantRefs: this.#options.capabilityGrantRefs,
      recoveryActions: this.#options.recoveryActions,
      leaseSeconds: this.#options.leaseSeconds,
      maxContextCharacters: this.#options.maxContextCharacters,
    };
  }

  async #buildCommand(
    operationId: string,
    run: WorkRun,
    project: string,
    correlationId: string | null,
  ): Promise<RunnerStartCommandV1> {
    const authority = runAuthorityFence(run);
    if (!authority) throw new RangeError("Runner host requires a live run authority fence");
    const envelope = run.executionEnvelope;
    if (!envelope) throw new RangeError("Runner host requires an execution envelope");
    const issuedAt = invocationTime(this.#options.now).toISOString();
    return parseRunnerStartCommandV1({
      version: RUNNER_ADAPTER_V1,
      kind: "start",
      commandId: deterministicId("start", operationId, run.id, run.generation),
      correlationId,
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
    });
  }
}

/** Server-owned admission and evidence projection for one active command. */
export class RunnerObservationConsumerV1 {
  readonly #ledger: RunnerAdapterHostLedgerV1;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #command: RunnerStartCommandV1;
  readonly #actor: ActorInput;
  readonly #leaseSeconds: number;
  readonly #now: () => Date;
  #run: WorkRun;
  #latestCheckpoint: RunnerExternalReferenceV1 | null = null;
  readonly #observations: RunnerObservationV1[] = [];
  readonly #seen = new Map<string, string>();
  #observationBytes = 0;

  constructor(input: {
    ledger: RunnerAdapterHostLedgerV1;
    descriptor: RunnerAdapterDescriptorV1;
    command: RunnerStartCommandV1;
    actor: ActorInput;
    initialRun: WorkRun;
    leaseSeconds: number;
    now?: () => Date;
  }) {
    this.#ledger = input.ledger;
    this.#descriptor = parseRunnerAdapterDescriptorV1(input.descriptor);
    this.#command = parseRunnerStartCommandV1(input.command);
    this.#actor = input.actor;
    this.#run = input.initialRun;
    this.#leaseSeconds = boundedInteger(input.leaseSeconds, 30, 86_400, "Runner host lease seconds");
    this.#now = input.now ?? (() => new Date());
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
        const now = invocationTime(this.#now);
        assertRunnerCommandAuthorityActiveV1(this.#command, now);
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
    assertRunnerCommandAuthorityActiveV1(this.#command, now);
    this.#run = await this.#ledger.getRun(this.#command.runId);
    this.#assertCurrentRun(this.#run);
  }

  #admitEpisodeBound(canonical: string): void {
    if (this.#seen.size >= maximumEpisodeObservations) {
      throw new RangeError("AI SDK runner episode exceeds the observation count bound");
    }
    this.#observationBytes += new TextEncoder().encode(canonical).byteLength;
    if (this.#observationBytes > maximumEpisodeObservationBytes) {
      throw new RangeError("AI SDK runner episode exceeds the observation byte bound");
    }
  }

  #assertCurrentRun(run: WorkRun): void {
    assertRunBinding(run, {
      descriptor: this.#descriptor,
      profile: { id: this.#command.profileId, version: this.#command.profileVersion },
      actor: this.#actor,
    });
    if (
      run.status !== "starting"
      || run.generation !== this.#command.runGeneration
      || run.leaseGeneration !== this.#command.leaseGeneration
      || run.leaseExpiresAt === null
      || Date.parse(run.leaseExpiresAt) <= invocationTime(this.#now).getTime()
    ) {
      throw new RangeError("Runner observation no longer matches current durable authority");
    }
  }

  async #recordReceipt(observation: RunnerObservationV1): Promise<void> {
    await this.#ledger.recordEvent({
      id: this.#run.itemId,
      actor: this.#actor,
      type: "run.adapter.observation",
      payload: {
        version: RUNNER_ADAPTER_HOST_V1,
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
      idempotencyKey: observationKey(observation, "receipt"),
    });
  }

  async #applyEvidence(observation: RunnerObservationV1): Promise<void> {
    if (observation.type === "heartbeat") {
      this.#latestCheckpoint = observation.checkpointRef ?? this.#latestCheckpoint;
      if (observation.checkpointRef) this.#assertCheckpointReference(observation.checkpointRef);
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
        idempotencyKey: observationKey(observation, "heartbeat"),
      });
      return;
    }
    if (observation.type === "checkpoint_published") {
      this.#assertCheckpointReference(observation.reference);
      this.#latestCheckpoint = observation.reference;
      this.#run = await this.#ledger.heartbeatRun({
        id: this.#run.id,
        actor: this.#actor,
        expectedGeneration: this.#run.generation,
        expectedLeaseGeneration: this.#run.leaseGeneration,
        leaseSeconds: this.#remainingLeaseSeconds(),
        checkpoint: serializeReference(observation.reference),
        idempotencyKey: observationKey(observation, "checkpoint"),
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

  #remainingLeaseSeconds(): number {
    const remaining = Math.floor(
      (Date.parse(this.#command.authority.expiresAt) - invocationTime(this.#now).getTime()) / 1_000,
    );
    return boundedInteger(
      Math.min(this.#leaseSeconds, remaining),
      30,
      86_400,
      "AI SDK runner remaining lease seconds",
    );
  }

  #assertCheckpointReference(reference: RunnerExternalReferenceV1): void {
    if (
      reference.kind !== "checkpoint"
      || reference.adapterId !== this.#command.adapterId
      || reference.generation !== this.#command.runGeneration
      || reference.uri !== null
      || reference.externalId === null
      || reference.digest === null
    ) {
      throw new RangeError("AI SDK checkpoint reference does not match the active command");
    }
  }
}

function normalizeOptions(options: RunnerAdapterHostOptionsV1): NormalizedHostOptions {
  if (!(options.adapter instanceof VercelAISDKRunnerAdapter)) {
    throw new RangeError("Runner host requires a Vercel AI SDK adapter instance");
  }
  const descriptor = parseRunnerAdapterDescriptorV1(options.adapter.describe());
  assertVercelAISDKDescriptor(descriptor);
  const profile = descriptor.profiles.find((entry) => entry.id === options.profileId);
  if (!profile) throw new RangeError("Runner host profile is absent from the adapter descriptor");
  const transport = options.transport ?? descriptor.transports[0];
  if (!transport || !descriptor.transports.includes(transport)) {
    throw new RangeError("Runner host transport is unsupported by the adapter");
  }
  return {
    ledger: options.ledger,
    adapter: options.adapter,
    inspectCapabilities: options.adapter.inspectCapabilities.bind(options.adapter),
    start: options.adapter.start.bind(options.adapter),
    descriptor,
    actor: Object.freeze({ ...options.actor }),
    profile,
    transport,
    clientProduct: options.clientProduct ?? "stensibly-runner-host",
    clientBuild: options.clientBuild ?? RUNNER_ADAPTER_HOST_VERSION,
    modelProfile: options.modelProfile ?? profile.id,
    requiredCapabilities: detachedJson(options.requiredCapabilities ?? []),
    capabilityGrantRefs: Object.freeze([...(options.capabilityGrantRefs ?? [])]),
    recoveryActions: Object.freeze([...(options.recoveryActions ?? ["resume_with_current_tools"])]),
    leaseSeconds: boundedInteger(options.leaseSeconds ?? 900, 30, 86_400, "Runner host lease seconds"),
    maxContextCharacters: boundedInteger(
      options.maxContextCharacters ?? 12_000,
      2_000,
      50_000,
      "Runner host context characters",
    ),
    now: options.now ?? (() => new Date()),
  };
}

function detachedJson<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function assertVercelAISDKDescriptor(descriptor: RunnerAdapterDescriptorV1): void {
  const exactProfile = descriptor.profiles.length === 1 ? descriptor.profiles[0] : undefined;
  if (
    descriptor.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
    || descriptor.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
    || exactProfile?.id !== VERCEL_AI_SDK_PROFILE_ID
    || exactProfile?.version !== VERCEL_AI_SDK_PROFILE_VERSION
    || descriptor.transports.length !== 1
    || descriptor.transports[0] !== "in_process"
  ) {
    throw new RangeError("Runner host requires the exact Vercel AI SDK adapter descriptor");
  }
}

function assertRunProfileBinding(
  run: WorkRun,
  options: Pick<NormalizedHostOptions, "descriptor" | "profile">,
): void {
  if (
    run.runnerType !== options.descriptor.adapterId
    || run.runnerProfile !== options.profile.id
  ) {
    throw new RangeError("Durable run does not match the runner adapter profile");
  }
}

function assertRunBinding(
  run: WorkRun,
  options: Pick<NormalizedHostOptions, "descriptor" | "profile" | "actor">,
): void {
  assertRunProfileBinding(run, options);
  if (run.actorId !== options.actor.id || run.leaseOwnerId !== options.actor.id) {
    throw new RangeError("Durable run authority holder does not match the runner host actor");
  }
}

function originalReservationAuthorityIsLive(
  run: WorkRun,
  command: RunnerAdapterCommandReservationRecord,
  now: Date,
): boolean {
  const leaseExpiresAt = run.leaseExpiresAt === null ? Number.NaN : Date.parse(run.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt)
    && leaseExpiresAt > now.getTime()
    && run.generation === command.runGeneration
    && run.leaseGeneration === command.leaseGeneration
    && run.leaseOwnerId === command.actor.id;
}

function serializeReference(reference: RunnerExternalReferenceV1): string {
  const serialized = stableJson(reference);
  if (serialized.length > 10_000) {
    throw new RangeError("Runner external checkpoint reference exceeds the durable run bound");
  }
  return serialized;
}

function executionResult(
  disposition: RunnerAdapterHostExecutionV1["disposition"],
  command: RunnerAdapterHostExecutionV1["command"],
  observations: readonly RunnerObservationV1[],
  latestCheckpoint: RunnerExternalReferenceV1 | null,
  settlement: RunnerAdapterCommandSettlementRecord | null,
  recovery: RunnerAdapterCommandRecoveryClaimRecord | null,
  run: WorkRun,
): RunnerAdapterHostExecutionV1 {
  return Object.freeze({
    version: RUNNER_ADAPTER_HOST_V1,
    disposition,
    command,
    observations: Object.freeze([...observations]),
    latestCheckpoint,
    settlement,
    recovery,
    run,
  });
}

function observationKey(observation: RunnerObservationV1, action: string): string {
  return hostIdempotencyKey(action, observation.commandId, observation.observationId);
}

function hostIdempotencyKey(...parts: readonly unknown[]): string {
  return `runner-host:${createHash("sha256").update(stableJson(parts)).digest("hex")}`;
}

function deterministicId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(stableJson(parts)).digest("hex")}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function invocationTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("Runner host clock is invalid");
  }
  return new Date(value.getTime());
}

function boundedIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized
    || normalized.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/.test(normalized)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedProject(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || normalized.length > 80) {
    throw new RangeError("Runner host project is invalid");
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}
