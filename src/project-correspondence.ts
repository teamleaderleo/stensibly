import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  compileCorrespondenceThreadProjection,
  type CorrespondenceJoin,
  type CorrespondenceStageEvidence,
  type CorrespondenceThreadProjection,
} from "./correspondence-projection.js";
import {
  createMailboxSubscriptionState,
  mailboxObservationEventTypes,
  type MailboxObservationEventType,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";
import {
  exactMailThreadIdentifier,
  exactMailThreadTimestamp,
  freezeMailThreadRecord,
  type MailThreadRecord,
} from "./mail-thread-contract.js";
import {
  freezeMailProviderProjection,
  type MailProviderProjection,
} from "./mail-provider.js";

export const PROJECT_CORRESPONDENCE_VERSION = "project-correspondence/v1" as const;

export type ProjectCorrespondenceEffectState =
  | "reserved"
  | "sent"
  | "ambiguous"
  | "failed"
  | "reconciled";

export interface ProjectCorrespondenceEffectV1 {
  readonly outboundEffectId: string;
  readonly state: ProjectCorrespondenceEffectState;
  readonly reservedAt: string;
  readonly settledAt: string | null;
}

export interface ProjectCorrespondenceObservationV1 {
  readonly observationId: string;
  readonly eventType: MailboxObservationEventType;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly observedAt: string;
}

export interface ProjectCorrespondenceSourceCandidateV1 {
  readonly thread: MailThreadRecord;
  readonly providerProjection: MailProviderProjection;
  readonly mailboxState: MailboxSubscriptionState;
  readonly effects: readonly ProjectCorrespondenceEffectV1[];
  readonly observations: readonly ProjectCorrespondenceObservationV1[];
  readonly truncated: boolean;
}

export interface ProjectCorrespondenceSourceResultV1 {
  readonly candidates: readonly ProjectCorrespondenceSourceCandidateV1[];
  readonly threadsWithoutProviderProjection: number;
  readonly providerViewsWithoutMailboxState: number;
  readonly truncated: boolean;
}

export interface ProjectCorrespondenceSourceRequestV1 {
  readonly project: string;
  readonly limit: number;
  readonly asOf: string;
}

export interface ProjectCorrespondenceSourceV1 {
  listProject(
    request: ProjectCorrespondenceSourceRequestV1,
  ): Promise<ProjectCorrespondenceSourceResultV1>;
}

export interface ProjectCorrespondenceAssemblyV1 {
  readonly version: typeof PROJECT_CORRESPONDENCE_VERSION;
  readonly project: string;
  readonly asOf: string;
  readonly rows: readonly CorrespondenceThreadProjection[];
  readonly completeness: Readonly<{
    truncated: boolean;
    threadsWithoutProviderProjection: number;
    providerViewsWithoutMailboxState: number;
    rejectedCandidates: number;
  }>;
  readonly authorizesOperation: false;
  readonly authorizesMutation: false;
  readonly grantsAuthority: false;
  readonly grantsResponsibility: false;
  readonly grantsApproval: false;
}

const effectStates = new Set<ProjectCorrespondenceEffectState>([
  "reserved",
  "sent",
  "ambiguous",
  "failed",
  "reconciled",
]);
const mailboxEventTypes = new Set<string>(mailboxObservationEventTypes);

export async function assembleProjectCorrespondenceV1(
  source: ProjectCorrespondenceSourceV1,
  request: ProjectCorrespondenceSourceRequestV1,
): Promise<ProjectCorrespondenceAssemblyV1> {
  if (!source || typeof source.listProject !== "function") {
    throw new TypeError("Project correspondence source is required");
  }
  const project = exactMailThreadIdentifier(request.project, "Correspondence project", 120);
  const asOf = exactMailThreadTimestamp(request.asOf, "Correspondence project observation time");
  const limit = correspondenceLimit(request.limit);
  const sourceResult = await source.listProject(Object.freeze({ project, limit, asOf }));
  const admitted = admitSourceResult(sourceResult, project, asOf);

  const compiled: CorrespondenceThreadProjection[] = [];
  let rejectedCandidates = 0;
  for (const candidate of admitted.candidates) {
    try {
      compiled.push(compileCandidate(candidate, asOf));
    } catch {
      rejectedCandidates += 1;
    }
  }
  compiled.sort((left, right) => {
    const timeDelta = Date.parse(right.newestMaterialAt) - Date.parse(left.newestMaterialAt);
    if (timeDelta !== 0) return timeDelta;
    return compareText(left.handle, right.handle);
  });

  const truncated = admitted.truncated || compiled.length > limit;
  const rows = compiled.slice(0, limit);
  return Object.freeze({
    version: PROJECT_CORRESPONDENCE_VERSION,
    project,
    asOf,
    rows: Object.freeze(rows),
    completeness: Object.freeze({
      truncated,
      threadsWithoutProviderProjection: admitted.threadsWithoutProviderProjection,
      providerViewsWithoutMailboxState: admitted.providerViewsWithoutMailboxState,
      rejectedCandidates,
    }),
    authorizesOperation: false,
    authorizesMutation: false,
    grantsAuthority: false,
    grantsResponsibility: false,
    grantsApproval: false,
  });
}

function compileCandidate(
  input: ProjectCorrespondenceSourceCandidateV1,
  asOf: string,
): CorrespondenceThreadProjection {
  const thread = freezeMailThreadRecord(input.thread);
  const providerProjection = freezeMailProviderProjection(input.providerProjection);
  const mailboxState = createMailboxSubscriptionState(input.mailboxState);
  const effects = admitEffects(input.effects, asOf);
  const observations = admitObservations(input.observations, asOf);
  if (thread.project.length < 1) throw new RangeError("Correspondence thread project is missing");
  if (
    providerProjection.threadId !== thread.threadId
    || providerProjection.provider !== mailboxState.provider
    || providerProjection.accountBinding !== mailboxState.mailboxBindingId
  ) {
    throw new RangeError("Correspondence source identities do not match");
  }
  if (typeof input.truncated !== "boolean") {
    throw new TypeError("Correspondence source truncation flag must be boolean");
  }

  const latestEffect = newestEffect(effects);
  const stages = projectStages(effects, observations, providerProjection);
  const joins: readonly CorrespondenceJoin[] = Object.freeze([
    Object.freeze({
      kind: "provider_thread" as const,
      ref: providerProjection.providerThreadId,
      url: null,
    }),
    Object.freeze({
      kind: "provider_message" as const,
      ref: providerProjection.latestProviderMessageId,
      url: null,
    }),
  ]);
  const current = currentSummary(thread, latestEffect);

  return compileCorrespondenceThreadProjection({
    thread,
    providerProjection,
    mailboxState,
    humanAttention:
      thread.state === "resolved" || thread.state === "superseded" ? "resolved" : "none",
    attribution: { actor: null, callsign: null, runId: null },
    materialPreview: {
      current,
      nextOrResolutionCondition: thread.resolutionCondition,
    },
    stages,
    joins,
    truncated: input.truncated,
    asOf,
  });
}

function admitSourceResult(
  value: ProjectCorrespondenceSourceResultV1,
  project: string,
  asOf: string,
): ProjectCorrespondenceSourceResultV1 {
  if (!value || typeof value !== "object") {
    throw new TypeError("Project correspondence source result is invalid");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > 200) {
    throw new RangeError("Project correspondence candidate set is invalid");
  }
  const candidates = value.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError("Project correspondence candidate is invalid");
    }
    const thread = freezeMailThreadRecord(candidate.thread);
    if (thread.project !== project) {
      throw new RangeError("Project correspondence source escaped project scope");
    }
    assertAtOrBefore(thread.updatedAt, asOf, "Correspondence thread update time");
    if (!Array.isArray(candidate.effects) || candidate.effects.length > 16) {
      throw new RangeError("Project correspondence source effects are invalid");
    }
    if (!Array.isArray(candidate.observations) || candidate.observations.length > 16) {
      throw new RangeError("Project correspondence source observations are invalid");
    }
    return Object.freeze({
      thread,
      providerProjection: freezeMailProviderProjection(candidate.providerProjection),
      mailboxState: createMailboxSubscriptionState(candidate.mailboxState),
      effects: Object.freeze(candidate.effects.map(
        (effect: ProjectCorrespondenceEffectV1) => effect,
      )),
      observations: Object.freeze(candidate.observations.map(
        (observation: ProjectCorrespondenceObservationV1) => observation,
      )),
      truncated: candidate.truncated,
    });
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    threadsWithoutProviderProjection: nonNegativeCount(
      value.threadsWithoutProviderProjection,
      "threads without provider projection",
    ),
    providerViewsWithoutMailboxState: nonNegativeCount(
      value.providerViewsWithoutMailboxState,
      "provider views without mailbox state",
    ),
    truncated: boolean(value.truncated, "Project correspondence truncation"),
  });
}

