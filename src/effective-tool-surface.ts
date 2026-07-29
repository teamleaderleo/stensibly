import { createHash } from "node:crypto";

export const effectiveToolSurfaceClasses = [
  "native_core",
  "host_dynamic",
  "app_connector",
  "configured_mcp",
  "discovery",
] as const;

export type EffectiveToolSurfaceClass = typeof effectiveToolSurfaceClasses[number];

export const effectiveToolSurfaceTransitions = [
  "new",
  "resume",
  "fork",
  "compact",
  "reconnect",
  "refresh",
  "restart",
] as const;

export type EffectiveToolSurfaceTransition = typeof effectiveToolSurfaceTransitions[number];

export const toolSurfaceRecoveryActions = [
  "refresh_catalogue",
  "resume_with_current_tools",
  "fork_with_current_tools",
  "reconnect",
  "restart",
  "move_continuation_to_fresh_surface",
] as const;

export type ToolSurfaceRecoveryAction = typeof toolSurfaceRecoveryActions[number];

export interface ToolSurfaceCapabilityInput {
  id: string;
  name?: string;
}

export interface ToolSurfaceClassInput {
  catalogue?: readonly ToolSurfaceCapabilityInput[];
  executable: readonly ToolSurfaceCapabilityInput[];
  provenance?: readonly string[];
}

export interface ToolSurfaceCapabilityRequirementInput {
  class: EffectiveToolSurfaceClass;
  id: string;
}

export interface EffectiveToolSurfaceSnapshotInput {
  snapshotId: string;
  runnerAdapter: string;
  runnerVersion: string;
  clientProduct: string;
  clientBuild?: string;
  modelProfile?: string;
  externalSurfaceRef?: string;
  runId: string;
  runGeneration: number;
  transport: string;
  transition: EffectiveToolSurfaceTransition;
  classes: Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
  requiredCapabilities?: readonly ToolSurfaceCapabilityRequirementInput[];
  recoveryActions?: readonly ToolSurfaceRecoveryAction[];
  observedAt: string;
  traceId?: string;
}

export interface ToolSurfaceCapability {
  id: string;
  name: string | null;
}

export interface ToolSurfaceClassSnapshot {
  class: EffectiveToolSurfaceClass;
  catalogueCount: number;
  catalogueDigest: string;
  executableCount: number;
  executableDigest: string;
  catalogueCapabilities: ToolSurfaceCapability[];
  executableCapabilities: ToolSurfaceCapability[];
  catalogueOnlyCapabilityIds: string[];
  provenance: string[];
}

export interface ToolSurfaceCapabilityRef {
  class: EffectiveToolSurfaceClass;
  id: string;
}

export interface EffectiveToolSurfaceSnapshot {
  version: 1;
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
  transition: EffectiveToolSurfaceTransition;
  classes: Record<EffectiveToolSurfaceClass, ToolSurfaceClassSnapshot>;
  requiredCapabilities: ToolSurfaceCapabilityRef[];
  observedRequiredCapabilities: ToolSurfaceCapabilityRef[];
  missingRequiredCapabilities: ToolSurfaceCapabilityRef[];
  catalogueOnlyRequiredCapabilities: ToolSurfaceCapabilityRef[];
  recoveryActions: ToolSurfaceRecoveryAction[];
  observedAt: string;
  traceId: string | null;
  surfaceFingerprint: string;
  requiredFingerprint: string;
  snapshotFingerprint: string;
  currentExecutableBindingObserved: true;
  historicalCallsProveCurrentBinding: false;
}

export type EffectiveToolSurfaceState = "healthy" | "changed" | "degraded" | "recovered";

export interface EffectiveToolSurfaceReconciliation {
  version: 1;
  state: EffectiveToolSurfaceState;
  currentSnapshotId: string;
  previousSnapshotId: string | null;
  surfaceChanged: boolean;
  missingSincePrevious: ToolSurfaceCapabilityRef[];
  addedSincePrevious: ToolSurfaceCapabilityRef[];
  missingRequiredCapabilities: ToolSurfaceCapabilityRef[];
  catalogueOnlyRequiredCapabilities: ToolSurfaceCapabilityRef[];
  degradedClasses: EffectiveToolSurfaceClass[];
  dispatchDecision: "allow" | "block_or_reroute";
  consequentialCallsAllowed: boolean;
  recommendedRecoveryAction: ToolSurfaceRecoveryAction | null;
  historicalCallsProveCurrentBinding: false;
}

