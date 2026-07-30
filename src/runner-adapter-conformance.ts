import { createHash } from "node:crypto";
import {
  effectiveToolSurfaceClasses,
  reconcileEffectiveToolSurface,
  type EffectiveToolSurfaceReconciliation,
  type EffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceState,
} from "./effective-tool-surface.js";
import {
  RUNNER_ADAPTER_V1,
  assertRunnerObservationBinding,
  deduplicateRunnerObservationsV1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCapabilityProbeV1,
  type RunnerObservationType,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "./runner-adapter-v1.js";

export interface RunnerAdapterConformanceExpectationV1 {
  startCapabilityState: EffectiveToolSurfaceState;
  resumeCapabilityState: EffectiveToolSurfaceState;
  resumeDispatchDecision: EffectiveToolSurfaceReconciliation["dispatchDecision"];
}

export interface RunnerAdapterConformanceScenarioV1 {
  version: typeof RUNNER_ADAPTER_V1;
  scenarioId: string;
  suiteVersion: string;
  startCommand: RunnerStartCommandV1;
  startProbe: RunnerCapabilityProbeV1;
  resumeCommand: RunnerResumeCommandV1;
  resumeProbe: RunnerCapabilityProbeV1;
  expect: RunnerAdapterConformanceExpectationV1;
}

export interface RunnerAdapterConformanceStreamReportV1 {
  commandKind: "start" | "resume";
  observationCount: number;
  uniqueObservationCount: number;
  observationTypes: RunnerObservationType[];
  firstObservationId: string;
  lastObservationId: string;
  checkpointReferenceCount: number;
  artifactReferenceCount: number;
  replayIdempotent: true;
  conflictingReplayRejected: true;
  staleGenerationRejected: true;
  chronological: true;
}

export interface RunnerAdapterConformanceReportV1 {
  version: typeof RUNNER_ADAPTER_V1;
  scenarioId: string;
  suiteVersion: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  startSnapshotId: string;
  resumeSnapshotId: string;
  startCapabilityState: EffectiveToolSurfaceState;
  resumeCapabilityState: EffectiveToolSurfaceState;
  resumeDispatchDecision: EffectiveToolSurfaceReconciliation["dispatchDecision"];
  capabilitySurfaceChanged: boolean;
  start: RunnerAdapterConformanceStreamReportV1;
  resume: RunnerAdapterConformanceStreamReportV1;
  evidenceFingerprint: string;
  canonicalRunPreserved: true;
  durableTransitionsAppliedByAdapter: false;
  currentCapabilityObservationRequired: true;
  historicalCallsProveCurrentBinding: false;
  executionCertaintyImplemented: false;
  authoritativeSettlementImplemented: false;
  sideEffectsPerformed: false;
  passed: true;
}

const limits = {
  identifier: 160,
  version: 160,
  observations: 256,
} as const;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

export async function runRunnerAdapterConformanceV1(
  adapter: RunnerAdapterV1,
  rawScenario: RunnerAdapterConformanceScenarioV1,
): Promise<RunnerAdapterConformanceReportV1> {
  const scenario = normalizeScenario(rawScenario);
  const descriptor = parseRunnerAdapterDescriptorV1(adapter.describe());
  assertDescriptorCommandBinding(descriptor, scenario.startCommand);
  assertDescriptorCommandBinding(descriptor, scenario.resumeCommand);
  assertScenarioIdentity(scenario, descriptor);

  if (!descriptor.supports.resume) {
    throw new RangeError("Runner adapter conformance requires resume support");
  }
  if (!descriptor.supports.capabilityInspection) {
    throw new RangeError(
      "Runner adapter conformance requires capability inspection support",
    );
  }
  if (!descriptor.supports.streamingObservations) {
    throw new RangeError(
      "Runner adapter conformance requires streaming observation support",
    );
  }

  const startSnapshot = normalizeReturnedSnapshot(
    await adapter.inspectCapabilities(scenario.startProbe),
  );
  assertSnapshotBinding(startSnapshot, scenario.startProbe, descriptor);
  const startCapabilities = reconcileEffectiveToolSurface(startSnapshot);
  assertExpected(
    "start capability state",
    scenario.expect.startCapabilityState,
    startCapabilities.state,
  );

  const startRaw = await collectObservations(
    adapter.start(scenario.startCommand),
    "start",
  );
  const start = validateStream(
    descriptor,
    scenario.startCommand,
    startRaw,
    "start",
  );
  requireStartSequence(start.observations);

  const publishedCheckpoint = latestCheckpoint(start.observations);
  const requestedCheckpoint = parseRunnerExternalReferenceV1(
    await adapter.requestCheckpoint(checkpointCommand(scenario.startCommand)),
  );
  if (requestedCheckpoint.kind !== "checkpoint") {
    throw new RangeError("Runner adapter checkpoint request returned a non-checkpoint reference");
  }
  assertReferenceAdapter(requestedCheckpoint, descriptor);
  if (
    publishedCheckpoint !== null
    && referenceIdentity(publishedCheckpoint) !== referenceIdentity(requestedCheckpoint)
  ) {
    throw new RangeError(
      "Runner checkpoint request disagrees with the latest published checkpoint",
    );
  }
  if (
    scenario.resumeCommand.checkpointRef !== null
    && referenceIdentity(scenario.resumeCommand.checkpointRef)
      !== referenceIdentity(requestedCheckpoint)
  ) {
    throw new RangeError(
      "Runner resume command does not use the latest accepted checkpoint",
    );
  }

  const resumeSnapshot = normalizeReturnedSnapshot(
    await adapter.inspectCapabilities(scenario.resumeProbe),
  );
  assertSnapshotBinding(resumeSnapshot, scenario.resumeProbe, descriptor);
  if (resumeSnapshot.requiredFingerprint !== startSnapshot.requiredFingerprint) {
    throw new RangeError(
      "Runner conformance capability requirements changed between start and resume",
    );
  }
  const resumeCapabilities = reconcileEffectiveToolSurface(
    resumeSnapshot,
    startSnapshot,
  );
  assertExpected(
    "resume capability state",
    scenario.expect.resumeCapabilityState,
    resumeCapabilities.state,
  );
  assertExpected(
    "resume dispatch decision",
    scenario.expect.resumeDispatchDecision,
    resumeCapabilities.dispatchDecision,
  );

  const resumeRaw = await collectObservations(
    adapter.resume(scenario.resumeCommand),
    "resume",
  );
  const resume = validateStream(
    descriptor,
    scenario.resumeCommand,
    resumeRaw,
    "resume",
  );
  requireResumeSequence(resume.observations);

  const reportInput = {
    version: RUNNER_ADAPTER_V1,
    scenarioId: scenario.scenarioId,
    suiteVersion: scenario.suiteVersion,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    profileId: scenario.startCommand.profileId,
    profileVersion: scenario.startCommand.profileVersion,
    startSnapshotId: startSnapshot.snapshotId,
    resumeSnapshotId: resumeSnapshot.snapshotId,
    startCapabilityState: startCapabilities.state,
    resumeCapabilityState: resumeCapabilities.state,
    resumeDispatchDecision: resumeCapabilities.dispatchDecision,
    capabilitySurfaceChanged: resumeCapabilities.surfaceChanged,
    start: streamReport("start", start),
    resume: streamReport("resume", resume),
  };
  return deepFreeze({
    ...reportInput,
    evidenceFingerprint: sha256(JSON.stringify(reportInput)),
    canonicalRunPreserved: true,
    durableTransitionsAppliedByAdapter: false,
    currentCapabilityObservationRequired: true,
    historicalCallsProveCurrentBinding: false,
    executionCertaintyImplemented: false,
    authoritativeSettlementImplemented: false,
    sideEffectsPerformed: false,
    passed: true,
  });
}

interface ValidatedStream {
  observations: readonly RunnerObservationV1[];
  originalCount: number;
  conflictingReplayRejected: true;
  staleGenerationRejected: true;
}

async function collectObservations(
  stream: AsyncIterable<RunnerObservationV1>,
  label: string,
): Promise<RunnerObservationV1[]> {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new RangeError(`Runner ${label} did not return an async observation stream`);
  }
  const output: RunnerObservationV1[] = [];
  for await (const value of stream) {
    output.push(parseRunnerObservationV1(value));
    if (output.length > limits.observations) {
      throw new RangeError(
        `Runner ${label} stream exceeds ${limits.observations} observations`,
      );
    }
  }
  if (output.length === 0) {
    throw new RangeError(`Runner ${label} stream produced no observations`);
  }
  return output;
}

