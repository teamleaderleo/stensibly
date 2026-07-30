import type { RunAuthorityFence } from "./authority-fence.js";
import type { RunnerContextPacket } from "./context-packets.js";
import {
  buildEffectiveToolSurfaceSnapshot,
  effectiveToolSurfaceTransitions,
  type EffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshotInput,
  type EffectiveToolSurfaceTransition,
  type ToolSurfaceCapabilityRequirementInput,
} from "./effective-tool-surface.js";
import {
  parseExecutionActual,
  parseExecutionEnvelope,
  type ExecutionActual,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import type { RunUsage } from "./runs.js";

export const RUNNER_ADAPTER_V1 = 1 as const;

export const runnerAdapterCheckpointModes = [
  "none",
  "external_reference",
  "opaque_token",
] as const;
export type RunnerAdapterCheckpointMode =
  typeof runnerAdapterCheckpointModes[number];

export const runnerAdapterCancellationModes = [
  "unsupported",
  "best_effort",
  "acknowledged",
  "settled",
] as const;
export type RunnerAdapterCancellationMode =
  typeof runnerAdapterCancellationModes[number];

export const runnerExternalReferenceKinds = [
  "session",
  "continuation",
  "checkpoint",
  "trace",
  "usage",
  "log",
  "artifact",
  "provider_receipt",
] as const;
export type RunnerExternalReferenceKind =
  typeof runnerExternalReferenceKinds[number];

export const runnerReferenceAccessClasses = [
  "private",
  "project",
  "workspace",
] as const;
export type RunnerReferenceAccessClass =
  typeof runnerReferenceAccessClasses[number];

export const runnerResumeReasons = [
  "continuation",
  "reconnect",
  "recovery",
  "retry",
  "handoff",
] as const;
export type RunnerResumeReason = typeof runnerResumeReasons[number];

export const runnerRecoveryActions = [
  "resume",
  "retry",
  "reconcile",
  "handoff",
  "none",
] as const;
export type RunnerRecoveryAction = typeof runnerRecoveryActions[number];

export const runnerObservationTypes = [
  "start_accepted",
  "resume_accepted",
  "execution_started",
  "heartbeat",
  "tool_surface_observed",
  "work_step",
  "checkpoint_published",
  "artifact_published",
  "paused",
  "completion_proposed",
  "failure_observed",
  "interrupted",
] as const;
export type RunnerObservationType = typeof runnerObservationTypes[number];

export interface RunnerAdapterProfileV1 {
  id: string;
  version: string;
}

export interface RunnerAdapterDescriptorV1 {
  version: typeof RUNNER_ADAPTER_V1;
  adapterId: string;
  adapterVersion: string;
  profiles: readonly RunnerAdapterProfileV1[];
  transports: readonly string[];
  checkpointMode: RunnerAdapterCheckpointMode;
  cancellationMode: RunnerAdapterCancellationMode;
  supports: {
    start: true;
    resume: boolean;
    capabilityInspection: boolean;
    streamingObservations: boolean;
    durableReplay: boolean;
    usageReferences: boolean;
    traceReferences: boolean;
  };
}

export interface RunnerExternalReferenceV1 {
  version: typeof RUNNER_ADAPTER_V1;
  kind: RunnerExternalReferenceKind;
  adapterId: string;
  externalId: string | null;
  digest: string | null;
  uri: string | null;
  generation: number | null;
  createdAt: string;
  accessClass: RunnerReferenceAccessClass;
  containsPrivateContent: false;
  containsCredentials: false;
}

export interface RunnerContinuationBindingV1 {
  id: string;
  generation: number;
}

interface RunnerCommandBaseV1 {
  version: typeof RUNNER_ADAPTER_V1;
  commandId: string;
  correlationId: string | null;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authority: RunAuthorityFence;
  itemId: string;
  project: string;
  executionEnvelope: ExecutionEnvelope;
  context: RunnerContextPacket;
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  capabilityGrantRefs: readonly string[];
  issuedAt: string;
}

export interface RunnerStartCommandV1 extends RunnerCommandBaseV1 {
  kind: "start";
}

export interface RunnerResumeCommandV1 extends RunnerCommandBaseV1 {
  kind: "resume";
  continuation: RunnerContinuationBindingV1;
  adapterResumeRef: RunnerExternalReferenceV1 | null;
  checkpointRef: RunnerExternalReferenceV1 | null;
  reason: RunnerResumeReason;
}

export interface RunnerCapabilityProbeV1 {
  version: typeof RUNNER_ADAPTER_V1;
  probeId: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  transport: string;
  transition: EffectiveToolSurfaceTransition;
  clientProduct: string;
  clientBuild: string | null;
  modelProfile: string | null;
  externalSurfaceRef: string | null;
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  recoveryActions: EffectiveToolSurfaceSnapshotInput["recoveryActions"];
  observedAt: string;
  traceId: string | null;
}

interface RunnerObservationBaseV1 {
  version: typeof RUNNER_ADAPTER_V1;
  type: RunnerObservationType;
  observationId: string;
  commandId: string;
  correlationId: string | null;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  observedAt: string;
  references: readonly RunnerExternalReferenceV1[];
  observationAuthority: "adapter_report";
  durableTransitionApplied: false;
}

export interface RunnerStartAcceptedObservationV1
  extends RunnerObservationBaseV1 {
  type: "start_accepted";
}

export interface RunnerResumeAcceptedObservationV1
  extends RunnerObservationBaseV1 {
  type: "resume_accepted";
}

export interface RunnerExecutionStartedObservationV1
  extends RunnerObservationBaseV1 {
  type: "execution_started";
}

export interface RunnerHeartbeatObservationV1
  extends RunnerObservationBaseV1 {
  type: "heartbeat";
  usage: RunUsage;
  checkpointRef: RunnerExternalReferenceV1 | null;
}

export interface RunnerToolSurfaceObservationV1
  extends RunnerObservationBaseV1 {
  type: "tool_surface_observed";
  snapshot: EffectiveToolSurfaceSnapshot;
}

export interface RunnerWorkStepObservationV1
  extends RunnerObservationBaseV1 {
  type: "work_step";
  phase: string;
  summary: string;
}

export interface RunnerCheckpointPublishedObservationV1
  extends RunnerObservationBaseV1 {
  type: "checkpoint_published";
  reference: RunnerExternalReferenceV1;
}

export interface RunnerArtifactPublishedObservationV1
  extends RunnerObservationBaseV1 {
  type: "artifact_published";
  reference: RunnerExternalReferenceV1;
}

export interface RunnerPausedObservationV1
  extends RunnerObservationBaseV1 {
  type: "paused";
  reason: string;
  continuationId: string | null;
  decisionId: string | null;
}

export interface RunnerCompletionProposedObservationV1
  extends RunnerObservationBaseV1 {
  type: "completion_proposed";
  outcome: string;
  executionActual: ExecutionActual;
}

export interface RunnerFailureObservedObservationV1
  extends RunnerObservationBaseV1 {
  type: "failure_observed";
  code: string;
  message: string;
  recoveryAction: RunnerRecoveryAction;
  remoteSettlementKnown: false;
}

export interface RunnerInterruptedObservationV1
  extends RunnerObservationBaseV1 {
  type: "interrupted";
  code: string;
  message: string;
  checkpointRef: RunnerExternalReferenceV1 | null;
  recoveryAction: RunnerRecoveryAction;
  remoteSettlementKnown: false;
}

export type RunnerObservationV1 =
  | RunnerStartAcceptedObservationV1
  | RunnerResumeAcceptedObservationV1
  | RunnerExecutionStartedObservationV1
  | RunnerHeartbeatObservationV1
  | RunnerToolSurfaceObservationV1
  | RunnerWorkStepObservationV1
  | RunnerCheckpointPublishedObservationV1
  | RunnerArtifactPublishedObservationV1
  | RunnerPausedObservationV1
  | RunnerCompletionProposedObservationV1
  | RunnerFailureObservedObservationV1
  | RunnerInterruptedObservationV1;

export interface RunnerCheckpointCommandV1 {
  version: typeof RUNNER_ADAPTER_V1;
  commandId: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authority: RunAuthorityFence;
  requestedAt: string;
}

export interface RunnerCancellationCommandV1
  extends RunnerCheckpointCommandV1 {
  reason: string;
}

export interface RunnerCancellationObservationV1 {
  version: typeof RUNNER_ADAPTER_V1;
  commandId: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  observedAt: string;
  requestAccepted: boolean;
  deliveryKnown: boolean;
  remoteSettlementKnown: false;
  reference: RunnerExternalReferenceV1 | null;
}

export interface RunnerAdapterV1 {
  describe(): RunnerAdapterDescriptorV1;
  inspectCapabilities(
    input: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot>;
  start(input: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1>;
  resume(input: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1>;
  requestCheckpoint(
    input: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1>;
  requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1>;
}

const limits = {
  identifier: 160,
  version: 160,
  text: 2_000,
  profiles: 64,
  transports: 16,
  references: 32,
  grants: 32,
  requiredCapabilities: 1_000,
} as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialPattern = /(?:stn\.tok_|github_pat_|gh[pousr]_|sk-(?:proj-)?|Bearer\s+)[A-Za-z0-9._~+\/-]+/iu;

export function parseRunnerAdapterDescriptorV1(
  value: unknown,
): RunnerAdapterDescriptorV1 {
  const input = strictRecord(value, "Runner adapter descriptor", [
    "version",
    "adapterId",
    "adapterVersion",
    "profiles",
    "transports",
    "checkpointMode",
    "cancellationMode",
    "supports",
  ]);
  requireVersion(input.version, "Runner adapter descriptor");
  const adapterId = boundedIdentifier(input.adapterId, "Runner adapter ID");
  const adapterVersion = boundedText(
    input.adapterVersion,
    "Runner adapter version",
    limits.version,
  );
  const profiles = uniqueRecords(
    input.profiles,
    "Runner adapter profile",
    limits.profiles,
    (entry, index) => {
      const profile = strictRecord(entry, `Runner adapter profile ${index + 1}`, [
        "id",
        "version",
      ]);
      return {
        id: boundedIdentifier(profile.id, `Runner adapter profile ${index + 1} ID`),
        version: boundedText(
          profile.version,
          `Runner adapter profile ${index + 1} version`,
          limits.version,
        ),
      };
    },
    (entry) => entry.id,
  );
  const transports = uniqueTexts(
    input.transports,
    "Runner adapter transport",
    limits.transports,
  );
  if (profiles.length === 0) {
    throw new RangeError("Runner adapter descriptor requires at least one profile");
  }
  if (transports.length === 0) {
    throw new RangeError("Runner adapter descriptor requires at least one transport");
  }
  const supportsInput = strictRecord(input.supports, "Runner adapter support", [
    "start",
    "resume",
    "capabilityInspection",
    "streamingObservations",
    "durableReplay",
    "usageReferences",
    "traceReferences",
  ]);
  if (supportsInput.start !== true) {
    throw new RangeError("Runner adapter v1 must support start");
  }
  const supports = {
    start: true as const,
    resume: booleanValue(supportsInput.resume, "Runner adapter resume support"),
    capabilityInspection: booleanValue(
      supportsInput.capabilityInspection,
      "Runner adapter capability-inspection support",
    ),
    streamingObservations: booleanValue(
      supportsInput.streamingObservations,
      "Runner adapter streaming-observation support",
    ),
    durableReplay: booleanValue(
      supportsInput.durableReplay,
      "Runner adapter durable-replay support",
    ),
    usageReferences: booleanValue(
      supportsInput.usageReferences,
      "Runner adapter usage-reference support",
    ),
    traceReferences: booleanValue(
      supportsInput.traceReferences,
      "Runner adapter trace-reference support",
    ),
  };
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    adapterId,
    adapterVersion,
    profiles,
    transports,
    checkpointMode: exactEnum(
      input.checkpointMode,
      runnerAdapterCheckpointModes,
      "Runner adapter checkpoint mode",
    ),
    cancellationMode: exactEnum(
      input.cancellationMode,
      runnerAdapterCancellationModes,
      "Runner adapter cancellation mode",
    ),
    supports,
  });
}

export function parseRunnerExternalReferenceV1(
  value: unknown,
): RunnerExternalReferenceV1 {
  const input = strictRecord(value, "Runner external reference", [
    "version",
    "kind",
    "adapterId",
    "externalId",
    "digest",
    "uri",
    "generation",
    "createdAt",
    "accessClass",
    "containsPrivateContent",
    "containsCredentials",
  ]);
  requireVersion(input.version, "Runner external reference");
  const externalId = nullableIdentifier(input.externalId, "Runner external ID");
  const digest = input.digest === null
    ? null
    : boundedPattern(input.digest, "Runner external digest", digestPattern, 71);
  const uri = nullableText(input.uri, "Runner external URI", 2_000);
  if (externalId === null && digest === null && uri === null) {
    throw new RangeError(
      "Runner external reference requires an external ID, digest, or URI",
    );
  }
  if (input.containsPrivateContent !== false || input.containsCredentials !== false) {
    throw new RangeError(
      "Runner external references must exclude private content and credentials",
    );
  }
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    kind: exactEnum(
      input.kind,
      runnerExternalReferenceKinds,
      "Runner external reference kind",
    ),
    adapterId: boundedIdentifier(input.adapterId, "Runner external adapter ID"),
    externalId,
    digest,
    uri,
    generation: nullableGeneration(input.generation, "Runner external generation"),
    createdAt: canonicalTimestamp(input.createdAt, "Runner external creation time"),
    accessClass: exactEnum(
      input.accessClass,
      runnerReferenceAccessClasses,
      "Runner external access class",
    ),
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

export function parseRunnerStartCommandV1(value: unknown): RunnerStartCommandV1 {
  const input = parseCommandBase(value, "start");
  return deepFreeze({ ...input, kind: "start" as const });
}

export function parseRunnerResumeCommandV1(value: unknown): RunnerResumeCommandV1 {
  const raw = strictRecord(value, "Runner resume command", [
    ...commandBaseKeys,
    "continuation",
    "adapterResumeRef",
    "checkpointRef",
    "reason",
  ]);
  const base = parseCommandBase(raw, "resume");
  const continuationInput = strictRecord(
    raw.continuation,
    "Runner continuation binding",
    ["id", "generation"],
  );
  const continuation = {
    id: boundedIdentifier(continuationInput.id, "Runner continuation ID"),
    generation: positiveInteger(
      continuationInput.generation,
      "Runner continuation generation",
    ),
  };
  const adapterResumeRef = nullableReference(
    raw.adapterResumeRef,
    "Runner adapter resume reference",
  );
  if (
    adapterResumeRef !== null
    && !(["session", "continuation", "checkpoint"] as const).includes(
      adapterResumeRef.kind as "session" | "continuation" | "checkpoint",
    )
  ) {
    throw new RangeError(
      "Runner adapter resume reference must be a session, continuation, or checkpoint",
    );
  }
  const checkpointRef = nullableReference(
    raw.checkpointRef,
    "Runner checkpoint reference",
  );
  if (checkpointRef !== null && checkpointRef.kind !== "checkpoint") {
    throw new RangeError("Runner checkpoint reference must use checkpoint kind");
  }
  return deepFreeze({
    ...base,
    kind: "resume" as const,
    continuation,
    adapterResumeRef,
    checkpointRef,
    reason: exactEnum(raw.reason, runnerResumeReasons, "Runner resume reason"),
  });
}

export function parseRunnerCapabilityProbeV1(
  value: unknown,
): RunnerCapabilityProbeV1 {
  const input = strictRecord(value, "Runner capability probe", [
    "version",
    "probeId",
    "adapterId",
    "adapterVersion",
    "profileId",
    "runId",
    "runGeneration",
    "transport",
    "transition",
    "clientProduct",
    "clientBuild",
    "modelProfile",
    "externalSurfaceRef",
    "requiredCapabilities",
    "recoveryActions",
    "observedAt",
    "traceId",
  ]);
  requireVersion(input.version, "Runner capability probe");
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    probeId: boundedIdentifier(input.probeId, "Runner capability probe ID"),
    adapterId: boundedIdentifier(input.adapterId, "Runner capability adapter ID"),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner capability adapter version",
      limits.version,
    ),
    profileId: boundedIdentifier(input.profileId, "Runner capability profile ID"),
    runId: boundedIdentifier(input.runId, "Runner capability run ID"),
    runGeneration: nonNegativeInteger(
      input.runGeneration,
      "Runner capability run generation",
    ),
    transport: boundedIdentifier(input.transport, "Runner capability transport"),
    transition: exactEnum(
      input.transition,
      effectiveToolSurfaceTransitions,
      "Runner capability transition",
    ),
    clientProduct: boundedText(
      input.clientProduct,
      "Runner capability client product",
      limits.identifier,
    ),
    clientBuild: nullableText(
      input.clientBuild,
      "Runner capability client build",
      limits.identifier,
    ),
    modelProfile: nullableText(
      input.modelProfile,
      "Runner capability model profile",
      limits.identifier,
    ),
    externalSurfaceRef: nullableText(
      input.externalSurfaceRef,
      "Runner capability external surface reference",
      limits.text,
    ),
    requiredCapabilities: normalizeRequiredCapabilities(input.requiredCapabilities),
    recoveryActions: normalizeOptionalStrings(
      input.recoveryActions,
      "Runner capability recovery action",
      32,
    ) as EffectiveToolSurfaceSnapshotInput["recoveryActions"],
    observedAt: canonicalTimestamp(input.observedAt, "Runner capability observation time"),
    traceId: nullableIdentifier(input.traceId, "Runner capability trace ID"),
  });
}

export function buildRunnerCapabilitySnapshotV1(
  probeValue: RunnerCapabilityProbeV1,
  classes: EffectiveToolSurfaceSnapshotInput["classes"],
): EffectiveToolSurfaceSnapshot {
  const probe = parseRunnerCapabilityProbeV1(probeValue);
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: probe.probeId,
    runnerAdapter: probe.adapterId,
    runnerVersion: probe.adapterVersion,
    clientProduct: probe.clientProduct,
    ...(probe.clientBuild === null ? {} : { clientBuild: probe.clientBuild }),
    ...(probe.modelProfile === null ? {} : { modelProfile: probe.modelProfile }),
    ...(probe.externalSurfaceRef === null
      ? {}
      : { externalSurfaceRef: probe.externalSurfaceRef }),
    runId: probe.runId,
    runGeneration: probe.runGeneration,
    transport: probe.transport,
    transition: probe.transition,
    classes,
    requiredCapabilities: probe.requiredCapabilities,
    recoveryActions: probe.recoveryActions,
    observedAt: probe.observedAt,
    ...(probe.traceId === null ? {} : { traceId: probe.traceId }),
  });
}