function admitEffects(
  input: readonly ProjectCorrespondenceEffectV1[],
  asOf: string,
): readonly ProjectCorrespondenceEffectV1[] {
  if (!Array.isArray(input) || input.length > 16) {
    throw new RangeError("Correspondence effects must contain at most 16 entries");
  }
  const identities = new Set<string>();
  const rows = input.map((effect) => {
    if (!effect || typeof effect !== "object") {
      throw new TypeError("Correspondence effect is invalid");
    }
    const outboundEffectId = exactMailThreadIdentifier(
      effect.outboundEffectId,
      "Correspondence outbound effect ID",
      240,
    );
    if (identities.has(outboundEffectId)) {
      throw new RangeError("Correspondence effect IDs must be unique");
    }
    identities.add(outboundEffectId);
    if (!effectStates.has(effect.state)) {
      throw new TypeError("Correspondence effect state is invalid");
    }
    const reservedAt = exactMailThreadTimestamp(effect.reservedAt, "Correspondence effect reservation time");
    const settledAt = effect.settledAt === null
      ? null
      : exactMailThreadTimestamp(effect.settledAt, "Correspondence effect settlement time");
    assertAtOrBefore(reservedAt, asOf, "Correspondence effect reservation time");
    if (settledAt !== null) {
      assertAtOrBefore(settledAt, asOf, "Correspondence effect settlement time");
      if (Date.parse(settledAt) < Date.parse(reservedAt)) {
        throw new RangeError("Correspondence effect settlement precedes reservation");
      }
    }
    if ((effect.state === "reserved") !== (settledAt === null)) {
      throw new RangeError("Correspondence effect state and settlement time disagree");
    }
    return Object.freeze({ outboundEffectId, state: effect.state, reservedAt, settledAt });
  });
  return Object.freeze(rows);
}

