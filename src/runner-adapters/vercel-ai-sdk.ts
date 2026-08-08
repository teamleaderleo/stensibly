import type { Agent } from "ai";
import type {
  EffectiveToolSurfaceSnapshot,
  EffectiveToolSurfaceSnapshotInput,
} from "../effective-tool-surface.js";
import {
  RUNNER_ADAPTER_V1,
  buildRunnerCapabilitySnapshotV1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCapabilityProbeV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../runner-adapter-v1.js";

export const VERCEL_AI_SDK_PACKAGE_VERSION = "7.0.58";
export const VERCEL_AI_SDK_ADAPTER_ID = "vercel-ai-sdk";
export const VERCEL_AI_SDK_ADAPTER_VERSION = "0.1.0";
export const VERCEL_AI_SDK_PROFILE_ID = "tool-loop-agent";
export const VERCEL_AI_SDK_PROFILE_VERSION = `ai@${VERCEL_AI_SDK_PACKAGE_VERSION}`;

type AnyAgent = Agent<never, any, any, any>;

export interface VercelAISDKCheckpointRecordV1 {
  externalId: string;
  runId: string;
  runGeneration: number;
  profileId: string;
  createdAt: string;
  messages: readonly unknown[];
}

export interface VercelAISDKCheckpointStore {
  saveCheckpoint(record: VercelAISDKCheckpointRecordV1): Promise<void> | void;
  loadCheckpoint(
    externalId: string,
  ): Promise<VercelAISDKCheckpointRecordV1 | null> | VercelAISDKCheckpointRecordV1 | null;
}

export interface VercelAISDKToolExecutionInput {
  command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  event: unknown;
}

export interface VercelAISDKRunnerAdapterOptions {
  agent: AnyAgent;
  checkpointStore: VercelAISDKCheckpointStore;
  capabilityClasses?: (
    input: RunnerCapabilityProbeV1,
    agent: AnyAgent,
  ) => EffectiveToolSurfaceSnapshotInput["classes"];
  authorizeToolExecution?: (
    input: VercelAISDKToolExecutionInput,
  ) => Promise<void> | void;
}

export class VercelAISDKRunnerAdapter implements RunnerAdapterV1 {
  readonly #agent: AnyAgent;
  readonly #checkpointStore: VercelAISDKCheckpointStore;
  readonly #capabilityClasses: NonNullable<
    VercelAISDKRunnerAdapterOptions["capabilityClasses"]
  >;
  readonly #authorizeToolExecution?: VercelAISDKRunnerAdapterOptions["authorizeToolExecution"];
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #snapshots = new Map<string, EffectiveToolSurfaceSnapshot>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();
  readonly #activeAbortControllers = new Map<string, AbortController>();

  constructor(options: VercelAISDKRunnerAdapterOptions) {
    this.#agent = options.agent;
    this.#checkpointStore = options.checkpointStore;
    this.#capabilityClasses = options.capabilityClasses ?? defaultCapabilityClasses;
    this.#authorizeToolExecution = options.authorizeToolExecution;
    this.#descriptor = parseRunnerAdapterDescriptorV1({
      version: RUNNER_ADAPTER_V1,
      adapterId: VERCEL_AI_SDK_ADAPTER_ID,
      adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
      profiles: [
        {
          id: VERCEL_AI_SDK_PROFILE_ID,
          version: VERCEL_AI_SDK_PROFILE_VERSION,
        },
      ],
      transports: ["in_process"],
      checkpointMode: "external_reference",
      cancellationMode: "best_effort",
      supports: {
        start: true,
        resume: true,
        capabilityInspection: true,
        streamingObservations: true,
        durableReplay: true,
        usageReferences: false,
        traceReferences: false,
      },
    });
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.#descriptor;
  }

  async inspectCapabilities(
    value: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    const probe = parseRunnerCapabilityProbeV1(value);
    this.#assertProbeBinding(probe);
    const snapshot = buildRunnerCapabilitySnapshotV1(
      probe,
      this.#capabilityClasses(probe, this.#agent),
    );
    this.#snapshots.set(snapshotKey(probe.runId, probe.transition), snapshot);
    return snapshot;
  }

  async *start(value: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(value);
    this.#assertCommandBinding(command);
    const snapshot = this.#requiredSnapshot(command.runId, "new");
    const abortController = new AbortController();
    this.#activeAbortControllers.set(runKey(command), abortController);

    try {
      yield observation(command, "start_accepted", 2);
      yield observation(command, "execution_started", 3);
      yield observation(command, "tool_surface_observed", 4, { snapshot });

      const result = await this.#generate(command, {
        prompt: command.context.intent.objective,
        abortSignal: abortController.signal,
      });

      yield observation(command, "work_step", 5, {
        phase: "ai_sdk_call",
        summary: `AI SDK ToolLoopAgent completed ${arrayLength(result.steps)} step(s) with ${arrayLength(result.toolCalls)} tool call(s).`,
      });

      const reference = checkpointReference(command);
      const messages = [
        { role: "user", content: command.context.intent.objective },
        ...arrayValue(result.responseMessages),
      ];
      await this.#checkpointStore.saveCheckpoint({
        externalId: requiredExternalId(reference),
        runId: command.runId,
        runGeneration: command.runGeneration,
        profileId: command.profileId,
        createdAt: reference.createdAt,
        messages,
      });
      this.#latestCheckpoints.set(runKey(command), reference);

      yield observation(command, "checkpoint_published", 6, { reference });
      yield observation(command, "interrupted", 7, {
        code: "bounded_ai_sdk_slice_complete",
        message: "The bounded AI SDK call completed and published a resumable external checkpoint.",
        checkpointRef: reference,
        recoveryAction: "resume",
        remoteSettlementKnown: false,
      });
    } catch (error) {
      yield observation(command, "failure_observed", 8, {
        code: abortController.signal.aborted ? "ai_sdk_aborted" : "ai_sdk_generation_failed",
        message: safeErrorMessage(error),
        recoveryAction: abortController.signal.aborted ? "resume" : "retry",
        remoteSettlementKnown: false,
      });
    } finally {
      this.#activeAbortControllers.delete(runKey(command));
    }
  }

  async *resume(value: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(value);
    this.#assertCommandBinding(command);
    const snapshot = this.#requiredSnapshot(command.runId, "resume");
    const checkpointRef = command.checkpointRef ?? command.adapterResumeRef;
    if (checkpointRef === null || checkpointRef.kind !== "checkpoint") {
      throw new RangeError("AI SDK resume requires a checkpoint reference");
    }
    const externalId = requiredExternalId(checkpointRef);
    const checkpoint = await this.#checkpointStore.loadCheckpoint(externalId);
    if (
      checkpoint === null
      || checkpoint.runId !== command.runId
      || checkpoint.runGeneration !== command.runGeneration
      || checkpoint.profileId !== command.profileId
    ) {
      throw new RangeError("AI SDK checkpoint does not match the current run binding");
    }

    const abortController = new AbortController();
    this.#activeAbortControllers.set(runKey(command), abortController);

    try {
      yield observation(command, "resume_accepted", 2);
      yield observation(command, "execution_started", 3);
      yield observation(command, "tool_surface_observed", 4, { snapshot });

      const result = await this.#generate(command, {
        messages: [
          ...checkpoint.messages,
          {
            role: "user",
            content: command.context.intent.nextAction
              ?? "Continue the bounded runner objective from the checkpoint.",
          },
        ],
        abortSignal: abortController.signal,
      });

      yield observation(command, "heartbeat", 5, {
        usage: usageFromResult(result),
        checkpointRef,
      });
      yield observation(command, "completion_proposed", 6, {
        outcome: "AI SDK ToolLoopAgent completed the resumed bounded objective.",
        executionActual: {
          toolCalls: arrayLength(result.toolCalls),
        },
      });
    } catch (error) {
      yield observation(command, "failure_observed", 7, {
        code: abortController.signal.aborted ? "ai_sdk_aborted" : "ai_sdk_generation_failed",
        message: safeErrorMessage(error),
        recoveryAction: abortController.signal.aborted ? "resume" : "retry",
        remoteSettlementKnown: false,
      });
    } finally {
      this.#activeAbortControllers.delete(runKey(command));
    }
  }

  async requestCheckpoint(
    input: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    this.#assertControlBinding(input);
    const checkpoint = this.#latestCheckpoints.get(controlKey(input));
    if (!checkpoint) {
      throw new RangeError("AI SDK latest checkpoint is unavailable for this adapter instance");
    }
    return checkpoint;
  }

  async requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    this.#assertControlBinding(input);
    const controller = this.#activeAbortControllers.get(controlKey(input));
    controller?.abort(input.reason);
    return {
      version: RUNNER_ADAPTER_V1,
      commandId: input.commandId,
      adapterId: VERCEL_AI_SDK_ADAPTER_ID,
      adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
      profileId: input.profileId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      observedAt: input.requestedAt,
      requestAccepted: true,
      deliveryKnown: controller !== undefined,
      remoteSettlementKnown: false,
      reference: null,
    };
  }

  async #generate(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    input: Record<string, unknown>,
  ): Promise<any> {
    return await this.#agent.generate({
      ...input,
      onToolExecutionStart: async (event: unknown) => {
        await this.#authorizeToolExecution?.({ command, event });
      },
    } as any);
  }

  #requiredSnapshot(
    runId: string,
    transition: "new" | "resume",
  ): EffectiveToolSurfaceSnapshot {
    const snapshot = this.#snapshots.get(snapshotKey(runId, transition));
    if (!snapshot) {
      throw new RangeError(
        `AI SDK ${transition} requires a current capability inspection before execution`,
      );
    }
    return snapshot;
  }

  #assertProbeBinding(probe: RunnerCapabilityProbeV1): void {
    if (
      probe.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || probe.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || probe.profileId !== VERCEL_AI_SDK_PROFILE_ID
    ) {
      throw new RangeError("AI SDK capability probe does not match adapter identity");
    }
  }

  #assertCommandBinding(command: RunnerStartCommandV1 | RunnerResumeCommandV1): void {
    if (
      command.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || command.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || command.profileId !== VERCEL_AI_SDK_PROFILE_ID
      || command.profileVersion !== VERCEL_AI_SDK_PROFILE_VERSION
    ) {
      throw new RangeError("AI SDK command does not match adapter identity");
    }
  }

  #assertControlBinding(input: RunnerCheckpointCommandV1): void {
    if (
      input.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || input.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || input.profileId !== VERCEL_AI_SDK_PROFILE_ID
    ) {
      throw new RangeError("AI SDK control command does not match adapter identity");
    }
  }
}

