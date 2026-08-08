import {
  ToolLoopAgent,
  type Agent,
  type ToolLoopAgentSettings,
} from "ai";
import { sha256, stableJson } from "../canonical-json.js";
import type {
  EffectiveToolSurfaceSnapshot,
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceCapabilityRequirementInput,
} from "../effective-tool-surface.js";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
  requireRunnerCapabilityInspectionForCommandV1,
  type RunnerCapabilityInspectionV1,
} from "../runner-capability-binding.js";
import { assertRunnerCommandAuthorityActiveV1 } from "../runner-command-authority.js";
import {
  RUNNER_ADAPTER_V1,
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

const credentialShapedTextPattern =
  /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/giu;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const maximumCheckpointCharacters = 1_000_000;
const maximumCachedEntries = 256;
const maximumInspectionAgeMilliseconds = 60 * 60 * 1_000;

type AnyAgent = Agent<never, any, any, any>;
type AnyToolLoopAgentSettings = ToolLoopAgentSettings<never, any, any, any>;
type GuardedToolLoopAgentSettings = Omit<
  AnyToolLoopAgentSettings,
  "prepareCall" | "toolApproval" | "runtimeContext"
>;

interface PendingCapabilityInspection {
  probe: RunnerCapabilityProbeV1;
  inspection: RunnerCapabilityInspectionV1;
}

export interface VercelAISDKCheckpointRecordV1 {
  version: 1;
  externalId: string;
  adapterVersion: string;
  commandId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  profileId: string;
  profileVersion: string;
  createdAt: string;
  bindingDigest: string;
  messagesDigest: string;
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
  agentSettings: GuardedToolLoopAgentSettings;
  checkpointStore: VercelAISDKCheckpointStore;
  capabilityClasses?: (
    input: RunnerCapabilityProbeV1,
    agent: AnyAgent,
  ) => EffectiveToolSurfaceSnapshotInput["classes"];
  authorizeToolExecution?: (
    input: VercelAISDKToolExecutionInput,
  ) => Promise<void> | void;
  now?: () => Date;
}

export class VercelAISDKRunnerAdapter implements RunnerAdapterV1 {
  readonly #agent: AnyAgent;
  readonly #checkpointStore: VercelAISDKCheckpointStore;
  readonly #capabilityClasses: NonNullable<
    VercelAISDKRunnerAdapterOptions["capabilityClasses"]
  >;
  readonly #authorizeToolExecution?: VercelAISDKRunnerAdapterOptions["authorizeToolExecution"];
  readonly #now: () => Date;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #inspections = new Map<string, PendingCapabilityInspection>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();
  readonly #activeAbortControllers = new Map<string, AbortController>();
  readonly #authorityHolders = new Map<string, string>();

  constructor(options: VercelAISDKRunnerAdapterOptions) {
    this.#checkpointStore = options.checkpointStore;
    this.#capabilityClasses = options.capabilityClasses ?? defaultCapabilityClasses;
    this.#authorizeToolExecution = options.authorizeToolExecution;
    this.#now = options.now ?? (() => new Date());
    assertStaticAgentSettings(options.agentSettings);
    this.#agent = new ToolLoopAgent({
      ...options.agentSettings,
      toolApproval: async (event: any) => {
        if (!this.#authorizeToolExecution) {
          throw new Error(
            "Stensibly tool authorization is required before AI SDK tool execution",
          );
        }
        try {
          await this.#authorizeToolExecution({
            command: event.runtimeContext.command,
            event,
          });
        } catch {
          throw new Error(
            "Stensibly tool authorization rejected the AI SDK tool proposal",
          );
        }
        return "approved" as const;
      },
    } as AnyToolLoopAgentSettings);
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
        durableReplay: false,
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
    assertNoProviderExecutedTools(this.#agent);
    const inspection = buildRunnerCapabilityInspectionV1(
      this.#descriptor,
      probe,
      this.#capabilityClasses(probe, this.#agent),
    );
    this.#inspections.set(inspectionKey(probe.runId, probe.transition), {
      probe,
      inspection,
    });
    return inspection.snapshot;
  }

  async *start(value: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(value);
    this.#assertCommandBinding(command);
    const snapshot = this.#requiredSnapshot(command, "new");
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
      await this.#checkpointStore.saveCheckpoint({
        externalId: requiredExternalId(reference),
        adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
        runId: command.runId,
        runGeneration: command.runGeneration,
        profileId: command.profileId,
        profileVersion: command.profileVersion,
        createdAt: reference.createdAt,
        messages: [
          { role: "user", content: command.context.intent.objective },
          ...arrayValue(result.responseMessages),
        ],
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
    const snapshot = this.#requiredSnapshot(command, "resume");
    const checkpointRef = command.checkpointRef ?? command.adapterResumeRef;
    if (checkpointRef === null || checkpointRef.kind !== "checkpoint") {
      throw new RangeError("AI SDK resume requires a checkpoint reference");
    }
    assertCheckpointReferenceBinding(checkpointRef, command);
    const externalId = requiredExternalId(checkpointRef);
    const checkpoint = await this.#checkpointStore.loadCheckpoint(externalId);
    if (
      checkpoint === null
      || checkpoint.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || checkpoint.runId !== command.runId
      || checkpoint.runGeneration !== command.runGeneration
      || checkpoint.profileId !== command.profileId
      || checkpoint.profileVersion !== command.profileVersion
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
        executionActual: { toolCalls: arrayLength(result.toolCalls) },
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
      runtimeContext: { command },
    } as any);
  }

  #requiredSnapshot(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    transition: "new" | "resume",
  ): EffectiveToolSurfaceSnapshot {
    const key = inspectionKey(command.runId, transition);
    const pending = this.#inspections.get(key);
    if (!pending) {
      throw new RangeError(
        `AI SDK ${transition} requires a current capability inspection before execution`,
      );
    }

    assertNoProviderExecutedTools(this.#agent);
    const currentInspection = buildRunnerCapabilityInspectionV1(
      this.#descriptor,
      pending.probe,
      this.#capabilityClasses(pending.probe, this.#agent),
    );
    if (
      currentInspection.snapshot.surfaceFingerprint
        !== pending.inspection.snapshot.surfaceFingerprint
    ) {
      this.#inspections.delete(key);
      throw new RangeError(
        "AI SDK capability surface changed after inspection and before execution",
      );
    }

    const binding = bindRunnerCapabilityInspectionToCommandV1(
      pending.inspection,
      command,
    );
    const snapshot = requireRunnerCapabilityInspectionForCommandV1(
      binding,
      command,
    );
    this.#inspections.delete(key);
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

function assertStaticAgentSettings(settings: GuardedToolLoopAgentSettings): void {
  if (
    Object.prototype.hasOwnProperty.call(settings, "prepareCall")
    || Object.prototype.hasOwnProperty.call(settings, "toolApproval")
    || Object.prototype.hasOwnProperty.call(settings, "runtimeContext")
  ) {
    throw new RangeError(
      "AI SDK first-profile settings cannot override prepareCall, toolApproval, or runtimeContext",
    );
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
  const catalogue: Array<{ id: string; name: string }> = [];
  const executable: Array<{ id: string; name: string }> = [];
  for (const [id, value] of Object.entries(
    (agent.tools ?? {}) as Record<string, unknown>,
  )) {
    const capability = { id, name: id };
    catalogue.push(capability);
    if (isLocallyExecutableAITool(value)) executable.push(capability);
  }
  catalogue.sort((left, right) => left.id.localeCompare(right.id));
  executable.sort((left, right) => left.id.localeCompare(right.id));
  return {
    host_dynamic: {
      catalogue,
      executable,
      provenance: [`ai-sdk:${VERCEL_AI_SDK_PACKAGE_VERSION}:tool-loop-agent`],
    },
  };
}

function assertNoProviderExecutedTools(agent: AnyAgent): void {
  for (const [id, value] of Object.entries(
    (agent.tools ?? {}) as Record<string, unknown>,
  )) {
    if (isProviderExecutedAITool(value)) {
      throw new RangeError(
        `AI SDK provider-executed tool ${id} is outside the first Stensibly profile`,
      );
    }
  }
}

function isProviderExecutedAITool(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && (value as { type?: unknown }).type === "provider"
    && (value as { isProviderExecuted?: unknown }).isProviderExecuted === true;
}

function isLocallyExecutableAITool(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "execute" in value
    && typeof (value as { execute?: unknown }).execute === "function";
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

function assertCheckpointReferenceBinding(
  reference: RunnerExternalReferenceV1,
  command: RunnerResumeCommandV1,
): void {
  if (
    reference.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
    || reference.generation !== command.runGeneration
  ) {
    throw new RangeError("AI SDK checkpoint reference does not match the current run binding");
  }
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
  const inputTokens = tokenTotal(usage?.inputTokens);
  const outputTokens = tokenTotal(usage?.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
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
    const total = (value as { total: number }).total;
    return Number.isFinite(total) && total >= 0 ? total : undefined;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${input.runId}:${input.runGeneration}:${input.leaseGeneration}`;
}

function controlKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return runKey(input);
}

function inspectionKey(runId: string, transition: string): string {
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
  const raw = error instanceof Error ? error.message : "AI SDK generation failed";
  const sanitized = raw
    .replace(credentialShapedTextPattern, "[redacted]")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/g, " ")
    .trim();
  const message = sanitized.length > 0 ? sanitized : "AI SDK generation failed";
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
}
