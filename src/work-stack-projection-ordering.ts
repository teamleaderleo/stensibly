import {
  type WorkStackAttentionReason,
  type WorkStackHotRow,
  type WorkStackInclusionReason,
  type WorkStackIndexRow,
  type WorkStackItemKind,
  type WorkStackLink,
  type WorkStackLinkInput,
  type WorkStackRecordInput,
  type WorkStackReviewRow,
  type WorkStackSummaryRow,
} from "./work-stack-projection-types.ts";
import { compareCodeUnits } from "./work-stack-projection-validation.ts";

const knowledgeKinds = new Set<WorkStackItemKind>([
  "finding", "question", "decision", "tip", "handoff", "note",
]);
const sourceLinkKinds = new Set([
  "receipt", "github_issue", "github_pull_request", "github_review", "github_commit",
  "github_check", "artifact", "deployment", "provider_observation",
]);
const attentionRank: Record<WorkStackAttentionReason, number> = {
  human_decision: 0,
  ambiguous_outcome: 1,
  failed_verification: 2,
  expired_lease: 3,
  missed_heartbeat: 4,
  shared_blocker: 5,
  external_wait: 6,
  stale_observation: 7,
  ordinary_block: 8,
};
const warmRank: Record<WorkStackInclusionReason, number> = {
  hot_context: 0,
  review_context: 1,
  blocked_context: 2,
  priority_ready: 3,
  knowledge_context: 4,
  recent_completion: 5,
  recent_change: 6,
};

export function isHot(record: WorkStackRecordInput): boolean {
  return record.state === "active" || record.attentionReason !== null;
}

export function compareHot(
  left: WorkStackRecordInput,
  right: WorkStackRecordInput,
): number {
  const leftRank = left.attentionReason === null ? 9 : attentionRank[left.attentionReason];
  const rightRank = right.attentionReason === null ? 9 : attentionRank[right.attentionReason];
  return leftRank - rightRank
    || compareNullableOldest(left.actionableAt, right.actionableAt)
    || compareEvidenceOldest(left.latestEvidenceAt, right.latestEvidenceAt)
    || right.blockedFanOut - left.blockedFanOut
    || right.priority - left.priority
    || compareCodeUnits(left.id, right.id);
}

export function compareReview(
  left: WorkStackRecordInput,
  right: WorkStackRecordInput,
): number {
  return compareCodeUnits(left.actionableAt!, right.actionableAt!)
    || right.priority - left.priority
    || compareCodeUnits(left.id, right.id);
}

export function inclusionReason(
  record: WorkStackRecordInput,
  hotIds: ReadonlySet<string>,
  reviewIds: ReadonlySet<string>,
): WorkStackInclusionReason {
  if (hotIds.has(record.id)) return "hot_context";
  if (reviewIds.has(record.id)) return "review_context";
  if (record.state === "blocked") return "blocked_context";
  if (record.state === "ready") return "priority_ready";
  if (knowledgeKinds.has(record.kind)) return "knowledge_context";
  if (record.state === "done") return "recent_completion";
  return "recent_change";
}

export function compareWarm(
  left: { record: WorkStackRecordInput; reason: WorkStackInclusionReason },
  right: { record: WorkStackRecordInput; reason: WorkStackInclusionReason },
): number {
  return warmRank[left.reason] - warmRank[right.reason]
    || right.record.priority - left.record.priority
    || compareCodeUnits(right.record.updatedAt, left.record.updatedAt)
    || compareCodeUnits(left.record.id, right.record.id);
}

export function compareIndex(
  left: WorkStackRecordInput,
  right: WorkStackRecordInput,
  hotIds: ReadonlySet<string>,
  reviewIds: ReadonlySet<string>,
): number {
  const leftBucket = hotIds.has(left.id)
    ? 0
    : reviewIds.has(left.id)
      ? 1
      : left.state === "archived"
        ? 3
        : 2;
  const rightBucket = hotIds.has(right.id)
    ? 0
    : reviewIds.has(right.id)
      ? 1
      : right.state === "archived"
        ? 3
        : 2;
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;
  if (leftBucket === 0) return compareHot(left, right);
  if (leftBucket === 1) return compareReview(left, right);
  return compareCodeUnits(right.updatedAt, left.updatedAt)
    || right.priority - left.priority
    || compareCodeUnits(left.id, right.id);
}

export function toHotRow(record: WorkStackRecordInput): WorkStackHotRow {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    state: record.state,
    priority: record.priority,
    owner: record.owner,
    attentionReason: record.attentionReason,
    actionableAt: record.actionableAt,
    latestEvidenceAt: record.latestEvidenceAt,
    blockedFanOut: record.blockedFanOut,
    nextAction: record.nextAction,
    links: record.links.map(copyLink),
  };
}

export function toReviewRow(record: WorkStackRecordInput): WorkStackReviewRow {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    state: record.state,
    priority: record.priority,
    actionableAt: record.actionableAt!,
    owner: record.owner,
    latestEvidenceAt: record.latestEvidenceAt,
    nextAction: record.nextAction,
    links: record.links.map(copyLink),
  };
}

export function toSummaryRow(
  record: WorkStackRecordInput,
  reason: WorkStackInclusionReason,
): WorkStackSummaryRow {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    state: record.state,
    priority: record.priority,
    owner: record.owner,
    summary: record.summary,
    nextAction: record.nextAction,
    latestEvidenceAt: record.latestEvidenceAt,
    inclusionReason: reason,
    links: record.links.map(copyLink),
  };
}

export function toIndexRow(record: WorkStackRecordInput): WorkStackIndexRow {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    state: record.state,
    priority: record.priority,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    actionableAt: record.actionableAt,
    latestEvidenceAt: record.latestEvidenceAt,
    owner: record.owner,
    linkCount: record.links.length,
    hasSourceLink: record.links.some((link) => sourceLinkKinds.has(link.kind)),
  };
}

function copyLink(link: WorkStackLinkInput): WorkStackLink {
  return { ...link };
}

function compareEvidenceOldest(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareCodeUnits(left, right);
}

function compareNullableOldest(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareCodeUnits(left, right);
}