export function parseRunnerObservationV1(value: unknown): RunnerObservationV1 {
  const input = strictRecord(value, "Runner observation", observationKeys);
  requireVersion(input.version, "Runner observation");
  const type = exactEnum(
    input.type,
    runnerObservationTypes,
    "Runner observation type",
  );
  const common = parseObservationCommon(input, type);
  switch (type) {
    case "start_accepted":
      rejectUnexpectedObservationKeys(input, type, []);
      return deepFreeze({ ...common, type });
    case "resume_accepted":
      rejectUnexpectedObservationKeys(input, type, []);
      return deepFreeze({ ...common, type });
    case "execution_started":
      rejectUnexpectedObservationKeys(input, type, []);
      return deepFreeze({ ...common, type });
    case "heartbeat":
      rejectUnexpectedObservationKeys(input, type, ["usage", "checkpointRef"]);
      return deepFreeze({
        ...common,
        type,
        usage: parseRunUsage(input.usage),
        checkpointRef: nullableKindReference(
          input.checkpointRef,
          "checkpoint",
          "Runner heartbeat checkpoint",
        ),
      });
    case "tool_surface_observed": {
      rejectUnexpectedObservationKeys(input, type, ["snapshot"]);
      const snapshot = buildEffectiveToolSurfaceSnapshot(
        input.snapshot as EffectiveToolSurfaceSnapshotInput,
      );
      return deepFreeze({ ...common, type, snapshot });
    }
    case "work_step":
      rejectUnexpectedObservationKeys(input, type, ["phase", "summary"]);
      return deepFreeze({
        ...common,
        type,
        phase: boundedIdentifier(input.phase, "Runner work-step phase"),
        summary: boundedText(input.summary, "Runner work-step summary", limits.text),
      });
    case "checkpoint_published":
      rejectUnexpectedObservationKeys(input, type, ["reference"]);
      return deepFreeze({
        ...common,
        type,
        reference: requiredKindReference(
          input.reference,
          "checkpoint",
          "Runner checkpoint publication",
        ),
      });
    case "artifact_published":
      rejectUnexpectedObservationKeys(input, type, ["reference"]);
      return deepFreeze({
        ...common,
        type,
        reference: requiredKindReference(
          input.reference,
          "artifact",
          "Runner artifact publication",
        ),
      });
    case "paused":
      rejectUnexpectedObservationKeys(input, type, [
        "reason",
        "continuationId",
        "decisionId",
      ]);
      return deepFreeze({
        ...common,
        type,
        reason: boundedText(input.reason, "Runner pause reason", limits.text),
        continuationId: nullableIdentifier(
          input.continuationId,
          "Runner paused continuation ID",
        ),
        decisionId: nullableIdentifier(input.decisionId, "Runner paused decision ID"),
      });
    case "completion_proposed":
      rejectUnexpectedObservationKeys(input, type, ["outcome", "executionActual"]);
      return deepFreeze({
        ...common,
        type,
        outcome: boundedText(input.outcome, "Runner completion outcome", limits.text),
        executionActual: parseExecutionActual(input.executionActual),
      });
    case "failure_observed":
      rejectUnexpectedObservationKeys(input, type, [
        "code",
        "message",
        "recoveryAction",
        "remoteSettlementKnown",
      ]);
      if (input.remoteSettlementKnown !== false) {
        throw new RangeError(
          "Runner failure observation cannot claim remote settlement in v1",
        );
      }
      return deepFreeze({
        ...common,
        type,
        code: boundedIdentifier(input.code, "Runner failure code"),
        message: boundedText(input.message, "Runner failure message", limits.text),
        recoveryAction: exactEnum(
          input.recoveryAction,
          runnerRecoveryActions,
          "Runner failure recovery action",
        ),
        remoteSettlementKnown: false,
      });
    case "interrupted":
      rejectUnexpectedObservationKeys(input, type, [
        "code",
        "message",
        "checkpointRef",
        "recoveryAction",
        "remoteSettlementKnown",
      ]);
      if (input.remoteSettlementKnown !== false) {
        throw new RangeError(
          "Runner interruption cannot claim remote settlement in v1",
        );
      }
      return deepFreeze({
        ...common,
        type,
        code: boundedIdentifier(input.code, "Runner interruption code"),
        message: boundedText(
          input.message,
          "Runner interruption message",
          limits.text,
        ),
        checkpointRef: nullableKindReference(
          input.checkpointRef,
          "checkpoint",
          "Runner interruption checkpoint",
        ),
        recoveryAction: exactEnum(
          input.recoveryAction,
          runnerRecoveryActions,
          "Runner interruption recovery action",
        ),
        remoteSettlementKnown: false,
      });
  }
}

