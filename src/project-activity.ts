import { stableJson } from "./canonical-json.js";
import {
  type CorrespondenceThreadProjection,
} from "./correspondence-projection.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityClass,
  type OrchestratorActivityObservation,
  type OrchestratorActivityState,
} from "./orchestrator-activity-observation.js";

export const PROJECT_ACTIVITY_VERSION = "project-activity/v1" as const;

export type ProjectActivitySourceClass = "correspondence" | "orchestrator_activity";
export type ProjectActivityClass = "correspondence_changed" | OrchestratorActivityClass;
export type ProjectActivityState =
  | "active"
  | "waiting"
  | "resolved"
  | OrchestratorActivityState;
export type ProjectActivityCurrentness = "current" | "partial" | "stale" | "unknown";

export interface ProjectActivityEntryV1 {
  readonly entryId: string;
  readonly entryFingerprint: string;
  readonly workspace: string;
  readonly project: string;
  readonly sourceClass: ProjectActivitySourceClass;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly happenedAt: string;
  readonly activityClass: ProjectActivityClass;
  readonly activityState: ProjectActivityState;
  readonly currentness: ProjectActivityCurrentness;
  readonly actorId: string | null;
  readonly callsign: string | null;
  readonly workItemId: string | null;
  readonly attemptId: string | null;
  readonly runId: string | null;
  readonly provider: string | null;
  readonly summary: string | null;
  readonly nextOrResolution: string | null;
  readonly causalPredecessorSourceId: string | null;
  readonly relatedEvidenceIds: readonly string[];
  readonly containsPrivateReasoning: false;
  readonly containsRawProviderBody: false;
  readonly authorizesOperation: false;
  readonly authorizesMutation: false;
  readonly grantsAuthority: false;
  readonly grantsResponsibility: false;
  readonly grantsApproval: false;
}

export interface ProjectActivityProjectionV1 {
  readonly version: typeof PROJECT_ACTIVITY_VERSION;
  readonly projectionFingerprint: string;
  readonly project: string;
  readonly asOf: string;
  readonly entries: readonly ProjectActivityEntryV1[];
  readonly completeness: Readonly<{
    correspondenceTruncated: boolean;
    orchestratorTruncated: boolean;
    omittedEntryCount: number;
  }>;
  readonly containsPrivateReasoning: false;
  readonly containsRawProviderBody: false;
  readonly authorizesOperation: false;
  readonly authorizesMutation: false;
  readonly grantsAuthority: false;
  readonly grantsResponsibility: false;
  readonly grantsApproval: false;
}

export interface CompileProjectActivityV1Input {
  readonly project: string;
  readonly asOf: string;
  readonly correspondence: readonly CorrespondenceThreadProjection[];
  readonly orchestrator: readonly OrchestratorActivityObservation[];
  readonly correspondenceTruncated: boolean;
  readonly orchestratorTruncated: boolean;
  readonly limit?: number;
}

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

/**
 * Pure temporal composition over already-admitted project evidence.
 *
 * This compiler deliberately does not query providers, infer joins, or invent
 * causality. Correspondence contributes one material thread snapshot; automatic
 * orchestrator observations contribute one entry each. Future accepted source
 * classes can be added without changing either source's canonical storage.
 */
export function compileProjectActivityV1(
  input: CompileProjectActivityV1Input,
): ProjectActivityProjectionV1 {
  const project = projectSlug(input.project);
  const asOf = canonicalTimestamp(input.asOf, "Project activity observation time");
  const limit = activityLimit(input.limit ?? 100);
  if (!Array.isArray(input.correspondence) || input.correspondence.length > 256) {
    throw new RangeError("Project activity correspondence input is invalid");
  }
  if (!Array.isArray(input.orchestrator) || input.orchestrator.length > 1024) {
    throw new RangeError("Project activity orchestrator input is invalid");
  }
  if (typeof input.correspondenceTruncated !== "boolean") {
    throw new TypeError("Project activity correspondence truncation must be boolean");
  }
  if (typeof input.orchestratorTruncated !== "boolean") {
    throw new TypeError("Project activity orchestrator truncation must be boolean");
  }

  const entries: ProjectActivityEntryV1[] = [];
  for (const projection of input.correspondence) {
    entries.push(correspondenceEntry(projection, project, asOf));
  }
  for (const observation of input.orchestrator) {
    entries.push(orchestratorEntry(observation, project, asOf));
  }

  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.entryId)) {
      throw new RangeError("Project activity entry identities must be unique");
    }
    entryIds.add(entry.entryId);
  }
  entries.sort((left, right) => {
    const timeDelta = Date.parse(right.happenedAt) - Date.parse(left.happenedAt);
    if (timeDelta !== 0) return timeDelta;
    return compareText(left.entryId, right.entryId);
  });

  const omittedEntryCount = Math.max(0, entries.length - limit);
  const visibleEntries = Object.freeze(entries.slice(0, limit));
  const completeness = Object.freeze({
    correspondenceTruncated: input.correspondenceTruncated,
    orchestratorTruncated: input.orchestratorTruncated,
    omittedEntryCount,
  });
  const projectionCore = {
    version: PROJECT_ACTIVITY_VERSION,
    project,
    asOf,
    entries: visibleEntries,
    completeness,
    containsPrivateReasoning: false as const,
    containsRawProviderBody: false as const,
    authorizesOperation: false as const,
    authorizesMutation: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
  };
  return Object.freeze({
    ...projectionCore,
    projectionFingerprint: fingerprintCanonicalRequest(projectionCore),
  });
}

