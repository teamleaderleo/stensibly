import { createHash } from "node:crypto";
import type { Item, ItemStatus } from "./store.js";

const statuses: readonly ItemStatus[] = ["ready", "active", "blocked", "done", "archived"];

export type LeaseState = "none" | "healthy" | "expiring" | "expired" | "invalid";

export interface WorkspaceSurveyInput {
  project?: string;
  limit?: number;
  expiringWithinSeconds?: number;
  previousFingerprint?: string;
  now?: Date;
}

export interface SurveyItem {
  id: string;
  project: string;
  kind: Item["kind"];
  title: string;
  summary: string | null;
  status: ItemStatus;
  priority: number;
  nextAction: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  leaseState: LeaseState;
  secondsRemaining: number | null;
  version: number;
  updatedAt: string;
}

export interface StatusCounts {
  total: number;
  ready: number;
  active: number;
  blocked: number;
  done: number;
  archived: number;
}

export interface ProjectSurvey {
  project: string;
  counts: StatusCounts;
  highestPriority: number | null;
  updatedAt: string | null;
}

export interface WorkspaceSurvey {
  version: 1;
  generatedAt: string;
  fingerprint: string;
  changed: boolean | null;
  notifyRecommended: boolean;
  scope: { project: string | null };
  counts: StatusCounts;
  projects: ProjectSurvey[];
  attention: {
    urgent: boolean;
    invalidClaims: SurveyItem[];
    expiredClaims: SurveyItem[];
    expiringClaims: SurveyItem[];
  };
  dispatchCandidates: SurveyItem[];
  active: SurveyItem[];
  blocked: SurveyItem[];
  recentDone: SurveyItem[];
}

export function buildWorkspaceSurvey(
  items: readonly Item[],
  input: WorkspaceSurveyInput = {},
): WorkspaceSurvey {
  const limit = input.limit ?? 10;
  const expiringWithinSeconds = input.expiringWithinSeconds ?? 900;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Survey limit must be between 1 and 100");
  }
  if (
    !Number.isInteger(expiringWithinSeconds)
    || expiringWithinSeconds < 60
    || expiringWithinSeconds > 86_400
  ) {
    throw new RangeError("Survey expiry window must be between 60 and 86400 seconds");
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Survey time must be valid");

  const scopedItems = input.project
    ? items.filter((item) => item.project === input.project)
    : [...items];
  const normalized = scopedItems.map((item) =>
    toSurveyItem(item, nowMs, expiringWithinSeconds * 1_000)
  );

  const counts = countStatuses(normalized);
  const projects = projectSurveys(normalized);
  const invalidClaims = normalized
    .filter((item) => item.leaseState === "invalid")
    .sort(attentionOrder)
    .slice(0, limit);
  const expiredClaims = normalized
    .filter((item) => item.leaseState === "expired")
    .sort(attentionOrder)
    .slice(0, limit);
  const expiringClaims = normalized
    .filter((item) => item.leaseState === "expiring")
    .sort(attentionOrder)
    .slice(0, limit);
  const dispatchCandidates = normalized
    .filter((item) => item.status === "ready")
    .sort(priorityOrder)
    .slice(0, limit);
  const active = normalized
    .filter((item) => item.status === "active")
    .sort(activeOrder)
    .slice(0, limit);
  const blocked = normalized
    .filter((item) => item.status === "blocked")
    .sort(priorityOrder)
    .slice(0, limit);
  const recentDone = normalized
    .filter((item) => item.status === "done")
    .sort(updatedOrder)
    .slice(0, limit);

  const fingerprint = fingerprintSurvey(normalized);
  const changed = input.previousFingerprint === undefined
    ? null
    : input.previousFingerprint !== fingerprint;
  const actionable = invalidClaims.length > 0
    || expiredClaims.length > 0
    || expiringClaims.length > 0
    || dispatchCandidates.length > 0
    || blocked.length > 0;

  return {
    version: 1,
    generatedAt: now.toISOString(),
    fingerprint,
    changed,
    notifyRecommended: actionable && (changed ?? true),
    scope: { project: input.project ?? null },
    counts,
    projects,
    attention: {
      urgent: invalidClaims.length > 0 || expiredClaims.length > 0,
      invalidClaims,
      expiredClaims,
      expiringClaims,
    },
    dispatchCandidates,
    active,
    blocked,
    recentDone,
  };
}