function admitObservations(
  input: readonly ProjectCorrespondenceObservationV1[],
  asOf: string,
): readonly ProjectCorrespondenceObservationV1[] {
  if (!Array.isArray(input) || input.length > 16) {
    throw new RangeError("Correspondence observations must contain at most 16 entries");
  }
  const identities = new Set<string>();
  const rows = input.map((observation) => {
    if (!observation || typeof observation !== "object") {
      throw new TypeError("Correspondence observation is invalid");
    }
    const observationId = exactMailThreadIdentifier(
      observation.observationId,
      "Correspondence observation ID",
      240,
    );
    if (identities.has(observationId)) {
      throw new RangeError("Correspondence observation IDs must be unique");
    }
    identities.add(observationId);
    if (typeof observation.eventType !== "string" || !mailboxEventTypes.has(observation.eventType)) {
      throw new TypeError("Correspondence observation event type is invalid");
    }
    const observedAt = exactMailThreadTimestamp(
      observation.observedAt,
      "Correspondence observation time",
    );
    assertAtOrBefore(observedAt, asOf, "Correspondence observation time");
    return Object.freeze({
      observationId,
      eventType: observation.eventType,
      providerMessageId: optionalIdentifier(
        observation.providerMessageId,
        "Correspondence observation provider message ID",
        320,
      ),
      providerThreadId: optionalIdentifier(
        observation.providerThreadId,
        "Correspondence observation provider thread ID",
        320,
      ),
      observedAt,
    });
  });
  return Object.freeze(rows);
}