export function assertRunnerObservationBinding(
  descriptorValue: RunnerAdapterDescriptorV1,
  commandValue: RunnerStartCommandV1 | RunnerResumeCommandV1,
  observationValue: RunnerObservationV1,
): RunnerObservationV1 {
  const descriptor = parseRunnerAdapterDescriptorV1(descriptorValue);
  const command = commandValue.kind === "start"
    ? parseRunnerStartCommandV1(commandValue)
    : parseRunnerResumeCommandV1(commandValue);
  const observation = parseRunnerObservationV1(observationValue);
  if (command.adapterId !== descriptor.adapterId) {
    throw new RangeError("Runner command adapter does not match descriptor");
  }
  if (command.adapterVersion !== descriptor.adapterVersion) {
    throw new RangeError("Runner command adapter version does not match descriptor");
  }
  const profile = descriptor.profiles.find((entry) => entry.id === command.profileId);
  if (!profile || profile.version !== command.profileVersion) {
    throw new RangeError("Runner command profile is absent from the adapter descriptor");
  }
  if (observation.adapterId !== command.adapterId) {
    throw new RangeError("Runner observation adapter does not match command");
  }
  if (observation.adapterVersion !== command.adapterVersion) {
    throw new RangeError("Runner observation adapter version does not match command");
  }
  if (
    observation.profileId !== command.profileId
    || observation.profileVersion !== command.profileVersion
  ) {
    throw new RangeError("Runner observation profile does not match command");
  }
  if (observation.commandId !== command.commandId) {
    throw new RangeError("Runner observation command ID does not match command");
  }
  if (observation.correlationId !== command.correlationId) {
    throw new RangeError("Runner observation correlation ID does not match command");
  }
  if (observation.runId !== command.runId) {
    throw new RangeError("Runner observation run ID does not match command");
  }
  if (observation.runGeneration !== command.runGeneration) {
    throw new RangeError("Runner observation generation does not match command");
  }
  if (observation.leaseGeneration !== command.leaseGeneration) {
    throw new RangeError("Runner observation lease generation does not match command");
  }
  if (Date.parse(observation.observedAt) < Date.parse(command.issuedAt)) {
    throw new RangeError("Runner observation predates its command");
  }
  if (observation.type === "tool_surface_observed") {
    if (
      observation.snapshot.runId !== command.runId
      || observation.snapshot.runGeneration !== command.runGeneration
      || observation.snapshot.runnerAdapter !== command.adapterId
    ) {
      throw new RangeError("Runner tool-surface snapshot does not match command");
    }
  }
  return observation;
}

