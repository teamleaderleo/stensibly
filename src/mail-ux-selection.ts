import type { MailAttentionClass } from "./mail-ux-projection.ts";

export const MAIL_UX_SELECTION_VERSION = "mail-ux-selection/v0" as const;

export type MailSelectionIntent =
  | "oldest_actionable_handoff"
  | "highest_value_eligible_review"
  | "useful_lane";

export type MailCheckpointSurface = "inbox" | "stensibly_label" | "digest";
export type MailCurrentDisposition =
  | "actionable"
  | "waiting"
  | "stranded"
  | "resolved"
  | "superseded"
  | "unknown";
export type MailValueTier = "urgent" | "high" | "normal" | "low";

export interface MailCurrentSourceReadback {
  sourceRef: string;
  checkedAt: string;
  disposition: MailCurrentDisposition;
  valueTier: MailValueTier;
  currentRevision: string | null;
  currentAction: string;
  reason: string;
}

export interface MailSelectionCheckpoint {
  handle: string;
  attentionClass: MailAttentionClass;
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  surface: MailCheckpointSurface;
  messageAt: string;
  actionableAt: string;
  bodyFetched: boolean;
  bodyBytes: number;
  sourceReadback: MailCurrentSourceReadback | null;
}

export type MailSelectionRejectionReason =
  | "older_checkpoint"
  | "wrong_class"
  | "source_not_reread"
  | "stale_source_readback"
  | "waiting"
  | "resolved"
  | "superseded"
  | "unknown";

export interface MailSelectionRejection {
  handle: string;
  providerMessageId: string;
  reason: MailSelectionRejectionReason;
}

export interface MailSelectionResult {
  version: typeof MAIL_UX_SELECTION_VERSION;
  intent: MailSelectionIntent;
  selected: MailSelectionCheckpoint | null;
  selectedNeedsBodyFetch: boolean;
  readyForAction: boolean;
  candidateMessagesSeen: number;
  latestHandlesSeen: number;
  bodyMessagesFetched: number;
  bodyContextBytes: number;
  currentSourceReads: number;
  rejectedByCurrentSource: number;
  rejections: readonly MailSelectionRejection[];
  authorizesOperation: false;
  authorizesMutation: false;
}

export interface MailSelectionRunMeasurementInput {
  messagesFetched: number;
  contextBytes: number;
  turnsToUsefulAction: number;
  selectedHandle: string | null;
  expectedHandle: string | null;
}

export interface MailSelectionRunMeasurement {
  messagesFetched: number;
  contextBytes: number;
  turnsToUsefulAction: number;
  wrongSelections: number;
}

const HANDLE_PATTERN = /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):[A-HJ-KM-NP-Z2-9]{4,8}$/;

export function selectMailContinuation(
  checkpoints: readonly MailSelectionCheckpoint[],
  intent: MailSelectionIntent,
): MailSelectionResult {
  const rejections: MailSelectionRejection[] = [];
  const latestByHandle = new Map<string, MailSelectionCheckpoint>();

  for (const checkpoint of checkpoints) {
    assertCheckpoint(checkpoint);
    const existing = latestByHandle.get(checkpoint.handle);
    if (existing === undefined) {
      latestByHandle.set(checkpoint.handle, checkpoint);
      continue;
    }

    const checkpointTime = Date.parse(checkpoint.messageAt);
    const existingTime = Date.parse(existing.messageAt);
    const newer = checkpointTime > existingTime ||
      (checkpointTime === existingTime && checkpoint.providerMessageId > existing.providerMessageId);
    if (newer) {
      rejections.push(rejection(existing, "older_checkpoint"));
      latestByHandle.set(checkpoint.handle, checkpoint);
    } else {
      rejections.push(rejection(checkpoint, "older_checkpoint"));
    }
  }

  const eligible: MailSelectionCheckpoint[] = [];
  let currentSourceReads = 0;
  let rejectedByCurrentSource = 0;

  for (const checkpoint of latestByHandle.values()) {
    if (!classMatchesIntent(checkpoint.attentionClass, intent)) {
      rejections.push(rejection(checkpoint, "wrong_class"));
      continue;
    }
    const readback = checkpoint.sourceReadback;
    if (readback === null) {
      rejections.push(rejection(checkpoint, "source_not_reread"));
      continue;
    }
    currentSourceReads += 1;
    if (Date.parse(readback.checkedAt) < Date.parse(checkpoint.messageAt)) {
      rejections.push(rejection(checkpoint, "stale_source_readback"));
      rejectedByCurrentSource += 1;
      continue;
    }

    if (readback.disposition === "actionable" || readback.disposition === "stranded") {
      eligible.push(checkpoint);
      continue;
    }

    rejections.push(rejection(checkpoint, readback.disposition));
    rejectedByCurrentSource += 1;
  }

  eligible.sort((left, right) => compareEligible(left, right, intent));
  const selected = eligible[0] ?? null;
  const selectedNeedsBodyFetch = selected !== null && !selected.bodyFetched;
  const readyForAction = selected !== null && selected.bodyFetched;
  const bodyMessagesFetched = checkpoints.filter((checkpoint) => checkpoint.bodyFetched).length;
  const bodyContextBytes = checkpoints.reduce(
    (total, checkpoint) => total + (checkpoint.bodyFetched ? checkpoint.bodyBytes : 0),
    0,
  );

  return Object.freeze({
    version: MAIL_UX_SELECTION_VERSION,
    intent,
    selected: selected === null ? null : Object.freeze({ ...selected }),
    selectedNeedsBodyFetch,
    readyForAction,
    candidateMessagesSeen: checkpoints.length,
    latestHandlesSeen: latestByHandle.size,
    bodyMessagesFetched,
    bodyContextBytes,
    currentSourceReads,
    rejectedByCurrentSource,
    rejections: Object.freeze(rejections.map((item) => Object.freeze({ ...item }))),
    authorizesOperation: false,
    authorizesMutation: false,
  });
}