function projectStages(
  effects: readonly ProjectCorrespondenceEffectV1[],
  observations: readonly ProjectCorrespondenceObservationV1[],
  projection: MailProviderProjection,
): readonly CorrespondenceStageEvidence[] {
  const rows: CorrespondenceStageEvidence[] = [];
  for (const effect of effects) {
    const reservedStageId = stageId("effect_reserved", effect.outboundEffectId);
    rows.push(Object.freeze({
      stageId: reservedStageId,
      kind: "outbound_reserved",
      happenedAt: effect.reservedAt,
      evidenceRef: `mail_effect:${effect.outboundEffectId}`,
      causalPredecessorStageId: null,
    }));
    if (effect.settledAt === null) continue;
    if (effect.state === "sent") {
      rows.push(Object.freeze({
        stageId: stageId("effect_sent", effect.outboundEffectId),
        kind: "provider_send_accepted",
        happenedAt: effect.settledAt,
        evidenceRef: `mail_effect:${effect.outboundEffectId}`,
        causalPredecessorStageId: reservedStageId,
      }));
    } else if (effect.state === "reconciled") {
      rows.push(Object.freeze({
        stageId: stageId("effect_reconciled", effect.outboundEffectId),
        kind: "reconciliation_committed",
        happenedAt: effect.settledAt,
        evidenceRef: `mail_effect:${effect.outboundEffectId}`,
        causalPredecessorStageId: reservedStageId,
      }));
    }
  }

  rows.push(Object.freeze({
    stageId: stageId(
      "provider_message",
      `${projection.provider}:${projection.accountBinding}:${projection.latestProviderMessageId}`,
    ),
    kind: "provider_message_identified",
    happenedAt: projection.verifiedAt,
    evidenceRef: `provider_message:${projection.latestProviderMessageId}`,
    causalPredecessorStageId: null,
  }));

  for (const observation of observations) {
    const kind = observation.eventType === "mail.subscription.degraded"
      ? "provider_subscription_degraded"
      : observation.eventType === "mail.subscription.recovered"
        ? "provider_subscription_recovered"
        : "mailbox_observed";
    rows.push(Object.freeze({
      stageId: stageId("observation", observation.observationId),
      kind,
      happenedAt: observation.observedAt,
      evidenceRef: `mail_observation:${observation.observationId}`,
      causalPredecessorStageId: null,
    }));
  }
  return Object.freeze(rows);
}

function currentSummary(
  thread: MailThreadRecord,
  latestEffect: ProjectCorrespondenceEffectV1 | null,
): string {
  const lifecycle = thread.state === "open"
    ? "Active"
    : thread.state === "quiet"
      ? "Waiting"
      : thread.state === "resolved"
        ? "Resolved"
        : "Superseded";
  const delivery = latestEffect?.state === "ambiguous"
    ? " Provider outcome is ambiguous and still requires reconciliation."
    : latestEffect?.state === "failed"
      ? " Latest provider delivery failed."
      : latestEffect?.state === "reserved"
        ? " A provider delivery is reserved and unsettled."
        : "";
  return `${lifecycle}: ${thread.canonicalSubject}.${delivery}`;
}

function newestEffect(
  effects: readonly ProjectCorrespondenceEffectV1[],
): ProjectCorrespondenceEffectV1 | null {
  return [...effects].sort((left, right) => {
    const leftTime = Date.parse(left.settledAt ?? left.reservedAt);
    const rightTime = Date.parse(right.settledAt ?? right.reservedAt);
    return rightTime - leftTime;
  })[0] ?? null;
}

function stageId(kind: string, identity: string): string {
  return `stage:${fingerprintCanonicalRequest({ version: 1, kind, identity }).slice("sha256:".length)}`;
}

function correspondenceLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new RangeError("Correspondence limit must be an integer from 1 to 50");
  }
  return value as number;
}

function nonNegativeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new RangeError(`Correspondence ${label} count is invalid`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function optionalIdentifier(value: unknown, label: string, max: number): string | null {
  return value === null ? null : exactMailThreadIdentifier(value, label, max);
}

function assertAtOrBefore(value: string, asOf: string, label: string): void {
  if (Date.parse(value) > Date.parse(asOf)) {
    throw new RangeError(`${label} cannot be after the project correspondence observation time`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
