import { sha256, stableJson } from "./canonical-json.js";
import {
  type EffectiveToolSurfaceClass,
  type EffectiveToolSurfaceSnapshot,
  type ToolSurfaceClassInput,
} from "./effective-tool-surface.js";
import {
  buildRunnerCapabilitySnapshotV1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerCapabilityProbeV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "./runner-adapter-v1.js";

const admittedInspections = new WeakSet<object>();
const inspectionCommandFingerprints = new WeakMap<object, string>();
const admittedBindings = new WeakSet<object>();

export interface RunnerCapabilityInspectionV1 {
  readonly version: 1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly probeId: string;
  readonly transport: string;
  readonly transition: "new" | "resume";
  readonly runId: string;
  readonly runGeneration: number;
  readonly requiredFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly observedAt: string;
  readonly snapshot: EffectiveToolSurfaceSnapshot;
}

export interface RunnerCapabilityCommandBindingV1 {
  readonly version: 1;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly issuedAt: string;
  readonly inspection: RunnerCapabilityInspectionV1;
}

export function buildRunnerCapabilityInspectionV1(
  descriptorValue: RunnerAdapterDescriptorV1,
  probeValue: RunnerCapabilityProbeV1,
  classes: Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>,
): RunnerCapabilityInspectionV1 {
  const descriptor = parseRunnerAdapterDescriptorV1(descriptorValue);
  const probe = parseRunnerCapabilityProbeV1(probeValue);
  const profile = assertDescriptorProbeBinding(descriptor, probe);
  const snapshot = buildRunnerCapabilitySnapshotV1(probe, classes);
  const inspection = deepFreeze({
    version: 1 as const,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    profileId: profile.id,
    profileVersion: profile.version,
    probeId: probe.probeId,
    transport: probe.transport,
    transition: probe.transition as "new" | "resume",
    runId: probe.runId,
    runGeneration: probe.runGeneration,
    requiredFingerprint: snapshot.requiredFingerprint,
    snapshotFingerprint: snapshot.snapshotFingerprint,
    observedAt: probe.observedAt,
    snapshot,
  });
  admittedInspections.add(inspection);
  return inspection;
}

export function bindRunnerCapabilityInspectionToCommandV1(
  inspection: RunnerCapabilityInspectionV1,
  value: RunnerStartCommandV1 | RunnerResumeCommandV1,
): RunnerCapabilityCommandBindingV1 {
  requireAdmittedInspection(inspection);
  const command = parseCommand(value);
  assertInspectionCommandBinding(inspection, command);
  const fingerprint = commandFingerprint(command);
  const existing = inspectionCommandFingerprints.get(inspection);
  if (existing !== undefined && existing !== fingerprint) {
    throw new RangeError(
      "Runner capability inspection is already bound to a different command",
    );
  }
  inspectionCommandFingerprints.set(inspection, fingerprint);

  const binding = deepFreeze({
    version: 1 as const,
    commandId: command.commandId,
    commandFingerprint: fingerprint,
    issuedAt: command.issuedAt,
    inspection,
  });
  admittedBindings.add(binding);
  return binding;
}

export function requireRunnerCapabilityInspectionForCommandV1(
  binding: RunnerCapabilityCommandBindingV1,
  value: RunnerStartCommandV1,
): EffectiveToolSurfaceSnapshot;
export function requireRunnerCapabilityInspectionForCommandV1(
  binding: RunnerCapabilityCommandBindingV1,
  value: RunnerResumeCommandV1,
): EffectiveToolSurfaceSnapshot;
export function requireRunnerCapabilityInspectionForCommandV1(
  binding: RunnerCapabilityCommandBindingV1,
  value: RunnerStartCommandV1 | RunnerResumeCommandV1,
): EffectiveToolSurfaceSnapshot {
  if (!admittedBindings.has(binding)) {
    throw new RangeError(
      "Runner capability command binding must come from current runtime admission",
    );
  }
  requireAdmittedInspection(binding.inspection);
  const command = parseCommand(value);
  const fingerprint = commandFingerprint(command);
  if (
    binding.commandId !== command.commandId
    || binding.commandFingerprint !== fingerprint
    || inspectionCommandFingerprints.get(binding.inspection) !== fingerprint
  ) {
    throw new RangeError("Runner capability inspection command binding is stale");
  }
  if (
    binding.inspection.requiredFingerprint
      !== binding.inspection.snapshot.requiredFingerprint
    || binding.inspection.snapshotFingerprint
      !== binding.inspection.snapshot.snapshotFingerprint
  ) {
    throw new RangeError("Runner capability inspection fingerprint binding is invalid");
  }

  return binding.inspection.snapshot;
}

function assertDescriptorProbeBinding(
  descriptor: RunnerAdapterDescriptorV1,
  probe: RunnerCapabilityProbeV1,
): RunnerAdapterDescriptorV1["profiles"][number] {
  if (
    descriptor.adapterId !== probe.adapterId
    || descriptor.adapterVersion !== probe.adapterVersion
  ) {
    throw new RangeError("Runner capability probe adapter binding is invalid");
  }
  if (!descriptor.supports.capabilityInspection) {
    throw new RangeError("Runner adapter does not support capability inspection");
  }
  if (!descriptor.transports.includes(probe.transport)) {
    throw new RangeError("Runner capability probe transport is unsupported");
  }
  if (probe.transition !== "new" && probe.transition !== "resume") {
    throw new RangeError(
      "Runner command capability inspection supports only new and resume transitions",
    );
  }
  if (probe.transition === "resume" && !descriptor.supports.resume) {
    throw new RangeError(
      "Runner adapter does not support resume capability inspection",
    );
  }
  const profile = descriptor.profiles.find((entry) => entry.id === probe.profileId);
  if (!profile) {
    throw new RangeError("Runner capability probe profile is unsupported");
  }
  return profile;
}

function assertInspectionCommandBinding(
  inspection: RunnerCapabilityInspectionV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): void {
  const expectedTransition = command.kind === "start" ? "new" : "resume";
  if (inspection.transition !== expectedTransition) {
    throw new RangeError("Runner capability inspection transition does not match command");
  }
  if (
    command.adapterId !== inspection.adapterId
    || command.adapterVersion !== inspection.adapterVersion
  ) {
    throw new RangeError("Runner capability command adapter binding is invalid");
  }
  if (
    command.profileId !== inspection.profileId
    || command.profileVersion !== inspection.profileVersion
  ) {
    throw new RangeError("Runner capability command profile binding is invalid");
  }
  if (
    command.runId !== inspection.runId
    || command.runGeneration !== inspection.runGeneration
  ) {
    throw new RangeError("Runner capability command run binding is invalid");
  }
  if (!sameRequirements(
    inspection.snapshot.requiredCapabilities,
    command.requiredCapabilities,
  )) {
    throw new RangeError(
      "Runner capability inspection required capabilities do not match command",
    );
  }
  if (Date.parse(inspection.observedAt) < Date.parse(command.issuedAt)) {
    throw new RangeError("Runner capability inspection predates command issuance");
  }
}

function requireAdmittedInspection(
  inspection: RunnerCapabilityInspectionV1,
): void {
  if (!admittedInspections.has(inspection)) {
    throw new RangeError(
      "Runner capability inspection must come from current runtime admission",
    );
  }
}

function parseCommand(
  value: RunnerStartCommandV1 | RunnerResumeCommandV1,
): RunnerStartCommandV1 | RunnerResumeCommandV1 {
  const kind = commandKindWithoutAccessors(value);
  return kind === "start"
    ? parseRunnerStartCommandV1(value)
    : parseRunnerResumeCommandV1(value);
}

function commandKindWithoutAccessors(value: unknown): "start" | "resume" {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Runner capability command must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError("Runner capability command must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError("Runner capability command contains symbol decoration");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError("Runner capability command must contain enumerable data properties");
    }
  }
  const kind = descriptors.kind?.value;
  if (kind !== "start" && kind !== "resume") {
    throw new RangeError("Runner capability command kind is invalid");
  }
  return kind;
}

function commandFingerprint(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): string {
  return sha256(stableJson(command));
}

function sameRequirements(
  left: readonly { class: string; id: string }[],
  right: readonly { class: string; id: string }[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(requirementKey));
  return rightKeys.size === right.length
    && left.every((entry) => rightKeys.has(requirementKey(entry)));
}

function requirementKey(entry: { class: string; id: string }): string {
  return `${entry.class}\u0000${entry.id}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