export function measureMailSelectionRun(
  input: MailSelectionRunMeasurementInput,
): MailSelectionRunMeasurement {
  for (const [field, value] of Object.entries({
    messagesFetched: input.messagesFetched,
    contextBytes: input.contextBytes,
    turnsToUsefulAction: input.turnsToUsefulAction,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative integer`);
    }
  }
  const wrongSelections = input.selectedHandle === input.expectedHandle ? 0 : 1;
  return Object.freeze({
    messagesFetched: input.messagesFetched,
    contextBytes: input.contextBytes,
    turnsToUsefulAction: input.turnsToUsefulAction,
    wrongSelections,
  });
}

function compareEligible(
  left: MailSelectionCheckpoint,
  right: MailSelectionCheckpoint,
  intent: MailSelectionIntent,
): number {
  if (intent === "oldest_actionable_handoff") {
    const ageDelta = Date.parse(left.actionableAt) - Date.parse(right.actionableAt);
    if (ageDelta !== 0) return ageDelta;
    return compareStable(left, right);
  }

  const leftReadback = left.sourceReadback!;
  const rightReadback = right.sourceReadback!;
  const valueRank: Record<MailValueTier, number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  const valueDelta = valueRank[leftReadback.valueTier] - valueRank[rightReadback.valueTier];
  if (valueDelta !== 0) return valueDelta;

  if (intent === "useful_lane") {
    const classRank: Record<MailAttentionClass, number> = {
      incident: 0,
      decision: 1,
      review: 2,
      handoff: 3,
    };
    const classDelta = classRank[left.attentionClass] - classRank[right.attentionClass];
    if (classDelta !== 0) return classDelta;
  }

  const dispositionRank: Record<"actionable" | "stranded", number> = {
    stranded: 0,
    actionable: 1,
  };
  const dispositionDelta =
    dispositionRank[leftReadback.disposition as "actionable" | "stranded"] -
    dispositionRank[rightReadback.disposition as "actionable" | "stranded"];
  if (dispositionDelta !== 0) return dispositionDelta;

  const ageDelta = Date.parse(left.actionableAt) - Date.parse(right.actionableAt);
  if (ageDelta !== 0) return ageDelta;
  return compareStable(left, right);
}

function compareStable(left: MailSelectionCheckpoint, right: MailSelectionCheckpoint): number {
  if (left.handle !== right.handle) return left.handle < right.handle ? -1 : 1;
  return left.providerMessageId < right.providerMessageId ? -1 :
    left.providerMessageId > right.providerMessageId ? 1 : 0;
}

function classMatchesIntent(
  attentionClass: MailAttentionClass,
  intent: MailSelectionIntent,
): boolean {
  if (intent === "oldest_actionable_handoff") return attentionClass === "handoff";
  if (intent === "highest_value_eligible_review") return attentionClass === "review";
  return true;
}

function rejection(
  checkpoint: MailSelectionCheckpoint,
  reason: MailSelectionRejectionReason,
): MailSelectionRejection {
  return {
    handle: checkpoint.handle,
    providerMessageId: checkpoint.providerMessageId,
    reason,
  };
}

function assertCheckpoint(checkpoint: MailSelectionCheckpoint): void {
  if (!HANDLE_PATTERN.test(checkpoint.handle)) {
    throw new TypeError("mail checkpoint handle must be a canonical STN handle");
  }
  for (const [field, value] of Object.entries({
    providerMessageId: checkpoint.providerMessageId,
    providerThreadId: checkpoint.providerThreadId,
    subject: checkpoint.subject,
  })) {
    if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  }
  parseTimestamp(checkpoint.messageAt, "messageAt");
  parseTimestamp(checkpoint.actionableAt, "actionableAt");
  if (!Number.isInteger(checkpoint.bodyBytes) || checkpoint.bodyBytes < 0) {
    throw new TypeError("bodyBytes must be a non-negative integer");
  }
  if (!checkpoint.bodyFetched && checkpoint.bodyBytes !== 0) {
    throw new TypeError("metadata-only checkpoints must report zero bodyBytes");
  }
  if (checkpoint.sourceReadback !== null) {
    assertReadback(checkpoint.sourceReadback);
  }
}

function assertReadback(readback: MailCurrentSourceReadback): void {
  for (const [field, value] of Object.entries({
    sourceRef: readback.sourceRef,
    currentAction: readback.currentAction,
    reason: readback.reason,
  })) {
    if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  }
  parseTimestamp(readback.checkedAt, "checkedAt");
  if (readback.currentRevision !== null && readback.currentRevision.trim().length === 0) {
    throw new TypeError("currentRevision must be null or non-empty");
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}