function correspondenceEntry(
  projection: CorrespondenceThreadProjection,
  project: string,
  asOf: string,
): ProjectActivityEntryV1 {
  assertCorrespondenceProjection(projection);
  if (projection.project !== project) {
    throw new RangeError("Project activity correspondence escaped project scope");
  }
  assertAtOrBefore(projection.newestMaterialAt, asOf, "Correspondence material time");
  const relatedEvidenceIds = Object.freeze(uniqueSorted(
    projection.stages.map((stage) => stage.evidenceRef),
    64,
    "Project activity correspondence evidence",
  ));
  const entryCore = {
    workspace: exactIdentifier(projection.workspace, "Project activity workspace", 120),
    project,
    sourceClass: "correspondence" as const,
    sourceId: exactIdentifier(projection.threadId, "Project activity correspondence source ID", 240),
    sourceFingerprint: sha256(projection.projectionFingerprint, "Project activity correspondence fingerprint"),
    happenedAt: projection.newestMaterialAt,
    activityClass: "correspondence_changed" as const,
    activityState: projection.lifecycle,
    currentness: projection.freshness.currentness,
    actorId: optionalIdentifier(projection.attribution.actor, "Project activity actor ID", 160),
    callsign: optionalIdentifier(projection.attribution.callsign, "Project activity callsign", 160),
    workItemId: null,
    attemptId: null,
    runId: optionalIdentifier(projection.attribution.runId, "Project activity run ID", 240),
    provider: projection.provider,
    summary: boundedDisplay(projection.materialPreview.current, "Project activity correspondence summary", 800),
    nextOrResolution: boundedDisplay(
      projection.materialPreview.nextOrResolutionCondition,
      "Project activity correspondence next condition",
      800,
    ),
    causalPredecessorSourceId: null,
    relatedEvidenceIds,
    containsPrivateReasoning: false as const,
    containsRawProviderBody: false as const,
    authorizesOperation: false as const,
    authorizesMutation: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
  };
  const entryFingerprint = fingerprintCanonicalRequest(entryCore);
  return Object.freeze({
    entryId: `project_activity:${entryFingerprint.slice("sha256:".length)}`,
    entryFingerprint,
    ...entryCore,
  });
}

function orchestratorEntry(
  observation: OrchestratorActivityObservation,
  project: string,
  asOf: string,
): ProjectActivityEntryV1 {
  const canonical = recompileObservation(observation);
  if (canonical.project !== project) {
    throw new RangeError("Project activity observation escaped project scope");
  }
  assertAtOrBefore(canonical.observedAt, asOf, "Orchestrator activity time");
  const currentness: ProjectActivityCurrentness = canonical.activityState === "stale"
    ? "stale"
    : "unknown";
  const entryCore = {
    workspace: canonical.workspace,
    project,
    sourceClass: "orchestrator_activity" as const,
    sourceId: canonical.observationId,
    sourceFingerprint: canonical.observationFingerprint,
    happenedAt: canonical.observedAt,
    activityClass: canonical.activityClass,
    activityState: canonical.activityState,
    currentness,
    actorId: canonical.actorId,
    callsign: null,
    workItemId: canonical.workItemId,
    attemptId: canonical.attemptId,
    runId: canonical.runId,
    provider: canonical.provider,
    summary: null,
    nextOrResolution: canonical.attention.nextAction,
    causalPredecessorSourceId: canonical.causalPredecessorId,
    relatedEvidenceIds: Object.freeze([...canonical.relatedEvidenceIds]),
    containsPrivateReasoning: false as const,
    containsRawProviderBody: false as const,
    authorizesOperation: false as const,
    authorizesMutation: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
  };
  const entryFingerprint = fingerprintCanonicalRequest(entryCore);
  return Object.freeze({
    entryId: `project_activity:${entryFingerprint.slice("sha256:".length)}`,
    entryFingerprint,
    ...entryCore,
  });
}

