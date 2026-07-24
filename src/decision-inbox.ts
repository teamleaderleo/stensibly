import { continuationLedger } from "./continuation-contracts.js";
import type {
  ContinuationAction,
  ContinuationCommand,
  ContinuationEvidence,
  ContinuationProposal,
} from "./continuations.js";
import type { WorkLedger } from "./ledger.js";
import type { ItemStatus } from "./store.js";

export const decisionUrgencies = ["critical", "high", "normal"] as const;
export type DecisionUrgency = typeof decisionUrgencies[number];

export interface DecisionInboxEntry {
  continuationId: string;
  project: string;
  sourceItem: {
    id: string;
    title: string;
    status: ItemStatus;
    priority: number;
    summary: string | null;
    nextAction: string | null;
  };
  title: string;
  rationale: string;
  instruction: string;
  action: ContinuationAction;
  evidence: ContinuationEvidence[];
  suggestedBy: string;
  status: "proposed" | "deferred";
  generation: number;
  deliveryMode: ContinuationProposal["deliveryMode"];
  urgency: DecisionUrgency;
  expiresAt: string | null;
  allowedCommands: ContinuationCommand[];
  createdAt: string;
  updatedAt: string;
}

export interface DecisionInbox {
  generatedAt: string;
  project: string | null;
  total: number;
  entries: DecisionInboxEntry[];
}

export interface DecisionInboxOptions {
  project?: string;
  limit?: number;
  now?: Date;
}

export async function buildDecisionInbox(
  ledger: WorkLedger,
  options: DecisionInboxOptions = {},
): Promise<DecisionInbox> {
  const continuations = continuationLedger(ledger);
  if (!continuations) {
    throw new Error("Continuation proposals are unavailable on this backend");
  }

  const project = options.project?.trim() || undefined;
  const limit = normalizeLimit(options.limit ?? 50);
  const now = options.now ?? new Date();
  const proposals = await continuations.listContinuations();
  const candidates = proposals.filter(
    (proposal): proposal is ContinuationProposal & {
      status: "proposed" | "deferred";
    } =>
      proposal.approvalMode === "human" &&
      (proposal.status === "proposed" || proposal.status === "deferred"),
  );

  const hydrated = await Promise.all(
    candidates.map(async (proposal) => {
      const detail = await ledger.getItem(proposal.sourceItemId);
      if (project && detail.item.project !== project) return null;
      return toEntry(proposal, detail.item, now);
    }),
  );
  const entries = hydrated
    .filter((entry): entry is DecisionInboxEntry => entry !== null)
    .sort(compareEntries)
    .slice(0, limit);

  return {
    generatedAt: now.toISOString(),
    project: project ?? null,
    total: entries.length,
    entries,
  };
}

function toEntry(
  proposal: ContinuationProposal & { status: "proposed" | "deferred" },
  item: Awaited<ReturnType<WorkLedger["getItem"]>>["item"],
  now: Date,
): DecisionInboxEntry {
  return {
    continuationId: proposal.id,
    project: item.project,
    sourceItem: {
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      summary: item.summary,
      nextAction: item.nextAction,
    },
    title: proposal.title,
    rationale: proposal.rationale,
    instruction: proposal.instruction,
    action: proposal.action,
    evidence: proposal.evidence,
    suggestedBy: proposal.suggestedBy,
    status: proposal.status,
    generation: proposal.generation,
    deliveryMode: proposal.deliveryMode,
    urgency: urgencyFor(proposal.expiresAt, now),
    expiresAt: proposal.expiresAt,
    allowedCommands: proposal.status === "proposed"
      ? ["approve", "reject", "defer", "cancel", "supersede"]
      : ["approve", "reject", "cancel", "supersede"],
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function urgencyFor(expiresAt: string | null, now: Date): DecisionUrgency {
  if (!expiresAt) return "normal";
  const remaining = Date.parse(expiresAt) - now.getTime();
  if (remaining <= 60 * 60 * 1000) return "critical";
  if (remaining <= 24 * 60 * 60 * 1000) return "high";
  return "normal";
}

function compareEntries(left: DecisionInboxEntry, right: DecisionInboxEntry): number {
  const urgencyRank: Record<DecisionUrgency, number> = {
    critical: 0,
    high: 1,
    normal: 2,
  };
  return urgencyRank[left.urgency] - urgencyRank[right.urgency] ||
    (left.status === right.status ? 0 : left.status === "proposed" ? -1 : 1) ||
    right.sourceItem.priority - left.sourceItem.priority ||
    compareOptionalDates(left.expiresAt, right.expiresAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.continuationId.localeCompare(right.continuationId);
}

function compareOptionalDates(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError("Decision inbox limit must be between 1 and 100");
  }
  return value;
}