const limits = {
  identifier: 160,
  text: 512,
  provenance: 240,
  provenanceEntries: 16,
  capabilitiesPerClass: 1_000,
  requiredCapabilities: 1_000,
  recoveryActions: toolSurfaceRecoveryActions.length,
} as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

export function buildEffectiveToolSurfaceSnapshot(
  input: EffectiveToolSurfaceSnapshotInput,
): EffectiveToolSurfaceSnapshot {
  if (!isRecord(input)) throw new RangeError("Effective tool-surface snapshot must be an object");

  const snapshotId = boundedIdentifier(input.snapshotId, "Snapshot ID");
  const runnerAdapter = boundedIdentifier(input.runnerAdapter, "Runner adapter");
  const runnerVersion = boundedText(input.runnerVersion, "Runner version", limits.identifier);
  const clientProduct = boundedText(input.clientProduct, "Client product", limits.identifier);
  const clientBuild = nullableText(input.clientBuild, "Client build", limits.identifier);
  const modelProfile = nullableText(input.modelProfile, "Model profile", limits.identifier);
  const externalSurfaceRef = nullableText(
    input.externalSurfaceRef,
    "External surface reference",
    limits.text,
  );
  const runId = boundedIdentifier(input.runId, "Run ID");
  const runGeneration = nonNegativeInteger(input.runGeneration, "Run generation");
  const transport = boundedIdentifier(input.transport, "Transport");
  const transition = exactEnum(
    input.transition,
    effectiveToolSurfaceTransitions,
    "Tool-surface transition",
  );
  const observedAt = exactTimestamp(input.observedAt, "Observed at");
  const traceId = nullableText(input.traceId, "Trace ID", limits.identifier);
  const recoveryActions = uniqueEnums(
    input.recoveryActions ?? [],
    toolSurfaceRecoveryActions,
    "Recovery action",
    limits.recoveryActions,
  );

  if (!isRecord(input.classes)) throw new RangeError("Tool-surface classes must be an object");
  const classes = {} as Record<EffectiveToolSurfaceClass, ToolSurfaceClassSnapshot>;
  for (const className of effectiveToolSurfaceClasses) {
    classes[className] = buildClassSnapshot(className, input.classes[className]);
  }

  const requiredCapabilities = normalizeRequirements(input.requiredCapabilities ?? []);
  const observedRequiredCapabilities: ToolSurfaceCapabilityRef[] = [];
  const missingRequiredCapabilities: ToolSurfaceCapabilityRef[] = [];
  const catalogueOnlyRequiredCapabilities: ToolSurfaceCapabilityRef[] = [];

  for (const requirement of requiredCapabilities) {
    const classSnapshot = classes[requirement.class];
    const executable = new Set(classSnapshot.executableCapabilities.map((entry) => entry.id));
    if (executable.has(requirement.id)) {
      observedRequiredCapabilities.push(requirement);
      continue;
    }
    missingRequiredCapabilities.push(requirement);
    if (classSnapshot.catalogueCapabilities.some((entry) => entry.id === requirement.id)) {
      catalogueOnlyRequiredCapabilities.push(requirement);
    }
  }

  const surfaceFingerprint = sha256(stableJson(effectiveToolSurfaceClasses.map((className) => ({
    class: className,
    catalogueDigest: classes[className].catalogueDigest,
    executableDigest: classes[className].executableDigest,
  }))));
  const requiredFingerprint = sha256(stableJson(requiredCapabilities));
  const snapshotFingerprint = sha256(stableJson({
    version: 1,
    snapshotId,
    runnerAdapter,
    runnerVersion,
    clientProduct,
    clientBuild,
    modelProfile,
    externalSurfaceRef,
    runId,
    runGeneration,
    transport,
    transition,
    surfaceFingerprint,
    requiredFingerprint,
    recoveryActions,
    observedAt,
    traceId,
  }));

  return {
    version: 1,
    snapshotId,
    runnerAdapter,
    runnerVersion,
    clientProduct,
    clientBuild,
    modelProfile,
    externalSurfaceRef,
    runId,
    runGeneration,
    transport,
    transition,
    classes,
    requiredCapabilities,
    observedRequiredCapabilities,
    missingRequiredCapabilities,
    catalogueOnlyRequiredCapabilities,
    recoveryActions,
    observedAt,
    traceId,
    surfaceFingerprint,
    requiredFingerprint,
    snapshotFingerprint,
    currentExecutableBindingObserved: true,
    historicalCallsProveCurrentBinding: false,
  };
}