function validateStream(
  descriptor: RunnerAdapterDescriptorV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  raw: readonly RunnerObservationV1[],
  label: "start" | "resume",
): ValidatedStream {
  const bound = raw.map((observation) =>
    assertRunnerObservationBinding(descriptor, command, observation)
  );
  assertChronological(bound, label);
  const observations = deduplicateRunnerObservationsV1(bound);
  if (observations.length === 0) {
    throw new RangeError(`Runner ${label} stream has no unique observations`);
  }

  const replayed = deduplicateRunnerObservationsV1([
    ...observations,
    observations[0]!,
  ]);
  if (replayed.length !== observations.length) {
    throw new RangeError(`Runner ${label} identical replay was not idempotent`);
  }

  let conflictingReplayRejected = false;
  try {
    deduplicateRunnerObservationsV1([
      observations[0]!,
      {
        ...observations[0]!,
        correlationId: observations[0]!.correlationId === null
          ? "conflicting-replay"
          : `${observations[0]!.correlationId}.conflict`,
      },
    ]);
  } catch {
    conflictingReplayRejected = true;
  }
  if (!conflictingReplayRejected) {
    throw new RangeError(`Runner ${label} conflicting replay was accepted`);
  }

  let staleGenerationRejected = false;
  try {
    assertRunnerObservationBinding(descriptor, command, {
      ...observations[0]!,
      runGeneration: observations[0]!.runGeneration + 1,
    });
  } catch {
    staleGenerationRejected = true;
  }
  if (!staleGenerationRejected) {
    throw new RangeError(`Runner ${label} stale generation was accepted`);
  }

  return {
    observations,
    originalCount: raw.length,
    conflictingReplayRejected: true,
    staleGenerationRejected: true,
  };
}

