import { sha256, stableJson } from "./canonical-json.js";
import {
  assertCanonicalJsonByteBudget,
  boundedIdentity,
  boundedInteger,
  boundedText,
  canonicalTimestamp,
  compareCodeUnits,
  denseDataArray,
  enumValue,
  lowercaseSlug,
  nullableText,
  requirePlainObject,
  requireUnique,
} from "./work-stack-projection-validation.js";

export const projectDeltaObservationKinds = Object.freeze([
  "work",
  "decision",
  "authority",
  "provider_effect",
  "source",
] as const);

export const projectDeltaWorkStates = Object.freeze([
  "ready",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const);

export const projectDeltaDecisionStates = Object.freeze([
  "open",
  "resolved",
] as const);

export const projectDeltaAuthorityStates = Object.freeze([
  "unclaimed",
  "live",
  "expired",
  "revoked",
  "superseded",
] as const);

export const projectDeltaProviderEffectStates = Object.freeze([
  "pending_reconciliation",
  "succeeded",
  "failed",
  "reconciled",
] as const);

export const projectDeltaSourceStates = Object.freeze([
  "current",
  "stale",
  "unavailable",
] as const);

export type ProjectDeltaObservationKind =
  typeof projectDeltaObservationKinds[number];
export type ProjectDeltaWorkState = typeof projectDeltaWorkStates[number];
export type ProjectDeltaDecisionState = typeof projectDeltaDecisionStates[number];
export type ProjectDeltaAuthorityState = typeof projectDeltaAuthorityStates[number];
export type ProjectDeltaProviderEffectState =
  typeof projectDeltaProviderEffectStates[number];
export type ProjectDeltaSourceState = typeof projectDeltaSourceStates[number];

interface ProjectDeltaObservationBase {
  observationId: string;
  sequence: number;
  project: string;
  subjectId: string;
  title: string;
  summary: string | null;
  observedAt: string;
  sourceReferences: string[];
}

export interface ProjectDeltaWorkObservation
  extends ProjectDeltaObservationBase {
  kind: "work";
  state: ProjectDeltaWorkState;
}

export interface ProjectDeltaDecisionObservation
  extends ProjectDeltaObservationBase {
  kind: "decision";
  state: ProjectDeltaDecisionState;
}

export interface ProjectDeltaAuthorityObservation
  extends ProjectDeltaObservationBase {
  kind: "authority";
  state: ProjectDeltaAuthorityState;
  generation: number;
  holderId: string | null;
}

export interface ProjectDeltaProviderEffectObservation
  extends ProjectDeltaObservationBase {
  kind: "provider_effect";
  state: ProjectDeltaProviderEffectState;
}

export interface ProjectDeltaSourceObservation
  extends ProjectDeltaObservationBase {
  kind: "source";
  state: ProjectDeltaSourceState;
}

export type ProjectDeltaObservation =
  | ProjectDeltaWorkObservation
  | ProjectDeltaDecisionObservation
  | ProjectDeltaAuthorityObservation
  | ProjectDeltaProviderEffectObservation
  | ProjectDeltaSourceObservation;

export interface ProjectDeltaCheckpoint {
  id: string;
  throughSequence: number;
  observedAt: string;
}

export interface CompileProjectDeltaBriefInput {
  project: string;
  fromCheckpoint: ProjectDeltaCheckpoint;
  toCheckpoint: ProjectDeltaCheckpoint;
  observations: ProjectDeltaObservation[];
  limit: number;
}

export type ProjectDeltaCategory =
  | "completed"
  | "failed"
  | "newlyBlocked"
  | "unblocked"
  | "decisionsAdded"
  | "decisionsResolved"
  | "authorityChanged"
  | "superseded"
  | "ambiguous"
  | "recovered"
  | "sourceFreshness";

export interface ProjectDeltaChange {
  observationId: string;
  sequence: number;
  kind: ProjectDeltaObservationKind;
  subjectId: string;
  title: string;
  summary: string | null;
  fromState: string | null;
  toState: string;
  fromGeneration: number | null;
  toGeneration: number | null;
  fromHolderId: string | null;
  toHolderId: string | null;
  observedAt: string;
  sourceReferences: readonly string[];
}

export type ProjectDeltaNextActionKind =
  | "review_decision"
  | "reconcile_effect"
  | "unblock_work"
  | "review_failure"
  | "restore_authority"
  | "refresh_source";

export interface ProjectDeltaNextAction {
  kind: ProjectDeltaNextActionKind;
  subjectId: string;
  title: string;
  reason: string;
  sourceReferences: readonly string[];
}

export interface ProjectDeltaBrief {
  project: string;
  fromCheckpoint: Readonly<ProjectDeltaCheckpoint>;
  toCheckpoint: Readonly<ProjectDeltaCheckpoint>;
  completed: readonly ProjectDeltaChange[];
  failed: readonly ProjectDeltaChange[];
  newlyBlocked: readonly ProjectDeltaChange[];
  unblocked: readonly ProjectDeltaChange[];
  decisionsAdded: readonly ProjectDeltaChange[];
  decisionsResolved: readonly ProjectDeltaChange[];
  authorityChanged: readonly ProjectDeltaChange[];
  superseded: readonly ProjectDeltaChange[];
  ambiguous: readonly ProjectDeltaChange[];
  recovered: readonly ProjectDeltaChange[];
  sourceFreshness: readonly ProjectDeltaChange[];
  omittedCounts: Readonly<Record<ProjectDeltaCategory | "sourceReferences", number>>;
  nextAction: Readonly<ProjectDeltaNextAction> | null;
  sourceReferences: readonly string[];
  authorizesMutation: false;
  authorizesAuthority: false;
  briefFingerprint: string;
}

const observationKindSet = new Set<ProjectDeltaObservationKind>(
  projectDeltaObservationKinds,
);
const workStateSet = new Set<ProjectDeltaWorkState>(projectDeltaWorkStates);
const decisionStateSet = new Set<ProjectDeltaDecisionState>(
  projectDeltaDecisionStates,
);
const authorityStateSet = new Set<ProjectDeltaAuthorityState>(
  projectDeltaAuthorityStates,
);
const providerEffectStateSet = new Set<ProjectDeltaProviderEffectState>(
  projectDeltaProviderEffectStates,
);
const sourceStateSet = new Set<ProjectDeltaSourceState>(
  projectDeltaSourceStates,
);
const categories = Object.freeze([
  "completed",
  "failed",
  "newlyBlocked",
  "unblocked",
  "decisionsAdded",
  "decisionsResolved",
  "authorityChanged",
  "superseded",
  "ambiguous",
  "recovered",
  "sourceFreshness",
] as const satisfies readonly ProjectDeltaCategory[]);
const maximumObservations = 4_096;
const maximumSourceReferences = 256;
const maximumOutputBytes = 512 * 1024;
const maximumMarkdownBytes = 256 * 1024;

export function compileProjectDeltaBrief(
  input: CompileProjectDeltaBriefInput,
): ProjectDeltaBrief {
  const admitted = admitInput(input);
  const currentBySubject = new Map<string, ProjectDeltaObservation>();
  const changedSubjects = new Set<string>();
  const buckets = Object.fromEntries(
    categories.map((category) => [category, [] as ProjectDeltaChange[]]),
  ) as Record<ProjectDeltaCategory, ProjectDeltaChange[]>;

  for (const observation of admitted.observations) {
    if (observation.sequence <= admitted.fromCheckpoint.throughSequence) {
      const previous = currentBySubject.get(observation.subjectId);
      requireStableKind(previous, observation);
      currentBySubject.set(observation.subjectId, observation);
      continue;
    }

    const previous = currentBySubject.get(observation.subjectId);
    requireStableKind(previous, observation);
    if (previous && transitionFingerprint(previous) === transitionFingerprint(observation)) {
      currentBySubject.set(observation.subjectId, observation);
      continue;
    }

    const change = toChange(previous, observation);
    classifyChange(previous, observation, change, buckets);
    currentBySubject.set(observation.subjectId, observation);
    changedSubjects.add(observation.subjectId);
  }

  const omittedCounts = Object.fromEntries(
    categories.map((category) => [
      category,
      Math.max(0, buckets[category].length - admitted.limit),
    ]),
  ) as Record<ProjectDeltaCategory | "sourceReferences", number>;
  const visible = Object.fromEntries(
    categories.map((category) => [
      category,
      buckets[category]
        .sort(compareChanges)
        .slice(0, admitted.limit),
    ]),
  ) as Record<ProjectDeltaCategory, ProjectDeltaChange[]>;

  const nextAction = selectNextAction(currentBySubject, changedSubjects);
  const allReferences = new Set<string>();
  for (const category of categories) {
    for (const change of visible[category]) {
      for (const reference of change.sourceReferences) allReferences.add(reference);
    }
  }
  if (nextAction) {
    for (const reference of nextAction.sourceReferences) allReferences.add(reference);
  }
  const orderedReferences = [...allReferences].sort(compareCodeUnits);
  omittedCounts.sourceReferences = Math.max(
    0,
    orderedReferences.length - maximumSourceReferences,
  );

  const unsigned = {
    project: admitted.project,
    fromCheckpoint: admitted.fromCheckpoint,
    toCheckpoint: admitted.toCheckpoint,
    completed: visible.completed,
    failed: visible.failed,
    newlyBlocked: visible.newlyBlocked,
    unblocked: visible.unblocked,
    decisionsAdded: visible.decisionsAdded,
    decisionsResolved: visible.decisionsResolved,
    authorityChanged: visible.authorityChanged,
    superseded: visible.superseded,
    ambiguous: visible.ambiguous,
    recovered: visible.recovered,
    sourceFreshness: visible.sourceFreshness,
    omittedCounts,
    nextAction,
    sourceReferences: orderedReferences.slice(0, maximumSourceReferences),
    authorizesMutation: false as const,
    authorizesAuthority: false as const,
  };
  assertCanonicalJsonByteBudget(
    unsigned,
    maximumOutputBytes,
    "Project delta brief",
  );
  return freezeDeep({
    ...unsigned,
    briefFingerprint: sha256(stableJson(unsigned)),
  }) as ProjectDeltaBrief;
}

export function renderProjectDeltaBriefMarkdown(
  brief: ProjectDeltaBrief,
): string {
  const lines = [
    `# Project changes: ${escapeMarkdown(brief.project)}`,
    "",
    `From \`${brief.fromCheckpoint.id}\` through sequence ${brief.fromCheckpoint.throughSequence} to \`${brief.toCheckpoint.id}\` through sequence ${brief.toCheckpoint.throughSequence}.`,
    "",
  ];

  if (brief.nextAction) {
    lines.push(
      "## Next operator action",
      "",
      `- ${escapeMarkdown(brief.nextAction.title)} — ${escapeMarkdown(brief.nextAction.reason)}`,
      "",
    );
  }

  const headings: ReadonlyArray<readonly [ProjectDeltaCategory, string]> = [
    ["completed", "Completed"],
    ["failed", "Failed or cancelled"],
    ["newlyBlocked", "Newly blocked"],
    ["unblocked", "Unblocked"],
    ["decisionsAdded", "Decisions added"],
    ["decisionsResolved", "Decisions resolved"],
    ["authorityChanged", "Authority changed"],
    ["superseded", "Superseded"],
    ["ambiguous", "Ambiguous effects"],
    ["recovered", "Recovered"],
    ["sourceFreshness", "Source freshness changed"],
  ];
  let visibleChanges = 0;
  for (const [category, heading] of headings) {
    const changes = brief[category];
    if (changes.length === 0 && brief.omittedCounts[category] === 0) continue;
    lines.push(`## ${heading}`, "");
    for (const change of changes) {
      visibleChanges += 1;
      lines.push(renderChange(change));
    }
    const omitted = brief.omittedCounts[category];
    if (omitted > 0) lines.push(`- ${omitted} additional change(s) omitted by the requested limit.`);
    lines.push("");
  }

  if (visibleChanges === 0) {
    lines.push(
      "No material changes were accepted between these checkpoints.",
      "",
    );
  }
  lines.push(
    `Evidence references: ${brief.sourceReferences.length}; omitted references: ${brief.omittedCounts.sourceReferences}.`,
    "",
    "This brief is advisory and grants no mutation or authority.",
  );
  const markdown = lines.join("\n");
  if (new TextEncoder().encode(markdown).byteLength > maximumMarkdownBytes) {
    throw new RangeError("Project delta Markdown exceeds its output limit");
  }
  return markdown;
}

function admitInput(
  value: CompileProjectDeltaBriefInput,
): CompileProjectDeltaBriefInput {
  requirePlainObject(
    value,
    ["project", "fromCheckpoint", "toCheckpoint", "observations", "limit"],
    "Project delta input",
  );
  const project = lowercaseSlug(dataValue(value, "project"), "Project delta project");
  const fromCheckpoint = admitCheckpoint(
    dataValue(value, "fromCheckpoint"),
    "Project delta from checkpoint",
  );
  const toCheckpoint = admitCheckpoint(
    dataValue(value, "toCheckpoint"),
    "Project delta to checkpoint",
  );
  if (fromCheckpoint.throughSequence > toCheckpoint.throughSequence) {
    throw new RangeError("Project delta checkpoint sequence regressed");
  }
  if (fromCheckpoint.observedAt > toCheckpoint.observedAt) {
    throw new RangeError("Project delta checkpoint time regressed");
  }
  if (toCheckpoint.throughSequence > maximumObservations) {
    throw new RangeError("Project delta checkpoint exceeds the observation limit");
  }

  const rawObservations = dataValue(value, "observations");
  if (!Array.isArray(rawObservations)) {
    throw new TypeError("Project delta observations must be an array");
  }
  const observations = denseDataArray(
    rawObservations,
    maximumObservations,
    "Project delta observations",
  ).map((observation, index) => admitObservation(observation, index));
  if (observations.length !== toCheckpoint.throughSequence) {
    throw new RangeError(
      "Project delta observations must cover every sequence through the target checkpoint",
    );
  }
  observations.sort((left, right) => left.sequence - right.sequence);
  const observationIds = observations.map((observation) => observation.observationId);
  requireUnique(observationIds, "Project delta observation IDs");
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    if (observation.sequence !== index + 1) {
      throw new RangeError("Project delta observation sequences must be complete and unique");
    }
    if (observation.project !== project) {
      throw new RangeError("Project delta observations must belong to the requested project");
    }
    if (observation.observedAt > toCheckpoint.observedAt) {
      throw new RangeError("Project delta observation exceeds the target checkpoint time");
    }
    if (
      observation.sequence <= fromCheckpoint.throughSequence
      && observation.observedAt > fromCheckpoint.observedAt
    ) {
      throw new RangeError("Project delta baseline observation exceeds its checkpoint time");
    }
  }

  return {
    project,
    fromCheckpoint,
    toCheckpoint,
    observations,
    limit: boundedInteger(
      dataValue(value, "limit"),
      1,
      100,
      "Project delta limit",
    ),
  };
}

