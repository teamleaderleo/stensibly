import { createHash } from "node:crypto";
import { z } from "zod";
import { continuationLedger } from "./continuation-contracts.js";
import type {
  ContinuationAction,
  ContinuationEvidence,
  ContinuationProposal,
} from "./continuations.js";
import type { WorkLedger } from "./ledger.js";
import type { Item } from "./store.js";

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const continuationInboxSchema = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug")
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  expiringWithinSeconds: z.number().int().min(60).max(604_800).default(3_600),
  previousFingerprint: fingerprintSchema.optional(),
});

export type ContinuationExpiryState = "none" | "active" | "expiring" | "expired";

export interface ContinuationInboxInput {
  project?: string;
  limit?: number;
  expiringWithinSeconds?: number;
  previousFingerprint?: string;
  now?: Date;
}

export interface ContinuationInboxItem {
  id: string;
  generation: number;
  status: "proposed" | "deferred";
  title: string;
  rationale: string;
  instruction: string;
  action: ContinuationAction;
  evidence: ContinuationEvidence[];
  suggestedBy: string;
  expiresAt: string | null;
  expiryState: ContinuationExpiryState;
  secondsRemaining: number | null;
  createdAt: string;
  updatedAt: string;
  sourceItem: {
    id: string;
    project: string;
    kind: Item["kind"];
    title: string;
    summary: string | null;
    status: Item["status"];
    priority: number;
    version: number;
    updatedAt: string;
  };
}

export interface ContinuationInboxProject {
  project: string;
  total: number;
  proposed: number;
  deferred: number;
  expiring: number;
  highestPriority: number | null;
  updatedAt: string | null;
}

export interface ContinuationInbox {
  version: 1;
  generatedAt: string;
  fingerprint: string;
  changed: boolean | null;
  notifyRecommended: boolean;
  scope: { project: string | null };
  total: number;
  projects: ContinuationInboxProject[];
  items: ContinuationInboxItem[];
}

export async function buildContinuationInbox(
  ledger: WorkLedger,
  input: ContinuationInboxInput = {},
): Promise<ContinuationInbox> {
  const continuations = continuationLedger(ledger);
  if (!continuations) {
    throw new Error("Continuation proposals are unavailable on this backend");
  }
  const parsed = continuationInboxSchema.parse({
    project: input.project,
    limit: input.limit,
    expiringWithinSeconds: input.expiringWithinSeconds,
    previousFingerprint: input.previousFingerprint,
  });
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Inbox time must be valid");

  const rows = (
    await Promise.all([
      continuations.listContinuations({
        status: "proposed",
        deliveryMode: "human_inbox",
      }),
      continuations.listContinuations({
        status: "deferred",
        deliveryMode: "human_inbox",
      }),
    ])
  ).flat();

  const items: ContinuationInboxItem[] = [];
  for (const proposal of dedupe(rows)) {
    if (proposal.approvalMode !== "human") continue;
    if (proposal.status !== "proposed" && proposal.status !== "deferred") continue;
    const detail = await ledger.getItem(proposal.sourceItemId);
    if (parsed.project && detail.item.project !== parsed.project) continue;
    items.push(toInboxItem(
      proposal,
      detail.item,
      nowMs,
      parsed.expiringWithinSeconds * 1_000,
    ));
  }

  items.sort(inboxOrder);
  const fingerprint = fingerprintInbox(items);
  const changed = parsed.previousFingerprint === undefined
    ? null
    : parsed.previousFingerprint !== fingerprint;

  return {
    version: 1,
    generatedAt: now.toISOString(),
    fingerprint,
    changed,
    notifyRecommended: items.length > 0 && (changed ?? true),
    scope: { project: parsed.project ?? null },
    total: items.length,
    projects: projectSummaries(items),
    items: items.slice(0, parsed.limit),
  };
}

function dedupe(rows: readonly ContinuationProposal[]): ContinuationProposal[] {
  const byId = new Map<string, ContinuationProposal>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

function toInboxItem(
  proposal: ContinuationProposal,
  item: Item,
  nowMs: number,
  expiryWindowMs: number,
): ContinuationInboxItem {
  const expiry = classifyExpiry(proposal.expiresAt, nowMs, expiryWindowMs);
  return {
    id: proposal.id,
    generation: proposal.generation,
    status: proposal.status as "proposed" | "deferred",
    title: proposal.title,
    rationale: proposal.rationale,
    instruction: proposal.instruction,
    action: proposal.action,
    evidence: proposal.evidence,
    suggestedBy: proposal.suggestedBy,
    expiresAt: proposal.expiresAt,
    expiryState: expiry.state,
    secondsRemaining: expiry.secondsRemaining,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    sourceItem: {
      id: item.id,
      project: item.project,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      status: item.status,
      priority: item.priority,
      version: item.version,
      updatedAt: item.updatedAt,
    },
  };
}

function classifyExpiry(
  expiresAt: string | null,
  nowMs: number,
  expiryWindowMs: number,
): { state: ContinuationExpiryState; secondsRemaining: number | null } {
  if (!expiresAt) return { state: "none", secondsRemaining: null };
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return { state: "expired", secondsRemaining: null };
  const secondsRemaining = Math.floor((expiryMs - nowMs) / 1_000);
  if (expiryMs <= nowMs) return { state: "expired", secondsRemaining };
  if (expiryMs <= nowMs + expiryWindowMs) {
    return { state: "expiring", secondsRemaining };
  }
  return { state: "active", secondsRemaining };
}

function inboxOrder(left: ContinuationInboxItem, right: ContinuationInboxItem): number {
  const expiryRank: Record<ContinuationExpiryState, number> = {
    expired: 0,
    expiring: 1,
    active: 2,
    none: 3,
  };
  const statusRank = { proposed: 0, deferred: 1 } as const;
  return expiryRank[left.expiryState] - expiryRank[right.expiryState]
    || statusRank[left.status] - statusRank[right.status]
    || right.sourceItem.priority - left.sourceItem.priority
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function projectSummaries(items: readonly ContinuationInboxItem[]): ContinuationInboxProject[] {
  const grouped = new Map<string, ContinuationInboxItem[]>();
  for (const item of items) {
    const rows = grouped.get(item.sourceItem.project) ?? [];
    rows.push(item);
    grouped.set(item.sourceItem.project, rows);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, rows]) => ({
      project,
      total: rows.length,
      proposed: rows.filter((row) => row.status === "proposed").length,
      deferred: rows.filter((row) => row.status === "deferred").length,
      expiring: rows.filter((row) => row.expiryState === "expiring").length,
      highestPriority: rows.length === 0
        ? null
        : Math.max(...rows.map((row) => row.sourceItem.priority)),
      updatedAt: rows.reduce<string | null>(
        (latest, row) => latest === null || row.updatedAt > latest ? row.updatedAt : latest,
        null,
      ),
    }));
}

function fingerprintInbox(items: readonly ContinuationInboxItem[]): string {
  const material = [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      generation: item.generation,
      status: item.status,
      title: item.title,
      rationale: item.rationale,
      instruction: item.instruction,
      action: item.action,
      evidence: item.evidence,
      suggestedBy: item.suggestedBy,
      expiresAt: item.expiresAt,
      expiryState: item.expiryState,
      sourceItem: {
        id: item.sourceItem.id,
        project: item.sourceItem.project,
        status: item.sourceItem.status,
        priority: item.sourceItem.priority,
        version: item.sourceItem.version,
      },
      updatedAt: item.updatedAt,
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}