function requireStartSequence(observations: readonly RunnerObservationV1[]): void {
  if (observations[0]?.type !== "start_accepted") {
    throw new RangeError("Runner start stream must begin with start_accepted");
  }
  requireOrderedTypes(observations, [
    "start_accepted",
    "execution_started",
    "checkpoint_published",
    "interrupted",
  ]);
  if (observations.at(-1)?.type !== "interrupted") {
    throw new RangeError("Runner start conformance stream must end with interrupted");
  }
  if (observations.some((entry) => entry.type === "completion_proposed")) {
    throw new RangeError(
      "Runner start conformance stream cannot complete before resume",
    );
  }
}

function requireResumeSequence(observations: readonly RunnerObservationV1[]): void {
  if (observations[0]?.type !== "resume_accepted") {
    throw new RangeError("Runner resume stream must begin with resume_accepted");
  }
  requireOrderedTypes(observations, [
    "resume_accepted",
    "execution_started",
    "heartbeat",
    "completion_proposed",
  ]);
  if (observations.at(-1)?.type !== "completion_proposed") {
    throw new RangeError(
      "Runner resume conformance stream must end with completion_proposed",
    );
  }
  if (
    observations.some((entry) =>
      entry.type === "failure_observed" || entry.type === "interrupted"
    )
  ) {
    throw new RangeError(
      "Runner resume conformance stream cannot fail after proposing completion",
    );
  }
}

function requireOrderedTypes(
  observations: readonly RunnerObservationV1[],
  required: readonly RunnerObservationType[],
): void {
  let cursor = -1;
  for (const type of required) {
    const index = observations.findIndex(
      (entry, candidateIndex) => candidateIndex > cursor && entry.type === type,
    );
    if (index < 0) {
      throw new RangeError(`Runner conformance stream is missing ordered ${type}`);
    }
    cursor = index;
  }
}

