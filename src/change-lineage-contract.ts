export const CHANGE_LINEAGE_VERSION = 1 as const;
export const CHANGE_LINEAGE_PROVIDERS = ["github", "gerrit", "jujutsu", "sapling", "other"] as const;
export const CHANGE_LINEAGE_LIFECYCLES = ["open", "merged", "abandoned", "superseded"] as const;
export const CHANGE_LINEAGE_OPERATIONS = [
  "create", "amend", "rebase", "restack", "split", "squash",
  "cherry_pick", "import", "supersede",
] as const;
export const CHANGE_LINEAGE_REVIEW_DISPOSITIONS = [
  "approved", "changes_requested", "commented", "none",
] as const;
export const CHANGE_LINEAGE_CHECK_CONCLUSIONS = [
  "success", "failure", "cancelled", "pending", "skipped", "neutral",
] as const;
export const CHANGE_LINEAGE_STATES = [
  "ready", "waiting_for_review", "waiting_for_checks", "historical", "superseded",
] as const;
export const CHANGE_LINEAGE_REASON_CODES = [
  "change_superseded", "change_merged", "change_abandoned",
  "review_missing", "review_stale", "review_changes_requested",
  "review_threads_unresolved", "required_check_missing",
  "required_check_pending", "required_check_failed", "required_check_stale", "ready",
] as const;

export type ChangeLineageProvider = typeof CHANGE_LINEAGE_PROVIDERS[number];
export type ChangeLineageLifecycle = typeof CHANGE_LINEAGE_LIFECYCLES[number];
export type ChangeLineageOperation = typeof CHANGE_LINEAGE_OPERATIONS[number];
export type ChangeLineageReviewDisposition = typeof CHANGE_LINEAGE_REVIEW_DISPOSITIONS[number];
export type ChangeLineageCheckConclusion = typeof CHANGE_LINEAGE_CHECK_CONCLUSIONS[number];
export type ChangeLineageState = typeof CHANGE_LINEAGE_STATES[number];
export type ChangeLineageReasonCode = typeof CHANGE_LINEAGE_REASON_CODES[number];

export interface ChangeRevisionReference { changeId: string; revisionId: string }
export interface ChangeLineageRevision {
  revisionId: string;
  generation: number;
  observedAt: string;
  operation: ChangeLineageOperation;
  predecessors: ChangeRevisionReference[];
  stackParent: ChangeRevisionReference | null;
  sourceReferences: string[];
  recoveryReference: string;
}
export interface ChangeLineageCheck {
  name: string;
  revisionId: string;
  conclusion: ChangeLineageCheckConclusion;
}
export interface ChangeLineageChange {
  changeId: string;
  provider: ChangeLineageProvider;
  providerChangeId: string;
  targetRef: string;
  lifecycle: ChangeLineageLifecycle;
  currentRevisionId: string;
  supersededBy: string | null;
  semanticDependencies: string[];
  revisions: ChangeLineageRevision[];
  requiredChecks: string[];
  checks: ChangeLineageCheck[];
  reviewedRevisionId: string | null;
  reviewDisposition: ChangeLineageReviewDisposition;
  unresolvedThreads: number;
  stableIdentityFingerprint: string;
}
export type ChangeLineageChangeInput = Omit<ChangeLineageChange, "stableIdentityFingerprint">;
export interface ChangeLineageRewriteEdge {
  from: ChangeRevisionReference;
  to: ChangeRevisionReference;
  operation: ChangeLineageOperation;
}
export interface ChangeLineageStackEdge {
  parent: ChangeRevisionReference;
  child: ChangeRevisionReference;
}
export interface ChangeLineageEvaluation {
  changeId: string;
  currentRevisionId: string;
  state: ChangeLineageState;
  reasons: ChangeLineageReasonCode[];
  reviewFresh: boolean;
  checksFresh: boolean;
  authorizesMutation: false;
  authorizesIntegration: false;
}
export interface ChangeLineageProjection {
  version: typeof CHANGE_LINEAGE_VERSION;
  repository: string;
  observedAt: string;
  changes: ChangeLineageChange[];
  rewriteEdges: ChangeLineageRewriteEdge[];
  stackEdges: ChangeLineageStackEdge[];
  evaluations: ChangeLineageEvaluation[];
  projectionFingerprint: string;
  authorizesMutation: false;
  authorizesIntegration: false;
}
