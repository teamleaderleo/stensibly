export const WORK_STACK_PROJECTION_VERSION = 1 as const;
export const WORK_STACK_LIMITS = Object.freeze({
  maxInputRecords: 2_000,
  maxLinksPerRecord: 12,
  maxHot: 20,
  maxReview: 50,
  maxWarm: 50,
  maxIndex: 500,
  maxProjectionBytes: 1_048_576,
});

export type WorkStackItemKind =
  | "task"
  | "finding"
  | "question"
  | "decision"
  | "tip"
  | "handoff"
  | "note";

export type WorkStackState = "ready" | "active" | "blocked" | "done" | "archived";

export type WorkStackAttentionReason =
  | "human_decision"
  | "ambiguous_outcome"
  | "failed_verification"
  | "expired_lease"
  | "missed_heartbeat"
  | "shared_blocker"
  | "external_wait"
  | "stale_observation"
  | "ordinary_block";

export type WorkStackReviewState = "none" | "actionable" | "reviewed";

export type WorkStackLinkKind =
  | "item"
  | "run"
  | "request"
  | "receipt"
  | "github_issue"
  | "github_pull_request"
  | "github_review"
  | "github_commit"
  | "github_check"
  | "artifact"
  | "deployment"
  | "provider_observation"
  | "parent"
  | "dependency"
  | "handoff"
  | "supersession";

export type WorkStackInclusionReason =
  | "hot_context"
  | "review_context"
  | "blocked_context"
  | "priority_ready"
  | "knowledge_context"
  | "recent_completion"
  | "recent_change";

export interface WorkStackLinkInput {
  kind: WorkStackLinkKind;
  identity: string;
  href: string;
  label: string;
}

export interface WorkStackRecordInput {
  id: string;
  project: string;
  kind: WorkStackItemKind;
  title: string;
  state: WorkStackState;
  priority: number;
  summary: string | null;
  nextAction: string | null;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  actionableAt: string | null;
  latestEvidenceAt: string | null;
  attentionReason: WorkStackAttentionReason | null;
  reviewState: WorkStackReviewState;
  blockedFanOut: number;
  links: WorkStackLinkInput[];
}

export interface WorkStackProjectionInput {
  version: typeof WORK_STACK_PROJECTION_VERSION;
  project: string;
  observedAt: string;
  selectedId: string | null;
  limits: {
    hot: number;
    review: number;
    warm: number;
    index: number;
  };
  records: WorkStackRecordInput[];
}

export interface WorkStackLink extends WorkStackLinkInput {}

export interface WorkStackHotRow {
  id: string;
  title: string;
  kind: WorkStackItemKind;
  state: WorkStackState;
  priority: number;
  owner: string | null;
  attentionReason: WorkStackAttentionReason | null;
  actionableAt: string | null;
  latestEvidenceAt: string | null;
  blockedFanOut: number;
  nextAction: string | null;
  links: WorkStackLink[];
}

export interface WorkStackReviewRow {
  id: string;
  title: string;
  kind: WorkStackItemKind;
  state: WorkStackState;
  priority: number;
  actionableAt: string;
  owner: string | null;
  latestEvidenceAt: string | null;
  nextAction: string | null;
  links: WorkStackLink[];
}

export interface WorkStackSummaryRow {
  id: string;
  title: string;
  kind: WorkStackItemKind;
  state: WorkStackState;
  priority: number;
  owner: string | null;
  summary: string | null;
  nextAction: string | null;
  latestEvidenceAt: string | null;
  inclusionReason: WorkStackInclusionReason;
  links: WorkStackLink[];
}

export interface WorkStackIndexRow {
  id: string;
  title: string;
  kind: WorkStackItemKind;
  state: WorkStackState;
  priority: number;
  createdAt: string;
  updatedAt: string;
  actionableAt: string | null;
  latestEvidenceAt: string | null;
  owner: string | null;
  linkCount: number;
  hasSourceLink: boolean;
}

export interface WorkStackFocusedDetail extends WorkStackRecordInput {}

export interface WorkStackProjection {
  version: typeof WORK_STACK_PROJECTION_VERSION;
  project: string;
  observedAt: string;
  snapshotFingerprint: string;
  policy: {
    hotLimit: number;
    reviewLimit: number;
    warmLimit: number;
    indexLimit: number;
    maxOutputBytes: number;
    hotOrdering: "attention_then_oldest_unmet_then_stalest_evidence";
    reviewOrdering: "oldest_actionable_first";
    indexOrdering: "hot_then_review_then_non_archived_recent_then_archived_recent";
    detailLoading: "explicit_selection_only";
    pagination: "adapter_owned";
  };
  counts: {
    available: number;
    hotAvailable: number;
    hotReturned: number;
    reviewAvailable: number;
    reviewReturned: number;
    warmAvailable: number;
    warmReturned: number;
    indexReturned: number;
  };
  truncation: {
    hot: boolean;
    review: boolean;
    warm: boolean;
    index: boolean;
  };
  hot: WorkStackHotRow[];
  reviewQueue: WorkStackReviewRow[];
  warmSummaries: WorkStackSummaryRow[];
  coldIndex: WorkStackIndexRow[];
  focusedDetail: WorkStackFocusedDetail | null;
  authorizesOperation: false;
  authorizesMutation: false;
}