function streamReport(
  commandKind: "start" | "resume",
  stream: ValidatedStream,
): RunnerAdapterConformanceStreamReportV1 {
  const observations = stream.observations;
  return {
    commandKind,
    observationCount: stream.originalCount,
    uniqueObservationCount: observations.length,
    observationTypes: observations.map((entry) => entry.type),
    firstObservationId: observations[0]!.observationId,
    lastObservationId: observations.at(-1)!.observationId,
    checkpointReferenceCount: observations.filter((entry) =>
      entry.type === "checkpoint_published"
      || (entry.type === "heartbeat" && entry.checkpointRef !== null)
      || (entry.type === "interrupted" && entry.checkpointRef !== null)
    ).length,
    artifactReferenceCount: observations.filter((entry) =>
      entry.type === "artifact_published"
    ).length,
    replayIdempotent: true,
    conflictingReplayRejected: stream.conflictingReplayRejected,
    staleGenerationRejected: stream.staleGenerationRejected,
    chronological: true,
  };
}

function normalizeScenario(
  value: RunnerAdapterConformanceScenarioV1,
): RunnerAdapterConformanceScenarioV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Runner adapter conformance scenario must be an object");
  }
  if (value.version !== RUNNER_ADAPTER_V1) {
    throw new RangeError(`Runner adapter conformance version must be ${RUNNER_ADAPTER_V1}`);
  }
  const startCommand = parseRunnerStartCommandV1(value.startCommand);
  const resumeCommand = parseRunnerResumeCommandV1(value.resumeCommand);
  const startProbe = parseRunnerCapabilityProbeV1(value.startProbe);
  const resumeProbe = parseRunnerCapabilityProbeV1(value.resumeProbe);
  const expect = normalizeExpectation(value.expect);
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    scenarioId: boundedIdentifier(value.scenarioId, "Runner conformance scenario ID"),
    suiteVersion: boundedText(
      value.suiteVersion,
      "Runner conformance suite version",
      limits.version,
    ),
    startCommand,
    startProbe,
    resumeCommand,
    resumeProbe,
    expect,
  });
}

function normalizeExpectation(
  value: RunnerAdapterConformanceExpectationV1,
): RunnerAdapterConformanceExpectationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Runner conformance expectation must be an object");
  }
  const states: readonly EffectiveToolSurfaceState[] = [
    "healthy",
    "changed",
    "degraded",
    "recovered",
  ];
  const decisions: readonly EffectiveToolSurfaceReconciliation["dispatchDecision"][] = [
    "allow",
    "block_or_reroute",
  ];
  if (!states.includes(value.startCapabilityState)) {
    throw new RangeError("Runner conformance start capability state is invalid");
  }
  if (!states.includes(value.resumeCapabilityState)) {
    throw new RangeError("Runner conformance resume capability state is invalid");
  }
  if (!decisions.includes(value.resumeDispatchDecision)) {
    throw new RangeError("Runner conformance resume dispatch decision is invalid");
  }
  return {
    startCapabilityState: value.startCapabilityState,
    resumeCapabilityState: value.resumeCapabilityState,
    resumeDispatchDecision: value.resumeDispatchDecision,
  };
}

function assertScenarioIdentity(
  scenario: RunnerAdapterConformanceScenarioV1,
  descriptor: RunnerAdapterDescriptorV1,
): void {
  const start = scenario.startCommand;
  const resume = scenario.resumeCommand;
  if (
    resume.adapterId !== start.adapterId
    || resume.adapterVersion !== start.adapterVersion
    || resume.profileId !== start.profileId
    || resume.profileVersion !== start.profileVersion
    || resume.runId !== start.runId
    || resume.itemId !== start.itemId
    || resume.project !== start.project
    || resume.correlationId !== start.correlationId
  ) {
    throw new RangeError("Runner conformance start and resume identity changed");
  }
  if (resume.runGeneration < start.runGeneration) {
    throw new RangeError("Runner conformance run generation moved backwards");
  }
  if (
    scenario.startProbe.transition !== "new"
    || scenario.resumeProbe.transition !== "resume"
  ) {
    throw new RangeError(
      "Runner conformance probes must use new then resume transitions",
    );
  }
  assertProbeCommandBinding(scenario.startProbe, start, descriptor);
  assertProbeCommandBinding(scenario.resumeProbe, resume, descriptor);
}

