import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  createMailboxSubscriptionState,
  type MailboxCoverage,
  type MailboxProvider,
  type MailboxSubscriptionHealth,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";
import {
  freezeMailProviderProjection,
  type MailProviderProjection,
} from "./mail-provider.js";
import {
  exactMailDisplayText,
  exactMailThreadIdentifier,
  exactMailThreadTimestamp,
  freezeMailThreadRecord,
  type MailThreadClass,
  type MailThreadRecord,
  type MailThreadState,
} from "./mail-thread-contract.js";

export const CORRESPONDENCE_PROJECTION_VERSION = "correspondence-projection/v1" as const;

export const correspondenceStageKinds = [
  "outbound_reserved",
  "provider_send_accepted",
  "provider_message_identified",
  "mailbox_observed",
  "reconciliation_committed",
  "semantic_admission_linked",
  "disposition_converged",
  "provider_subscription_degraded",
  "provider_subscription_recovered",
] as const;

export type CorrespondenceStageKind = typeof correspondenceStageKinds[number];
export type CorrespondenceCurrentness = "current" | "partial" | "stale" | "unknown";
export type CorrespondenceLifecycle = "active" | "waiting" | "resolved";
export type CorrespondenceHumanAttention = "none" | "required" | "resolved";
export type CorrespondenceJoinKind =
  | "stensibly_item"
  | "stensibly_run"
  | "attention_thread"
  | "github_issue"
  | "github_pull_request"
  | "github_check"
  | "provider_thread"
  | "provider_message";

export interface CorrespondenceStageEvidence {
  readonly stageId: string;
  readonly kind: CorrespondenceStageKind;
  readonly happenedAt: string;
  readonly evidenceRef: string;
  readonly causalPredecessorStageId: string | null;
}

export interface CorrespondenceJoin {
  readonly kind: CorrespondenceJoinKind;
  readonly ref: string;
  readonly url: string | null;
}

export interface CorrespondenceAttribution {
  readonly actor: string | null;
  readonly callsign: string | null;
  readonly runId: string | null;
}

export interface CorrespondenceMaterialPreview {
  readonly current: string;
  readonly nextOrResolutionCondition: string;
}

export interface CorrespondenceFreshness {
  readonly coverage: MailboxCoverage;
  readonly subscriptionHealth: MailboxSubscriptionHealth;
  readonly lastSuccessfulReconciliationAt: string | null;
  readonly truncated: boolean;
  readonly currentness: CorrespondenceCurrentness;
}

export interface CorrespondenceThreadProjection {
  readonly version: typeof CORRESPONDENCE_PROJECTION_VERSION;
  readonly projectionFingerprint: string;
  readonly threadId: string;
  readonly handle: string;
  readonly workspace: string;
  readonly project: string;
  readonly title: string;
  readonly semanticClass: MailThreadClass;
  readonly sourceThreadState: MailThreadState;
  readonly lifecycle: CorrespondenceLifecycle;
  readonly humanAttention: CorrespondenceHumanAttention;
  readonly provider: MailboxProvider;
  readonly accountBinding: string;
  readonly providerThreadId: string;
  readonly latestProviderMessageId: string;
  readonly newestMaterialAt: string;
  readonly freshness: CorrespondenceFreshness;
  readonly attribution: CorrespondenceAttribution;
  readonly materialPreview: CorrespondenceMaterialPreview;
  readonly stages: readonly CorrespondenceStageEvidence[];
  readonly joins: readonly CorrespondenceJoin[];
  readonly containsRawMailBody: false;
  readonly containsQuotedMailBody: false;
  readonly attachmentsAdmitted: false;
  readonly authorizesOperation: false;
  readonly authorizesMutation: false;
  readonly grantsAuthority: false;
  readonly grantsResponsibility: false;
  readonly grantsApproval: false;
}

