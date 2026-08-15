import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import type { Item } from "./store.js";

export const WORK_SELECTION_RECOMMENDATION_VERSION = 1 as const;

export type WorkResponsibilityRole =
  | "general"
  | "implementation"
  | "independent_review";

export interface WorkSelectionRecommendation {
  version: typeof WORK_SELECTION_RECOMMENDATION_VERSION;
  selectedHandle: string;
  project: string;
  itemId: string;
  itemVersion: number;
  claimGeneration: number;
  workFingerprint: string;
  sourceFingerprint: string;
  responsibilityRole: WorkResponsibilityRole;
  independenceKey: string | null;
  recommendationFingerprint: string;
  grantsResponsibility: false;
  grantsAuthority: false;
}

export interface AcceptSelectedWorkInput {
  actorId: string;
  clientId: string;
  workerRef: string;
  recommendation: WorkSelectionRecommendation;
  leaseSeconds: number;
  idempotencyKey: string;
}

export interface AcceptedResponsibilityReceipt {
  receiptId: string;
  workerRef: string;
  project: string;
  itemId: string;
  recommendationFingerprint: string;
  responsibilityRole: WorkResponsibilityRole;
  independenceKey: string | null;
  acceptedAt: string;
  grantsResponsibility: true;
  grantsAuthority: false;
}

export interface SelectedWorkClaimAuthority {
  itemId: string;
  claimGeneration: number;
  expiresAt: string;
  authoritySource: "item_claim";
}

export type AcceptSelectedWorkRejection =
  | "worker_not_active"
  | "project_out_of_scope"
  | "work_changed"
  | "work_unavailable"
  | "capacity_full"
  | "review_independence"
  | "phase_overlap";

export interface AcceptSelectedWorkResult {
  version: 1;
  outcome: "accepted" | "rejected";
  reason: AcceptSelectedWorkRejection | null;
  responsibility: AcceptedResponsibilityReceipt | null;
  claim: SelectedWorkClaimAuthority | null;
  requiresRefresh: boolean;
  grantsAuthorityFromRecommendation: false;
}

const handlePattern = /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):[A-HJ-KM-NP-Z2-9]{4,8}$/;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;

export function compileWorkSelectionRecommendation(input: {
  selectedHandle: string;
  item: Pick<
    Item,
    "id" | "project" | "status" | "version" | "claimGeneration" | "priority" | "nextAction"
  >;
  sourceFingerprint: string;
  responsibilityRole?: WorkResponsibilityRole;
  independenceKey?: string | null;
}): WorkSelectionRecommendation {
  const role = input.responsibilityRole ?? "general";
  const independenceKey = normalizeIndependenceKey(role, input.independenceKey ?? null);
  if (!handlePattern.test(input.selectedHandle)) {
    throw new TypeError("selectedHandle must be a canonical STN handle");
  }
  if (input.item.status !== "ready") {
    throw new TypeError("only ready work can be recommended for acceptance");
  }
  assertPositiveInteger(input.item.version, "item version");
  assertNonNegativeInteger(input.item.claimGeneration, "claim generation");
  assertFingerprint(input.sourceFingerprint, "source fingerprint");

  const workIdentity = {
    version: 1 as const,
    project: boundedIdentity(input.item.project, "project"),
    itemId: boundedIdentity(input.item.id, "item id"),
    itemVersion: input.item.version,
    claimGeneration: input.item.claimGeneration,
    status: input.item.status,
    priority: input.item.priority,
    nextAction: input.item.nextAction,
    sourceFingerprint: input.sourceFingerprint,
  };
  const workFingerprint = fingerprintCanonicalRequest(workIdentity);
  const semantics = {
    version: WORK_SELECTION_RECOMMENDATION_VERSION,
    selectedHandle: input.selectedHandle,
    ...workIdentity,
    workFingerprint,
    responsibilityRole: role,
    independenceKey,
    grantsResponsibility: false as const,
    grantsAuthority: false as const,
  };
  return Object.freeze({
    version: WORK_SELECTION_RECOMMENDATION_VERSION,
    selectedHandle: input.selectedHandle,
    project: workIdentity.project,
    itemId: workIdentity.itemId,
    itemVersion: workIdentity.itemVersion,
    claimGeneration: workIdentity.claimGeneration,
    workFingerprint,
    sourceFingerprint: input.sourceFingerprint,
    responsibilityRole: role,
    independenceKey,
    recommendationFingerprint: fingerprintCanonicalRequest(semantics),
    grantsResponsibility: false,
    grantsAuthority: false,
  });
}