function assertDescriptorCommandBinding(
  descriptor: RunnerAdapterDescriptorV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): void {
  if (
    command.adapterId !== descriptor.adapterId
    || command.adapterVersion !== descriptor.adapterVersion
  ) {
    throw new RangeError("Runner conformance command does not match adapter descriptor");
  }
  const profile = descriptor.profiles.find((entry) => entry.id === command.profileId);
  if (!profile || profile.version !== command.profileVersion) {
    throw new RangeError("Runner conformance profile is absent from descriptor");
  }
}

function assertProbeCommandBinding(
  probe: RunnerCapabilityProbeV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  descriptor: RunnerAdapterDescriptorV1,
): void {
  if (
    probe.adapterId !== descriptor.adapterId
    || probe.adapterVersion !== descriptor.adapterVersion
    || probe.profileId !== command.profileId
    || probe.runId !== command.runId
    || probe.runGeneration !== command.runGeneration
  ) {
    throw new RangeError("Runner capability probe does not match its command");
  }
}

function assertSnapshotBinding(
  snapshot: EffectiveToolSurfaceSnapshot,
  probe: RunnerCapabilityProbeV1,
  descriptor: RunnerAdapterDescriptorV1,
): void {
  if (
    snapshot.snapshotId !== probe.probeId
    || snapshot.runnerAdapter !== descriptor.adapterId
    || snapshot.runnerVersion !== descriptor.adapterVersion
    || snapshot.runId !== probe.runId
    || snapshot.runGeneration !== probe.runGeneration
    || snapshot.transition !== probe.transition
    || snapshot.transport !== probe.transport
    || snapshot.observedAt !== probe.observedAt
  ) {
    throw new RangeError("Runner capability snapshot does not match probe");
  }
}

function normalizeReturnedSnapshot(
  snapshot: EffectiveToolSurfaceSnapshot,
): EffectiveToolSurfaceSnapshot {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new RangeError("Runner capability inspection returned an invalid snapshot");
  }
  const classes = Object.fromEntries(effectiveToolSurfaceClasses.map((className) => {
    const entry = snapshot.classes[className];
    return [className, {
      catalogue: entry.catalogueCapabilities.map((capability) => ({
        id: capability.id,
        ...(capability.name === null ? {} : { name: capability.name }),
      })),
      executable: entry.executableCapabilities.map((capability) => ({
        id: capability.id,
        ...(capability.name === null ? {} : { name: capability.name }),
      })),
      provenance: entry.provenance,
    }];
  }));
  const normalized = buildSnapshot({
    snapshotId: snapshot.snapshotId,
    runnerAdapter: snapshot.runnerAdapter,
    runnerVersion: snapshot.runnerVersion,
    clientProduct: snapshot.clientProduct,
    clientBuild: snapshot.clientBuild,
    modelProfile: snapshot.modelProfile,
    externalSurfaceRef: snapshot.externalSurfaceRef,
    runId: snapshot.runId,
    runGeneration: snapshot.runGeneration,
    transport: snapshot.transport,
    transition: snapshot.transition,
    classes,
    requiredCapabilities: snapshot.requiredCapabilities,
    recoveryActions: snapshot.recoveryActions,
    observedAt: snapshot.observedAt,
    traceId: snapshot.traceId,
  });
  if (normalized.snapshotFingerprint !== snapshot.snapshotFingerprint) {
    throw new RangeError("Runner capability snapshot fingerprint is inconsistent");
  }
  return normalized;
}