export interface CompileCorrespondenceProjectionInput {
  readonly thread: MailThreadRecord;
  readonly providerProjection: MailProviderProjection;
  readonly mailboxState: MailboxSubscriptionState;
  readonly humanAttention: CorrespondenceHumanAttention;
  readonly attribution: CorrespondenceAttribution;
  readonly materialPreview: CorrespondenceMaterialPreview;
  readonly stages: readonly CorrespondenceStageEvidence[];
  readonly joins: readonly CorrespondenceJoin[];
  readonly truncated: boolean;
  readonly asOf: string;
  readonly freshnessWindowMinutes?: number;
}

const stageKindSet = new Set<string>(correspondenceStageKinds);
const joinKinds: readonly CorrespondenceJoinKind[] = [
  "stensibly_item",
  "stensibly_run",
  "attention_thread",
  "github_issue",
  "github_pull_request",
  "github_check",
  "provider_thread",
  "provider_message",
];
const joinKindSet = new Set<string>(joinKinds);

export function compileCorrespondenceThreadProjection(
  input: CompileCorrespondenceProjectionInput,
): CorrespondenceThreadProjection {
  const thread = freezeMailThreadRecord(input.thread);
  const providerProjection = freezeMailProviderProjection(input.providerProjection);
  const mailboxState = createMailboxSubscriptionState(input.mailboxState);
  const asOf = exactMailThreadTimestamp(input.asOf, "Correspondence observation time");
  const asOfMs = Date.parse(asOf);
  const freshnessWindowMinutes = input.freshnessWindowMinutes ?? 90;
  if (
    !Number.isInteger(freshnessWindowMinutes)
    || freshnessWindowMinutes < 1
    || freshnessWindowMinutes > 7 * 24 * 60
  ) {
    throw new RangeError("Correspondence freshness window must be an integer from 1 to 10080 minutes");
  }
  if (typeof input.truncated !== "boolean") {
    throw new TypeError("Correspondence truncation flag must be boolean");
  }

  assertProviderBinding(thread, providerProjection, mailboxState);
  assertAtOrBefore(thread.updatedAt, asOfMs, "Mail thread update time");
  assertAtOrBefore(providerProjection.verifiedAt, asOfMs, "Mail provider verification time");
  if (mailboxState.lastSuccessfulReconciliationAt !== null) {
    assertAtOrBefore(
      mailboxState.lastSuccessfulReconciliationAt,
      asOfMs,
      "Mailbox reconciliation time",
    );
  }

  const humanAttention = exactHumanAttention(input.humanAttention, thread.state);
  const attribution = freezeAttribution(input.attribution);
  const materialPreview = freezeMaterialPreview(input.materialPreview);
  const stages = freezeStages(input.stages, asOfMs);
  const joins = freezeJoins(input.joins);
  const freshness = freezeFreshness({
    mailboxState,
    truncated: input.truncated,
    asOfMs,
    freshnessWindowMinutes,
  });
  const lifecycle = correspondenceLifecycle(thread.state);

  const projectionCore = {
    version: CORRESPONDENCE_PROJECTION_VERSION,
    threadId: thread.threadId,
    handle: thread.handle,
    workspace: thread.workspace,
    project: thread.project,
    title: thread.canonicalSubject,
    semanticClass: thread.threadClass,
    sourceThreadState: thread.state,
    lifecycle,
    humanAttention,
    provider: mailboxState.provider,
    accountBinding: mailboxState.mailboxBindingId,
    providerThreadId: providerProjection.providerThreadId,
    latestProviderMessageId: providerProjection.latestProviderMessageId,
    newestMaterialAt: thread.updatedAt,
    freshness,
    attribution,
    materialPreview,
    stages,
    joins,
    containsRawMailBody: false as const,
    containsQuotedMailBody: false as const,
    attachmentsAdmitted: false as const,
    authorizesOperation: false as const,
    authorizesMutation: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
  };
  const projectionFingerprint = fingerprintCanonicalRequest(projectionCore);

  return Object.freeze({
    ...projectionCore,
    projectionFingerprint,
  });
}