function admitCheckpoint(value: unknown, label: string): ProjectDeltaCheckpoint {
  requirePlainObject(value, ["id", "throughSequence", "observedAt"], label);
  return {
    id: boundedIdentity(dataValue(value, "id"), `${label} ID`),
    throughSequence: boundedInteger(
      dataValue(value, "throughSequence"),
      0,
      maximumObservations,
      `${label} sequence`,
    ),
    observedAt: canonicalTimestamp(
      dataValue(value, "observedAt"),
      `${label} time`,
    ),
  };
}

function admitObservation(value: unknown, index: number): ProjectDeltaObservation {
  const label = `Project delta observation ${index + 1}`;
  if (
    value === null
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    !kindDescriptor
    || !("value" in kindDescriptor)
    || !kindDescriptor.enumerable
  ) {
    throw new TypeError(`${label} kind must be an enumerable data property`);
  }
  const kind = enumValue(
    kindDescriptor.value,
    observationKindSet,
    `${label} kind`,
  );
  const commonKeys = [
    "observationId",
    "sequence",
    "project",
    "subjectId",
    "kind",
    "state",
    "title",
    "summary",
    "observedAt",
    "sourceReferences",
  ];
  requirePlainObject(
    value,
    kind === "authority"
      ? [...commonKeys, "generation", "holderId"]
      : commonKeys,
    label,
  );
  const record = value as Record<string, unknown>;
  const base = {
    observationId: boundedIdentity(
      dataValue(record, "observationId"),
      `${label} ID`,
    ),
    sequence: boundedInteger(
      dataValue(record, "sequence"),
      1,
      maximumObservations,
      `${label} sequence`,
    ),
    project: lowercaseSlug(dataValue(record, "project"), `${label} project`),
    subjectId: boundedIdentity(
      dataValue(record, "subjectId"),
      `${label} subject`,
    ),
    title: boundedText(dataValue(record, "title"), 1, 160, `${label} title`),
    summary: nullableText(dataValue(record, "summary"), 500, `${label} summary`),
    observedAt: canonicalTimestamp(
      dataValue(record, "observedAt"),
      `${label} observed time`,
    ),
    sourceReferences: admitSourceReferences(
      dataValue(record, "sourceReferences"),
      label,
    ),
  };

  if (kind === "work") {
    return {
      ...base,
      kind,
      state: enumValue(dataValue(record, "state"), workStateSet, `${label} state`),
    };
  }
  if (kind === "decision") {
    return {
      ...base,
      kind,
      state: enumValue(
        dataValue(record, "state"),
        decisionStateSet,
        `${label} state`,
      ),
    };
  }
  if (kind === "provider_effect") {
    return {
      ...base,
      kind,
      state: enumValue(
        dataValue(record, "state"),
        providerEffectStateSet,
        `${label} state`,
      ),
    };
  }
  if (kind === "source") {
    return {
      ...base,
      kind,
      state: enumValue(dataValue(record, "state"), sourceStateSet, `${label} state`),
    };
  }

  const state = enumValue(
    dataValue(record, "state"),
    authorityStateSet,
    `${label} state`,
  );
  const rawHolder = dataValue(record, "holderId");
  const holderId = rawHolder === null
    ? null
    : boundedIdentity(rawHolder, `${label} holder`);
  if (state === "live" && holderId === null) {
    throw new TypeError(`${label} live authority requires a holder`);
  }
  if (state === "unclaimed" && holderId !== null) {
    throw new TypeError(`${label} unclaimed authority cannot retain a holder`);
  }
  return {
    ...base,
    kind,
    state,
    generation: boundedInteger(
      dataValue(record, "generation"),
      1,
      Number.MAX_SAFE_INTEGER,
      `${label} generation`,
    ),
    holderId,
  };
}