export function deduplicateRunnerObservationsV1(
  values: readonly RunnerObservationV1[],
): readonly RunnerObservationV1[] {
  if (!Array.isArray(values) || values.length > 10_000) {
    throw new RangeError("Runner observation batch is invalid or exceeds 10000 entries");
  }
  const byId = new Map<string, { canonical: string; observation: RunnerObservationV1 }>();
  const output: RunnerObservationV1[] = [];
  for (const value of values) {
    const observation = parseRunnerObservationV1(value);
    const canonical = JSON.stringify(observation);
    const existing = byId.get(observation.observationId);
    if (existing) {
      if (existing.canonical !== canonical) {
        throw new RangeError(
          `Runner observation ${observation.observationId} was replayed with different content`,
        );
      }
      continue;
    }
    byId.set(observation.observationId, { canonical, observation });
    output.push(observation);
  }
  return deepFreeze(output);
}

function parseCommandBase(
  value: unknown,
  expectedKind: "start" | "resume",
): RunnerCommandBaseV1 {
  const input = strictRecord(
    value,
    expectedKind === "start" ? "Runner start command" : "Runner resume command",
    expectedKind === "start" ? commandBaseKeys : [
      ...commandBaseKeys,
      "continuation",
      "adapterResumeRef",
      "checkpointRef",
      "reason",
    ],
  );
  requireVersion(input.version, "Runner command");
  if (input.kind !== expectedKind) {
    throw new RangeError(`Runner command kind must be ${expectedKind}`);
  }
  const runId = boundedIdentifier(input.runId, "Runner command run ID");
  const runGeneration = nonNegativeInteger(
    input.runGeneration,
    "Runner command run generation",
  );
  const leaseGeneration = positiveInteger(
    input.leaseGeneration,
    "Runner command lease generation",
  );
  const authority = parseAuthorityFence(input.authority, runId, leaseGeneration);
  const itemId = boundedIdentifier(input.itemId, "Runner command item ID");
  const project = boundedPattern(
    input.project,
    "Runner command project",
    projectPattern,
    80,
  );
  const context = parseContextPacket(input.context, itemId, project);
  const issuedAt = canonicalTimestamp(input.issuedAt, "Runner command issue time");
  if (Date.parse(authority.expiresAt) <= Date.parse(issuedAt)) {
    throw new RangeError("Runner command authority is expired at issue time");
  }
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    commandId: boundedIdentifier(input.commandId, "Runner command ID"),
    correlationId: nullableIdentifier(
      input.correlationId,
      "Runner command correlation ID",
    ),
    adapterId: boundedIdentifier(input.adapterId, "Runner command adapter ID"),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner command adapter version",
      limits.version,
    ),
    profileId: boundedIdentifier(input.profileId, "Runner command profile ID"),
    profileVersion: boundedText(
      input.profileVersion,
      "Runner command profile version",
      limits.version,
    ),
    runId,
    runGeneration,
    leaseGeneration,
    authority,
    itemId,
    project,
    executionEnvelope: parseExecutionEnvelope(input.executionEnvelope),
    context,
    requiredCapabilities: normalizeRequiredCapabilities(input.requiredCapabilities),
    capabilityGrantRefs: uniqueTexts(
      input.capabilityGrantRefs,
      "Runner capability grant reference",
      limits.grants,
    ),
    issuedAt,
  });
}