function toSurveyItem(item: Item, nowMs: number, expiryWindowMs: number): SurveyItem {
  const lease = classifyLease(item, nowMs, expiryWindowMs);
  return {
    id: item.id,
    project: item.project,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    status: item.status,
    priority: item.priority,
    nextAction: item.nextAction,
    claimedBy: item.claimedBy,
    claimExpiresAt: item.claimExpiresAt,
    leaseState: lease.state,
    secondsRemaining: lease.secondsRemaining,
    version: item.version,
    updatedAt: item.updatedAt,
  };
}

function classifyLease(
  item: Item,
  nowMs: number,
  expiryWindowMs: number,
): { state: LeaseState; secondsRemaining: number | null } {
  const hasAnyClaim = item.claimedBy !== null || item.claimExpiresAt !== null;
  if (item.status !== "active") {
    return hasAnyClaim
      ? { state: "invalid", secondsRemaining: null }
      : { state: "none", secondsRemaining: null };
  }
  if (!item.claimedBy || !item.claimExpiresAt) {
    return { state: "invalid", secondsRemaining: null };
  }

  const expiryMs = Date.parse(item.claimExpiresAt);
  if (!Number.isFinite(expiryMs)) return { state: "invalid", secondsRemaining: null };
  const secondsRemaining = Math.floor((expiryMs - nowMs) / 1_000);
  if (expiryMs <= nowMs) return { state: "expired", secondsRemaining };
  if (expiryMs <= nowMs + expiryWindowMs) {
    return { state: "expiring", secondsRemaining };
  }
  return { state: "healthy", secondsRemaining };
}

function countStatuses(items: readonly Pick<SurveyItem, "status">[]): StatusCounts {
  const counts: StatusCounts = {
    total: items.length,
    ready: 0,
    active: 0,
    blocked: 0,
    done: 0,
    archived: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function projectSurveys(items: readonly SurveyItem[]): ProjectSurvey[] {
  const grouped = new Map<string, SurveyItem[]>();
  for (const item of items) {
    const projectItems = grouped.get(item.project) ?? [];
    projectItems.push(item);
    grouped.set(item.project, projectItems);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, projectItems]) => ({
      project,
      counts: countStatuses(projectItems),
      highestPriority: projectItems.length === 0
        ? null
        : Math.max(...projectItems.map((item) => item.priority)),
      updatedAt: projectItems.reduce<string | null>(
        (latest, item) => latest === null || item.updatedAt > latest ? item.updatedAt : latest,
        null,
      ),
    }));
}

function fingerprintSurvey(items: readonly SurveyItem[]): string {
  const material = [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      project: item.project,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      status: item.status,
      priority: item.priority,
      nextAction: item.nextAction,
      claimedBy: item.claimedBy,
      claimExpiresAt: item.claimExpiresAt,
      leaseState: item.leaseState,
      version: item.version,
      updatedAt: item.updatedAt,
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

function priorityOrder(left: SurveyItem, right: SurveyItem): number {
  return right.priority - left.priority
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function updatedOrder(left: SurveyItem, right: SurveyItem): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.priority - left.priority
    || left.id.localeCompare(right.id);
}

function attentionOrder(left: SurveyItem, right: SurveyItem): number {
  return (left.secondsRemaining ?? Number.POSITIVE_INFINITY)
    - (right.secondsRemaining ?? Number.POSITIVE_INFINITY)
    || priorityOrder(left, right);
}

function activeOrder(left: SurveyItem, right: SurveyItem): number {
  const rank: Record<LeaseState, number> = {
    invalid: 0,
    expired: 1,
    expiring: 2,
    healthy: 3,
    none: 4,
  };
  return rank[left.leaseState] - rank[right.leaseState]
    || attentionOrder(left, right);
}