function buildSnapshot(input: {
  snapshotId: string;
  runnerAdapter: string;
  runnerVersion: string;
  clientProduct: string;
  clientBuild: string | null;
  modelProfile: string | null;
  externalSurfaceRef: string | null;
  runId: string;
  runGeneration: number;
  transport: string;
  transition: EffectiveToolSurfaceSnapshot["transition"];
  classes: Record<string, unknown>;
  requiredCapabilities: EffectiveToolSurfaceSnapshot["requiredCapabilities"];
  recoveryActions: EffectiveToolSurfaceSnapshot["recoveryActions"];
  observedAt: string;
  traceId: string | null;
}): EffectiveToolSurfaceSnapshot {
  const { buildEffectiveToolSurfaceSnapshot } = requireEffectiveToolSurfaceBuilder();
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: input.snapshotId,
    runnerAdapter: input.runnerAdapter,
    runnerVersion: input.runnerVersion,
    clientProduct: input.clientProduct,
    ...(input.clientBuild === null ? {} : { clientBuild: input.clientBuild }),
    ...(input.modelProfile === null ? {} : { modelProfile: input.modelProfile }),
    ...(input.externalSurfaceRef === null
      ? {}
      : { externalSurfaceRef: input.externalSurfaceRef }),
    runId: input.runId,
    runGeneration: input.runGeneration,
    transport: input.transport,
    transition: input.transition,
    classes: input.classes,
    requiredCapabilities: input.requiredCapabilities,
    recoveryActions: input.recoveryActions,
    observedAt: input.observedAt,
    ...(input.traceId === null ? {} : { traceId: input.traceId }),
  });
}

function requireEffectiveToolSurfaceBuilder(): {
  buildEffectiveToolSurfaceSnapshot: typeof import("./effective-tool-surface.js")["buildEffectiveToolSurfaceSnapshot"];
} {
  // Kept as a local typed seam so the conformance module remains pure and easy to fake.
  return { buildEffectiveToolSurfaceSnapshot: importedBuildEffectiveToolSurfaceSnapshot };
}

import {
  buildEffectiveToolSurfaceSnapshot as importedBuildEffectiveToolSurfaceSnapshot,
} from "./effective-tool-surface.js";

function latestCheckpoint(
  observations: readonly RunnerObservationV1[],
): ReturnType<typeof parseRunnerExternalReferenceV1> | null {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (observation.type === "checkpoint_published") return observation.reference;
    if (observation.type === "heartbeat" && observation.checkpointRef !== null) {
      return observation.checkpointRef;
    }
    if (observation.type === "interrupted" && observation.checkpointRef !== null) {
      return observation.checkpointRef;
    }
  }
  return null;
}

function checkpointCommand(command: RunnerStartCommandV1) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: `${command.commandId}.checkpoint`,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    authority: command.authority,
    requestedAt: command.issuedAt,
  } as const;
}

function assertReferenceAdapter(
  reference: ReturnType<typeof parseRunnerExternalReferenceV1>,
  descriptor: RunnerAdapterDescriptorV1,
): void {
  if (reference.adapterId !== descriptor.adapterId) {
    throw new RangeError("Runner external reference adapter does not match descriptor");
  }
}

function referenceIdentity(
  reference: ReturnType<typeof parseRunnerExternalReferenceV1>,
): string {
  return JSON.stringify({
    kind: reference.kind,
    adapterId: reference.adapterId,
    externalId: reference.externalId,
    digest: reference.digest,
    uri: reference.uri,
    generation: reference.generation,
  });
}

function assertChronological(
  observations: readonly RunnerObservationV1[],
  label: string,
): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const current = Date.parse(observation.observedAt);
    if (current < previous) {
      throw new RangeError(`Runner ${label} observations moved backwards in time`);
    }
    previous = current;
  }
}

function assertExpected(label: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new RangeError(`Runner conformance ${label} expected ${expected}, received ${actual}`);
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  const text = boundedText(value, label, limits.identifier);
  if (!identifierPattern.test(text)) throw new RangeError(`${label} has an invalid format`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > maximum || unsafeTextPattern.test(text)) {
    throw new RangeError(`${label} must contain from 1 to ${maximum} safe characters`);
  }
  return text;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