function parseObservationCommon(
  input: Record<string, unknown>,
  type: RunnerObservationType,
): Omit<RunnerObservationBaseV1, "type"> {
  if (input.observationAuthority !== "adapter_report") {
    throw new RangeError("Runner observation authority must be adapter_report");
  }
  if (input.durableTransitionApplied !== false) {
    throw new RangeError("Runner adapter observations cannot apply durable transitions");
  }
  return {
    version: RUNNER_ADAPTER_V1,
    observationId: boundedIdentifier(input.observationId, "Runner observation ID"),
    commandId: boundedIdentifier(input.commandId, "Runner observation command ID"),
    correlationId: nullableIdentifier(
      input.correlationId,
      "Runner observation correlation ID",
    ),
    adapterId: boundedIdentifier(input.adapterId, "Runner observation adapter ID"),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner observation adapter version",
      limits.version,
    ),
    profileId: boundedIdentifier(input.profileId, "Runner observation profile ID"),
    profileVersion: boundedText(
      input.profileVersion,
      "Runner observation profile version",
      limits.version,
    ),
    runId: boundedIdentifier(input.runId, "Runner observation run ID"),
    runGeneration: nonNegativeInteger(
      input.runGeneration,
      "Runner observation run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner observation lease generation",
    ),
    observedAt: canonicalTimestamp(input.observedAt, "Runner observation time"),
    references: parseReferences(input.references),
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
  };
}