function recompileObservation(
  observation: OrchestratorActivityObservation,
): OrchestratorActivityObservation {
  if (!observation || typeof observation !== "object") {
    throw new TypeError("Project activity orchestrator observation is invalid");
  }
  const canonical = compileOrchestratorActivityObservation({
    workspace: observation.workspace,
    project: observation.project,
    actorId: observation.actorId,
    sourceClass: observation.sourceClass,
    sourceId: observation.sourceId,
    sourceFingerprint: observation.sourceFingerprint,
    observedAt: observation.observedAt,
    activityClass: observation.activityClass,
    activityState: observation.activityState,
    ...(observation.workItemId === null ? {} : { workItemId: observation.workItemId }),
    ...(observation.attemptId === null ? {} : { attemptId: observation.attemptId }),
    ...(observation.runId === null ? {} : { runId: observation.runId }),
    ...(observation.responsibilityGeneration === null
      ? {}
      : { responsibilityGeneration: observation.responsibilityGeneration }),
    ...(observation.causalPredecessorId === null
      ? {}
      : { causalPredecessorId: observation.causalPredecessorId }),
    relatedEvidenceIds: [...observation.relatedEvidenceIds],
    ...(observation.provider === null ? {} : { provider: observation.provider }),
    ...(observation.providerLifecycle === null
      ? {}
      : { providerLifecycle: observation.providerLifecycle }),
    attentionLevel: observation.attention.level,
    ...(observation.attention.reasonCode === null
      ? {}
      : { attentionReasonCode: observation.attention.reasonCode }),
    ...(observation.attention.nextAction === null
      ? {}
      : { nextAction: observation.attention.nextAction }),
  });
  if (
    canonical.observationId !== observation.observationId
    || canonical.observationFingerprint !== observation.observationFingerprint
    || stableJson(canonical) !== stableJson(observation)
  ) {
    throw new RangeError("Project activity orchestrator observation bytes changed");
  }
  return canonical;
}

function assertCorrespondenceProjection(
  projection: CorrespondenceThreadProjection,
): void {
  if (!projection || typeof projection !== "object") {
    throw new TypeError("Project activity correspondence projection is invalid");
  }
  if (projection.version !== "correspondence-projection/v1") {
    throw new TypeError("Project activity correspondence projection version is invalid");
  }
  if (
    projection.authorizesOperation !== false
    || projection.authorizesMutation !== false
    || projection.grantsAuthority !== false
    || projection.grantsResponsibility !== false
    || projection.grantsApproval !== false
    || projection.containsRawMailBody !== false
    || projection.containsQuotedMailBody !== false
    || projection.attachmentsAdmitted !== false
  ) {
    throw new RangeError("Project activity correspondence authority or disclosure drifted");
  }
  const projectionCore = {
    version: projection.version,
    threadId: projection.threadId,
    handle: projection.handle,
    workspace: projection.workspace,
    project: projection.project,
    title: projection.title,
    semanticClass: projection.semanticClass,
    sourceThreadState: projection.sourceThreadState,
    lifecycle: projection.lifecycle,
    humanAttention: projection.humanAttention,
    provider: projection.provider,
    accountBinding: projection.accountBinding,
    providerThreadId: projection.providerThreadId,
    latestProviderMessageId: projection.latestProviderMessageId,
    newestMaterialAt: projection.newestMaterialAt,
    freshness: projection.freshness,
    attribution: projection.attribution,
    materialPreview: projection.materialPreview,
    stages: projection.stages,
    joins: projection.joins,
    containsRawMailBody: false as const,
    containsQuotedMailBody: false as const,
    attachmentsAdmitted: false as const,
    authorizesOperation: false as const,
    authorizesMutation: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
  };
  const fingerprint = fingerprintCanonicalRequest(projectionCore);
  if (fingerprint !== projection.projectionFingerprint) {
    throw new RangeError("Project activity correspondence projection fingerprint changed");
  }
}

function uniqueSorted(values: readonly string[], maximum: number, label: string): string[] {
  if (values.length > maximum) throw new RangeError(`${label} exceeded its bound`);
  const admitted = values.map((value) => exactIdentifier(value, label, 512));
  return [...new Set(admitted)].sort(compareText);
}

function projectSlug(value: unknown): string {
  if (typeof value !== "string" || !projectPattern.test(value)) {
    throw new TypeError("Project activity project is invalid");
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (canonical !== value) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertAtOrBefore(value: string, asOf: string, label: string): void {
  const admitted = canonicalTimestamp(value, label);
  if (Date.parse(admitted) > Date.parse(asOf)) {
    throw new RangeError(`${label} cannot be after the project activity observation time`);
  }
}

function activityLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 256) {
    throw new RangeError("Project activity limit must be an integer from 1 to 256");
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function optionalIdentifier(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : exactIdentifier(value, label, maximum);
}

function boundedDisplay(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