function assertProviderBinding(
  thread: MailThreadRecord,
  providerProjection: MailProviderProjection,
  mailboxState: MailboxSubscriptionState,
): void {
  if (providerProjection.threadId !== thread.threadId) {
    throw new RangeError("Correspondence provider projection belongs to another mail thread");
  }
  if (providerProjection.provider !== mailboxState.provider) {
    throw new RangeError("Correspondence provider identities do not match");
  }
  if (providerProjection.accountBinding !== mailboxState.mailboxBindingId) {
    throw new RangeError("Correspondence mailbox binding identities do not match");
  }
  if (mailboxState.provider !== "gmail" && mailboxState.provider !== "outlook") {
    throw new RangeError("Correspondence provider is unsupported");
  }
}

function correspondenceLifecycle(state: MailThreadState): CorrespondenceLifecycle {
  if (state === "open") return "active";
  if (state === "quiet") return "waiting";
  return "resolved";
}

function exactHumanAttention(
  value: CorrespondenceHumanAttention,
  threadState: MailThreadState,
): CorrespondenceHumanAttention {
  if (value !== "none" && value !== "required" && value !== "resolved") {
    throw new TypeError("Correspondence human attention state is invalid");
  }
  if ((threadState === "resolved" || threadState === "superseded") && value === "required") {
    throw new RangeError("Terminal correspondence cannot require current human attention");
  }
  if (threadState !== "resolved" && threadState !== "superseded" && value === "resolved") {
    throw new RangeError("Live correspondence cannot carry resolved human attention");
  }
  return value;
}

function freezeAttribution(input: CorrespondenceAttribution): CorrespondenceAttribution {
  if (!input || typeof input !== "object") {
    throw new TypeError("Correspondence attribution is invalid");
  }
  return Object.freeze({
    actor: optionalIdentifier(input.actor, "Correspondence actor", 160),
    callsign: optionalIdentifier(input.callsign, "Correspondence callsign", 160),
    runId: optionalIdentifier(input.runId, "Correspondence run ID", 240),
  });
}

function freezeMaterialPreview(
  input: CorrespondenceMaterialPreview,
): CorrespondenceMaterialPreview {
  if (!input || typeof input !== "object") {
    throw new TypeError("Correspondence material preview is invalid");
  }
  return Object.freeze({
    current: exactMailDisplayText(input.current, "Correspondence current summary", 800),
    nextOrResolutionCondition: exactMailDisplayText(
      input.nextOrResolutionCondition,
      "Correspondence next or resolution condition",
      800,
    ),
  });
}