export function vercelAISDKCheckpointReferenceForStart(
  value: RunnerStartCommandV1,
): RunnerExternalReferenceV1 {
  return checkpointReference(parseRunnerStartCommandV1(value));
}

function defaultCapabilityClasses(
  _probe: RunnerCapabilityProbeV1,
  agent: AnyAgent,
): EffectiveToolSurfaceSnapshotInput["classes"] {
  const tools = Object.keys((agent.tools ?? {}) as Record<string, unknown>)
    .sort()
    .map((id) => ({ id, name: id }));
  return {
    host_dynamic: {
      catalogue: tools,
      executable: tools,
      provenance: [`ai-sdk:${VERCEL_AI_SDK_PACKAGE_VERSION}:tool-loop-agent`],
    },
  };
}

function checkpointReference(
  command: RunnerStartCommandV1,
): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId: VERCEL_AI_SDK_ADAPTER_ID,
    externalId: `ai-sdk-checkpoint-${command.runId}-${command.runGeneration}`,
    digest: null,
    uri: null,
    generation: command.runGeneration,
    createdAt: offsetTimestamp(command.issuedAt, 6),
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function observation(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  type: RunnerObservationV1["type"],
  offsetSeconds: number,
  payload: Record<string, unknown> = {},
): RunnerObservationV1 {
  return parseRunnerObservationV1({
    version: RUNNER_ADAPTER_V1,
    type,
    observationId: `${command.commandId}.${type}.${offsetSeconds}`,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    profileVersion: command.profileVersion,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    observedAt: offsetTimestamp(command.issuedAt, offsetSeconds),
    references: [],
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
    ...payload,
  });
}

function usageFromResult(result: any) {
  const usage = result?.usage;
  return {
    ...(tokenTotal(usage?.inputTokens) === undefined
      ? {}
      : { inputTokens: tokenTotal(usage?.inputTokens) }),
    ...(tokenTotal(usage?.outputTokens) === undefined
      ? {}
      : { outputTokens: tokenTotal(usage?.outputTokens) }),
    toolCalls: arrayLength(result?.toolCalls),
    childAgents: 0,
  };
}

function tokenTotal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (
    value !== null
    && typeof value === "object"
    && typeof (value as { total?: unknown }).total === "number"
  ) {
    return (value as { total: number }).total;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runKey(command: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${command.runId}:${command.runGeneration}:${command.leaseGeneration}`;
}

function controlKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${input.runId}:${input.runGeneration}:${input.leaseGeneration}`;
}

function snapshotKey(runId: string, transition: string): string {
  return `${runId}:${transition}`;
}

function requiredExternalId(reference: RunnerExternalReferenceV1): string {
  if (reference.externalId === null) {
    throw new RangeError("AI SDK checkpoint reference requires an external ID");
  }
  return reference.externalId;
}

function offsetTimestamp(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "AI SDK generation failed";
  return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`;
}