function parseAuthorityFence(
  value: unknown,
  runId: string,
  leaseGeneration: number,
): RunAuthorityFence {
  const input = strictRecord(value, "Runner authority fence", [
    "resource",
    "holderId",
    "generation",
    "expiresAt",
  ]);
  if (input.resource !== `run:${runId}`) {
    throw new RangeError("Runner authority resource does not match run ID");
  }
  const generation = positiveInteger(
    input.generation,
    "Runner authority generation",
  );
  if (generation !== leaseGeneration) {
    throw new RangeError("Runner authority generation does not match lease generation");
  }
  return deepFreeze({
    resource: `run:${runId}`,
    holderId: boundedIdentifier(input.holderId, "Runner authority holder"),
    generation,
    expiresAt: canonicalTimestamp(input.expiresAt, "Runner authority expiry"),
  });
}

function parseContextPacket(
  value: unknown,
  itemId: string,
  project: string,
): RunnerContextPacket {
  const input = strictRecord(value, "Runner context packet", [
    "version",
    "generatedAt",
    "item",
    "intent",
    "events",
    "artifacts",
    "runs",
    "dependencies",
    "sourceReferences",
    "omitted",
    "characterCount",
  ]);
  if (input.version !== 1) throw new RangeError("Runner context packet version must be 1");
  canonicalTimestamp(input.generatedAt, "Runner context packet generation time");
  const item = strictRecord(input.item, "Runner context packet item", [] , true);
  if (item.id !== itemId || item.project !== project) {
    throw new RangeError("Runner context packet item does not match command");
  }
  if (!Array.isArray(input.sourceReferences)) {
    throw new RangeError("Runner context packet source references must be an array");
  }
  const characterCount = nonNegativeInteger(
    input.characterCount,
    "Runner context packet character count",
  );
  if (characterCount > 50_000) {
    throw new RangeError("Runner context packet exceeds the supported character limit");
  }
  return deepFreeze(structuredClone(value) as RunnerContextPacket);
}