function freezeStages(
  input: readonly CorrespondenceStageEvidence[],
  asOfMs: number,
): readonly CorrespondenceStageEvidence[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new RangeError("Correspondence stages must contain at most 64 entries");
  }
  const stageIds = new Set<string>();
  const rows = input.map((stage) => {
    if (!stage || typeof stage !== "object") {
      throw new TypeError("Correspondence stage is invalid");
    }
    const stageId = exactMailThreadIdentifier(stage.stageId, "Correspondence stage ID", 240);
    if (stageIds.has(stageId)) throw new RangeError("Correspondence stage IDs must be unique");
    stageIds.add(stageId);
    if (typeof stage.kind !== "string" || !stageKindSet.has(stage.kind)) {
      throw new TypeError("Correspondence stage kind is invalid");
    }
    const happenedAt = exactMailThreadTimestamp(stage.happenedAt, "Correspondence stage time");
    assertAtOrBefore(happenedAt, asOfMs, "Correspondence stage time");
    return {
      stageId,
      kind: stage.kind as CorrespondenceStageKind,
      happenedAt,
      evidenceRef: exactMailThreadIdentifier(stage.evidenceRef, "Correspondence stage evidence", 512),
      causalPredecessorStageId: optionalIdentifier(
        stage.causalPredecessorStageId,
        "Correspondence causal predecessor stage ID",
        240,
      ),
    };
  });

  for (const row of rows) {
    if (row.causalPredecessorStageId === null) continue;
    if (row.causalPredecessorStageId === row.stageId) {
      throw new RangeError("Correspondence stage cannot cause itself");
    }
    if (!stageIds.has(row.causalPredecessorStageId)) {
      throw new RangeError("Correspondence causal predecessor must name an explicit stage");
    }
  }
  assertAcyclicStages(rows);

  rows.sort((left, right) => {
    const timeDelta = Date.parse(left.happenedAt) - Date.parse(right.happenedAt);
    if (timeDelta !== 0) return timeDelta;
    return compareText(left.stageId, right.stageId);
  });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function assertAcyclicStages(rows: readonly CorrespondenceStageEvidence[]): void {
  const byId = new Map(rows.map((row) => [row.stageId, row] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stageId: string): void => {
    if (visited.has(stageId)) return;
    if (visiting.has(stageId)) throw new RangeError("Correspondence causal stage graph contains a cycle");
    visiting.add(stageId);
    const predecessor = byId.get(stageId)!.causalPredecessorStageId;
    if (predecessor !== null) visit(predecessor);
    visiting.delete(stageId);
    visited.add(stageId);
  };

  for (const row of rows) visit(row.stageId);
}

function freezeJoins(input: readonly CorrespondenceJoin[]): readonly CorrespondenceJoin[] {
  if (!Array.isArray(input) || input.length > 32) {
    throw new RangeError("Correspondence joins must contain at most 32 entries");
  }
  const identities = new Set<string>();
  const rows = input.map((join) => {
    if (!join || typeof join !== "object") throw new TypeError("Correspondence join is invalid");
    if (typeof join.kind !== "string" || !joinKindSet.has(join.kind)) {
      throw new TypeError("Correspondence join kind is invalid");
    }
    const kind = join.kind as CorrespondenceJoinKind;
    const ref = exactMailThreadIdentifier(join.ref, "Correspondence join reference", 512);
    const identity = `${kind}:${ref}`;
    if (identities.has(identity)) throw new RangeError("Correspondence joins must be unique");
    identities.add(identity);
    return {
      kind,
      ref,
      url: optionalHttpsUrl(join.url),
    };
  });
  rows.sort((left, right) => compareText(`${left.kind}:${left.ref}`, `${right.kind}:${right.ref}`));
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function freezeFreshness(input: {
  mailboxState: MailboxSubscriptionState;
  truncated: boolean;
  asOfMs: number;
  freshnessWindowMinutes: number;
}): CorrespondenceFreshness {
  const { mailboxState } = input;
  let currentness: CorrespondenceCurrentness;
  if (mailboxState.lastSuccessfulReconciliationAt === null) {
    currentness = "unknown";
  } else if (
    input.truncated
    || mailboxState.coverage === "unknown"
    || mailboxState.subscription.health !== "healthy"
  ) {
    currentness = "partial";
  } else {
    const reconciledAtMs = Date.parse(mailboxState.lastSuccessfulReconciliationAt);
    const ageMinutes = (input.asOfMs - reconciledAtMs) / 60_000;
    currentness = ageMinutes <= input.freshnessWindowMinutes ? "current" : "stale";
  }
  return Object.freeze({
    coverage: mailboxState.coverage,
    subscriptionHealth: mailboxState.subscription.health,
    lastSuccessfulReconciliationAt: mailboxState.lastSuccessfulReconciliationAt,
    truncated: input.truncated,
    currentness,
  });
}

function optionalIdentifier(value: unknown, label: string, max: number): string | null {
  if (value === null) return null;
  return exactMailThreadIdentifier(value, label, max);
}

function optionalHttpsUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || value !== value.trim()) {
    throw new TypeError("Correspondence join URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Correspondence join URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Correspondence join URL is invalid");
  }
  return parsed.toString();
}

function assertAtOrBefore(value: string, asOfMs: number, label: string): void {
  if (Date.parse(value) > asOfMs) throw new RangeError(`${label} cannot be after the correspondence observation`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