export function reconcileEffectiveToolSurface(
  current: EffectiveToolSurfaceSnapshot,
  previous?: EffectiveToolSurfaceSnapshot,
): EffectiveToolSurfaceReconciliation {
  const currentExecutable = executableCapabilityKeys(current);
  const previousExecutable = previous ? executableCapabilityKeys(previous) : new Set<string>();
  const missingSincePrevious = previous
    ? refsFromKeys([...previousExecutable].filter((key) => !currentExecutable.has(key)))
    : [];
  const addedSincePrevious = previous
    ? refsFromKeys([...currentExecutable].filter((key) => !previousExecutable.has(key)))
    : [];
  const missingRequiredCapabilities = [...current.missingRequiredCapabilities];
  const catalogueOnlyRequiredCapabilities = [...current.catalogueOnlyRequiredCapabilities];
  const degradedClasses = effectiveToolSurfaceClasses.filter((className) =>
    missingRequiredCapabilities.some((entry) => entry.class === className)
  );
  const previousMissingRequired = previous
    ? current.requiredCapabilities.filter((requirement) => !previousExecutable.has(refKey(requirement)))
    : [];
  const surfaceChanged = previous !== undefined
    && previous.surfaceFingerprint !== current.surfaceFingerprint;

  let state: EffectiveToolSurfaceState;
  if (missingRequiredCapabilities.length > 0) state = "degraded";
  else if (previous && previousMissingRequired.length > 0) state = "recovered";
  else if (surfaceChanged) state = "changed";
  else state = "healthy";

  const consequentialCallsAllowed = missingRequiredCapabilities.length === 0;
  return {
    version: 1,
    state,
    currentSnapshotId: current.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    surfaceChanged,
    missingSincePrevious,
    addedSincePrevious,
    missingRequiredCapabilities,
    catalogueOnlyRequiredCapabilities,
    degradedClasses,
    dispatchDecision: consequentialCallsAllowed ? "allow" : "block_or_reroute",
    consequentialCallsAllowed,
    recommendedRecoveryAction: consequentialCallsAllowed
      ? null
      : current.recoveryActions[0] ?? null,
    historicalCallsProveCurrentBinding: false,
  };
}

function buildClassSnapshot(
  className: EffectiveToolSurfaceClass,
  input: ToolSurfaceClassInput | undefined,
): ToolSurfaceClassSnapshot {
  const executableCapabilities = normalizeCapabilities(
    input?.executable ?? [],
    `${className} executable capability`,
  );
  const catalogueCapabilities = normalizeCapabilities(
    input?.catalogue ?? input?.executable ?? [],
    `${className} catalogue capability`,
  );
  const catalogueById = new Map(catalogueCapabilities.map((entry) => [entry.id, entry]));
  for (const executable of executableCapabilities) {
    const catalogued = catalogueById.get(executable.id);
    if (!catalogued) {
      throw new RangeError(
        `${className} executable capability ${executable.id} is absent from its catalogue`,
      );
    }
    if (executable.name !== null && catalogued.name !== null && executable.name !== catalogued.name) {
      throw new RangeError(`${className} capability ${executable.id} has conflicting names`);
    }
  }

  const executableIds = new Set(executableCapabilities.map((entry) => entry.id));
  const catalogueOnlyCapabilityIds = catalogueCapabilities
    .map((entry) => entry.id)
    .filter((id) => !executableIds.has(id));
  const provenance = uniqueTexts(
    input?.provenance ?? [],
    `${className} provenance`,
    limits.provenance,
    limits.provenanceEntries,
  );

  return {
    class: className,
    catalogueCount: catalogueCapabilities.length,
    catalogueDigest: capabilityDigest(catalogueCapabilities),
    executableCount: executableCapabilities.length,
    executableDigest: capabilityDigest(executableCapabilities),
    catalogueCapabilities,
    executableCapabilities,
    catalogueOnlyCapabilityIds,
    provenance,
  };
}