function normalizeRequiredCapabilities(
  value: unknown,
): readonly ToolSurfaceCapabilityRequirementInput[] {
  if (!Array.isArray(value) || value.length > limits.requiredCapabilities) {
    throw new RangeError(
      `Runner required capabilities must contain at most ${limits.requiredCapabilities} entries`,
    );
  }
  const seen = new Set<string>();
  const output = value.map((entry, index) => {
    const input = strictRecord(
      entry,
      `Runner required capability ${index + 1}`,
      ["class", "id"],
    );
    const className = boundedIdentifier(
      input.class,
      `Runner required capability ${index + 1} class`,
    ) as ToolSurfaceCapabilityRequirementInput["class"];
    const id = boundedIdentifier(
      input.id,
      `Runner required capability ${index + 1} ID`,
    );
    const key = `${className}\u0000${id}`;
    if (seen.has(key)) throw new RangeError(`Runner required capability ${key} is duplicated`);
    seen.add(key);
    return { class: className, id };
  });
  return deepFreeze(output.sort((left, right) =>
    left.class < right.class ? -1 : left.class > right.class ? 1 :
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
}

function parseRunUsage(value: unknown): RunUsage {
  const input = strictRecord(value, "Runner usage", [
    "inputTokens",
    "outputTokens",
    "toolCalls",
    "childAgents",
  ]);
  return deepFreeze({
    inputTokens: nonNegativeInteger(input.inputTokens, "Runner input tokens"),
    outputTokens: nonNegativeInteger(input.outputTokens, "Runner output tokens"),
    toolCalls: nonNegativeInteger(input.toolCalls, "Runner tool calls"),
    childAgents: nonNegativeInteger(input.childAgents, "Runner child agents"),
  });
}

function parseReferences(value: unknown): readonly RunnerExternalReferenceV1[] {
  if (!Array.isArray(value) || value.length > limits.references) {
    throw new RangeError(
      `Runner observation references must contain at most ${limits.references} entries`,
    );
  }
  const seen = new Set<string>();
  const output = value.map((entry) => {
    const reference = parseRunnerExternalReferenceV1(entry);
    const key = JSON.stringify(reference);
    if (seen.has(key)) throw new RangeError("Runner observation reference is duplicated");
    seen.add(key);
    return reference;
  });
  return deepFreeze(output);
}

function nullableReference(value: unknown, label: string): RunnerExternalReferenceV1 | null {
  if (value === null) return null;
  try {
    return parseRunnerExternalReferenceV1(value);
  } catch (error) {
    throw new RangeError(`${label} is invalid: ${errorMessage(error)}`);
  }
}

function nullableKindReference(
  value: unknown,
  kind: RunnerExternalReferenceKind,
  label: string,
): RunnerExternalReferenceV1 | null {
  const reference = nullableReference(value, label);
  if (reference !== null && reference.kind !== kind) {
    throw new RangeError(`${label} must use ${kind} kind`);
  }
  return reference;
}

function requiredKindReference(
  value: unknown,
  kind: RunnerExternalReferenceKind,
  label: string,
): RunnerExternalReferenceV1 {
  const reference = nullableKindReference(value, kind, label);
  if (reference === null) throw new RangeError(`${label} is required`);
  return reference;
}

function rejectUnexpectedObservationKeys(
  input: Record<string, unknown>,
  type: RunnerObservationType,
  specific: readonly string[],
): void {
  const allowed = new Set([...observationBaseKeys, ...specific]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new RangeError(
      `Runner ${type} observation contains unsupported field ${unexpected[0]}`,
    );
  }
}

const commandBaseKeys = [
  "version",
  "kind",
  "commandId",
  "correlationId",
  "adapterId",
  "adapterVersion",
  "profileId",
  "profileVersion",
  "runId",
  "runGeneration",
  "leaseGeneration",
  "authority",
  "itemId",
  "project",
  "executionEnvelope",
  "context",
  "requiredCapabilities",
  "capabilityGrantRefs",
  "issuedAt",
] as const;

const observationBaseKeys = [
  "version",
  "type",
  "observationId",
  "commandId",
  "correlationId",
  "adapterId",
  "adapterVersion",
  "profileId",
  "profileVersion",
  "runId",
  "runGeneration",
  "leaseGeneration",
  "observedAt",
  "references",
  "observationAuthority",
  "durableTransitionApplied",
] as const;

const observationKeys = [
  ...observationBaseKeys,
  "usage",
  "checkpointRef",
  "snapshot",
  "phase",
  "summary",
  "reference",
  "reason",
  "continuationId",
  "decisionId",
  "outcome",
  "executionActual",
  "code",
  "message",
  "recoveryAction",
  "remoteSettlementKnown",
] as const;

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  allowUnknown = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const output = value as Record<string, unknown>;
  if (!allowUnknown) {
    const unexpected = Object.keys(output).filter((key) => !allowedKeys.includes(key));
    if (unexpected.length > 0) {
      throw new RangeError(`${label} contains unsupported field ${unexpected[0]}`);
    }
  }
  return output;
}

function uniqueRecords<T>(
  value: unknown,
  label: string,
  maximum: number,
  parse: (entry: unknown, index: number) => T,
  key: (entry: T) => string,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} list must contain at most ${maximum} entries`);
  }
  const seen = new Set<string>();
  const output = value.map((entry, index) => {
    const parsed = parse(entry, index);
    const identity = key(parsed);
    if (seen.has(identity)) throw new RangeError(`${label} ${identity} is duplicated`);
    seen.add(identity);
    return parsed;
  });
  return deepFreeze(output.sort((left, right) =>
    key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0
  ));
}

function uniqueTexts(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} list must contain at most ${maximum} entries`);
  }
  const seen = new Set<string>();
  const output = value.map((entry, index) => {
    const text = boundedIdentifier(entry, `${label} ${index + 1}`);
    if (seen.has(text)) throw new RangeError(`${label} ${text} is duplicated`);
    seen.add(text);
    return text;
  });
  return deepFreeze(output.sort());
}

function normalizeOptionalStrings(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return uniqueTexts(value, label, maximum);
}

function requireVersion(value: unknown, label: string): void {
  if (value !== RUNNER_ADAPTER_V1) {
    throw new RangeError(`${label} version must be ${RUNNER_ADAPTER_V1}`);
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  return boundedPattern(value, label, identifierPattern, limits.identifier);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : boundedIdentifier(value, label);
}

function boundedPattern(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  const text = boundedText(value, label, maximum);
  if (!pattern.test(text)) throw new RangeError(`${label} has an invalid format`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || unsafeTextPattern.test(output)) {
    throw new RangeError(`${label} must contain from 1 to ${maximum} safe characters`);
  }
  if (credentialPattern.test(output)) {
    throw new RangeError(`${label} must not contain credential-shaped text`);
  }
  return output;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, label, maximum);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new RangeError(`${label} must be a valid timestamp`);
  const canonical = new Date(millis).toISOString();
  if (canonical !== value) throw new RangeError(`${label} must use canonical UTC milliseconds`);
  return canonical;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableGeneration(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}

function exactEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as Values[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