function admitSourceReferences(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} source references must be an array`);
  }
  const references = denseDataArray(
    value,
    8,
    `${label} source references`,
  ).map((reference, index) => boundedIdentity(
    reference,
    `${label} source reference ${index + 1}`,
  ));
  requireUnique(references, `${label} source references`);
  return references.sort(compareCodeUnits);
}

function dataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError("Project delta input inspection failed");
  }
  return descriptor.value;
}

function requireStableKind(
  previous: ProjectDeltaObservation | undefined,
  current: ProjectDeltaObservation,
): void {
  if (previous && previous.kind !== current.kind) {
    throw new RangeError("Project delta subject kind changed across observations");
  }
}

function transitionFingerprint(observation: ProjectDeltaObservation): string {
  return stableJson(observation.kind === "authority"
    ? {
        kind: observation.kind,
        state: observation.state,
        generation: observation.generation,
        holderId: observation.holderId,
      }
    : {
        kind: observation.kind,
        state: observation.state,
      });
}

function toChange(
  previous: ProjectDeltaObservation | undefined,
  current: ProjectDeltaObservation,
): ProjectDeltaChange {
  return {
    observationId: current.observationId,
    sequence: current.sequence,
    kind: current.kind,
    subjectId: current.subjectId,
    title: current.title,
    summary: current.summary,
    fromState: previous?.state ?? null,
    toState: current.state,
    fromGeneration: previous?.kind === "authority" ? previous.generation : null,
    toGeneration: current.kind === "authority" ? current.generation : null,
    fromHolderId: previous?.kind === "authority" ? previous.holderId : null,
    toHolderId: current.kind === "authority" ? current.holderId : null,
    observedAt: current.observedAt,
    sourceReferences: [...current.sourceReferences],
  };
}

function classifyChange(
  previous: ProjectDeltaObservation | undefined,
  current: ProjectDeltaObservation,
  change: ProjectDeltaChange,
  buckets: Record<ProjectDeltaCategory, ProjectDeltaChange[]>,
): void {
  if (current.kind === "work") {
    if (current.state === "completed") buckets.completed.push(change);
    if (current.state === "failed" || current.state === "cancelled") {
      buckets.failed.push(change);
    }
    if (current.state === "blocked" && previous?.state !== "blocked") {
      buckets.newlyBlocked.push(change);
    }
    if (previous?.state === "blocked" && current.state !== "blocked") {
      buckets.unblocked.push(change);
    }
    if (current.state === "superseded") buckets.superseded.push(change);
    return;
  }
  if (current.kind === "decision") {
    if (current.state === "open") buckets.decisionsAdded.push(change);
    if (current.state === "resolved") buckets.decisionsResolved.push(change);
    return;
  }
  if (current.kind === "authority") {
    buckets.authorityChanged.push(change);
    if (current.state === "superseded") buckets.superseded.push(change);
    return;
  }
  if (current.kind === "provider_effect") {
    if (current.state === "pending_reconciliation") buckets.ambiguous.push(change);
    if (current.state === "failed") buckets.failed.push(change);
    if (
      previous?.state === "pending_reconciliation"
      && (current.state === "reconciled" || current.state === "succeeded")
    ) {
      buckets.recovered.push(change);
    }
    return;
  }
  buckets.sourceFreshness.push(change);
  if (
    previous
    && (previous.state === "stale" || previous.state === "unavailable")
    && current.state === "current"
  ) {
    buckets.recovered.push(change);
  }
}

function compareChanges(left: ProjectDeltaChange, right: ProjectDeltaChange): number {
  return left.sequence - right.sequence
    || compareCodeUnits(left.subjectId, right.subjectId)
    || compareCodeUnits(left.observationId, right.observationId);
}

function selectNextAction(
  currentBySubject: ReadonlyMap<string, ProjectDeltaObservation>,
  changedSubjects: ReadonlySet<string>,
): ProjectDeltaNextAction | null {
  const candidates: Array<{
    priority: number;
    sequence: number;
    action: ProjectDeltaNextAction;
  }> = [];
  for (const observation of currentBySubject.values()) {
    if (!changedSubjects.has(observation.subjectId)) continue;
    const candidate = nextActionCandidate(observation);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => left.priority - right.priority
    || left.sequence - right.sequence
    || compareCodeUnits(left.action.subjectId, right.action.subjectId));
  return candidates[0]?.action ?? null;
}

function nextActionCandidate(observation: ProjectDeltaObservation): {
  priority: number;
  sequence: number;
  action: ProjectDeltaNextAction;
} | null {
  const base = {
    subjectId: observation.subjectId,
    title: observation.title,
    sourceReferences: [...observation.sourceReferences],
  };
  if (observation.kind === "decision" && observation.state === "open") {
    return {
      priority: 0,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "review_decision",
        reason: "A decision added during this interval remains unresolved.",
      },
    };
  }
  if (
    observation.kind === "provider_effect"
    && observation.state === "pending_reconciliation"
  ) {
    return {
      priority: 1,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "reconcile_effect",
        reason: "A provider effect remains ambiguous and must reconcile before replay.",
      },
    };
  }
  if (observation.kind === "work" && observation.state === "blocked") {
    return {
      priority: 2,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "unblock_work",
        reason: "Work newly blocked during this interval remains blocked.",
      },
    };
  }
  if (
    observation.kind === "work"
    && (observation.state === "failed" || observation.state === "cancelled")
  ) {
    return {
      priority: 3,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "review_failure",
        reason: "A failed or cancelled work result needs a continuation decision.",
      },
    };
  }
  if (
    observation.kind === "authority"
    && (observation.state === "unclaimed"
      || observation.state === "expired"
      || observation.state === "revoked")
  ) {
    return {
      priority: 4,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "restore_authority",
        reason: "Current responsibility lacks live authority.",
      },
    };
  }
  if (
    observation.kind === "source"
    && (observation.state === "stale" || observation.state === "unavailable")
  ) {
    return {
      priority: 5,
      sequence: observation.sequence,
      action: {
        ...base,
        kind: "refresh_source",
        reason: "A source changed during this interval and is not current.",
      },
    };
  }
  return null;
}

function renderChange(change: ProjectDeltaChange): string {
  const transition = change.fromState === null
    ? change.toState
    : `${change.fromState} -> ${change.toState}`;
  const references = change.sourceReferences.length === 0
    ? "no retained source reference"
    : change.sourceReferences.map((reference) => `\`${reference}\``).join(", ");
  return `- ${escapeMarkdown(change.title)} — \`${transition}\` at sequence ${change.sequence}; ${references}.`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]<>#])/g, "\\$1")
    .replace(/@/g, "\\@");
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