function normalizeCapabilities(
  input: readonly ToolSurfaceCapabilityInput[],
  label: string,
): ToolSurfaceCapability[] {
  if (!Array.isArray(input)) throw new RangeError(`${label} list must be an array`);
  if (input.length > limits.capabilitiesPerClass) {
    throw new RangeError(`${label} list exceeds ${limits.capabilitiesPerClass} entries`);
  }

  const seen = new Set<string>();
  const normalized = input.map((entry, index) => {
    if (!isRecord(entry)) throw new RangeError(`${label} ${index + 1} must be an object`);
    const id = boundedIdentifier(entry.id, `${label} ID`);
    if (seen.has(id)) throw new RangeError(`${label} ID ${id} is duplicated`);
    seen.add(id);
    return {
      id,
      name: nullableText(entry.name, `${label} name`, limits.text),
    };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRequirements(
  input: readonly ToolSurfaceCapabilityRequirementInput[],
): ToolSurfaceCapabilityRef[] {
  if (!Array.isArray(input)) throw new RangeError("Required capabilities must be an array");
  if (input.length > limits.requiredCapabilities) {
    throw new RangeError(`Required capabilities exceed ${limits.requiredCapabilities} entries`);
  }

  const seen = new Set<string>();
  const normalized = input.map((entry, index) => {
    if (!isRecord(entry)) throw new RangeError(`Required capability ${index + 1} must be an object`);
    const className = exactEnum(entry.class, effectiveToolSurfaceClasses, "Required capability class");
    const id = boundedIdentifier(entry.id, "Required capability ID");
    const key = `${className}\u0000${id}`;
    if (seen.has(key)) throw new RangeError(`Required capability ${className}:${id} is duplicated`);
    seen.add(key);
    return { class: className, id };
  });
  return normalized.sort(compareRefs);
}

function executableCapabilityKeys(snapshot: EffectiveToolSurfaceSnapshot): Set<string> {
  const keys = new Set<string>();
  for (const className of effectiveToolSurfaceClasses) {
    for (const capability of snapshot.classes[className].executableCapabilities) {
      keys.add(refKey({ class: className, id: capability.id }));
    }
  }
  return keys;
}

function refsFromKeys(keys: string[]): ToolSurfaceCapabilityRef[] {
  return keys.map((key) => {
    const separator = key.indexOf("\u0000");
    if (separator < 1) throw new Error("Invalid internal capability reference");
    return {
      class: key.slice(0, separator) as EffectiveToolSurfaceClass,
      id: key.slice(separator + 1),
    };
  }).sort(compareRefs);
}

function compareRefs(left: ToolSurfaceCapabilityRef, right: ToolSurfaceCapabilityRef): number {
  const classDifference = effectiveToolSurfaceClasses.indexOf(left.class)
    - effectiveToolSurfaceClasses.indexOf(right.class);
  return classDifference || left.id.localeCompare(right.id);
}

function refKey(ref: ToolSurfaceCapabilityRef): string {
  return `${ref.class}\u0000${ref.id}`;
}

function capabilityDigest(capabilities: readonly ToolSurfaceCapability[]): string {
  return sha256(stableJson(capabilities.map((entry) => entry.id)));
}

function boundedIdentifier(value: unknown, label: string): string {
  const normalized = boundedText(value, label, limits.identifier);
  if (!identifierPattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === undefined ? null : boundedText(value, label, maximum);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
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

function uniqueEnums<const Values extends readonly string[]>(
  input: readonly unknown[],
  values: Values,
  label: string,
  maximum: number,
): Values[number][] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new RangeError(`${label} list is invalid`);
  }
  const seen = new Set<string>();
  return input.map((entry) => {
    const value = exactEnum(entry, values, label);
    if (seen.has(value)) throw new RangeError(`${label} ${value} is duplicated`);
    seen.add(value);
    return value;
  });
}

function uniqueTexts(
  input: readonly unknown[],
  label: string,
  entryMaximum: number,
  listMaximum: number,
): string[] {
  if (!Array.isArray(input) || input.length > listMaximum) {
    throw new RangeError(`${label} list is invalid`);
  }
  const seen = new Set<string>();
  const normalized = input.map((entry) => {
    const value = boundedText(entry, label, entryMaximum);
    if (seen.has(value)) throw new RangeError(`${label} ${value} is duplicated`);
    seen.add(value);
    return value;
  });
  return normalized.sort((left, right) => left.localeCompare(right));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