export function verifyWorkSelectionRecommendation(
  value: WorkSelectionRecommendation,
): WorkSelectionRecommendation {
  const rebuilt = compileWorkSelectionRecommendation({
    selectedHandle: value.selectedHandle,
    item: {
      id: value.itemId,
      project: value.project,
      status: "ready",
      version: value.itemVersion,
      claimGeneration: value.claimGeneration,
      priority: extractWorkIdentityPriority(value.workFingerprint),
      nextAction: extractWorkIdentityNextAction(value.workFingerprint),
    },
    sourceFingerprint: value.sourceFingerprint,
    responsibilityRole: value.responsibilityRole,
    independenceKey: value.independenceKey,
  });
  // The recommendation intentionally does not carry priority/nextAction separately.
  // Those fields are already sealed into workFingerprint, so admission verifies the
  // outer recommendation fingerprint directly and the server separately checks the
  // current item snapshot against workFingerprint.
  if (!fingerprintPattern.test(value.workFingerprint)) {
    throw new TypeError("work fingerprint is invalid");
  }
  if (!fingerprintPattern.test(value.recommendationFingerprint)) {
    throw new TypeError("recommendation fingerprint is invalid");
  }
  const semantics = {
    version: value.version,
    selectedHandle: value.selectedHandle,
    version: value.version,
    project: value.project,
    itemId: value.itemId,
    itemVersion: value.itemVersion,
    claimGeneration: value.claimGeneration,
    status: "ready",
    sourceFingerprint: value.sourceFingerprint,
    workFingerprint: value.workFingerprint,
    responsibilityRole: value.responsibilityRole,
    independenceKey: value.independenceKey,
    grantsResponsibility: false,
    grantsAuthority: false,
  };
  void rebuilt;
  if (value.recommendationFingerprint !== fingerprintCanonicalRequest(semantics)) {
    throw new Error("recommendation fingerprint does not match its semantics");
  }
  return value;
}

export function currentWorkFingerprint(input: {
  project: string;
  itemId: string;
  itemVersion: number;
  claimGeneration: number;
  status: string;
  priority: number;
  nextAction: string | null;
  sourceFingerprint: string;
}): string {
  return fingerprintCanonicalRequest({ version: 1, ...input });
}

function normalizeIndependenceKey(
  role: WorkResponsibilityRole,
  value: string | null,
): string | null {
  if (role === "general") {
    if (value !== null) throw new TypeError("general work cannot carry an independence key");
    return null;
  }
  if (value === null) throw new TypeError(`${role} work requires an independence key`);
  return boundedIdentity(value, "independence key");
}

function boundedIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 240 || !boundedIdentityPattern.test(normalized)) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function assertFingerprint(value: string, field: string): void {
  if (!fingerprintPattern.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be positive`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be non-negative`);
}

// Admission cannot recover sealed fields from a digest. These helpers deliberately
// throw if used; verifyWorkSelectionRecommendation validates the outer fingerprint,
// while the durable mutation recomputes workFingerprint from the current item.
function extractWorkIdentityPriority(_fingerprint: string): never {
  throw new Error("work fingerprint fields are verified against current durable work");
}
function extractWorkIdentityNextAction(_fingerprint: string): never {
  throw new Error("work fingerprint fields are verified against current durable work");
}
