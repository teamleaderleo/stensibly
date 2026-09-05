import { z } from "zod";
import { sha256, stableJson } from "./canonical-json.js";

// Admission is shared by SQLite and hosted public-item snapshots. Do not import
// the SQLite brief implementation into the Worker bundle.
const itemSchema = z.object({
  id: z.string(), kind: z.string(), title: z.string(), status: z.string(),
  priority: z.number(), summary: z.string().nullable(), nextAction: z.string().nullable(),
  claimedBy: z.string().nullable(), claimExpiresAt: z.string().nullable(), updatedAt: z.string(),
});
const snapshotSchema = z.object({
  project: z.string(), workspace: z.string().optional(), generatedAt: z.string(),
  counts: z.object({ total: z.number().int().nonnegative(), byStatus: z.record(z.string(), z.number().int().nonnegative()) }),
  ready: z.array(itemSchema).max(100), active: z.array(itemSchema).max(100),
  blocked: z.array(itemSchema).max(100), knowledge: z.array(itemSchema).max(100),
  recentlyCompleted: z.array(itemSchema).max(100),
  recentArtifacts: z.array(z.unknown()).max(100),
  activeRuns: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  activeReservations: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
});
type SourceItem = z.infer<typeof itemSchema>;

export interface CommanderItem {
  id: string;
  title: string;
  status: string;
  reason: string;
  updatedAt: string;
  summary?: string;
  nextAction?: string;
  truncated?: true;
}

/** A view of current ledger facts, never execution admission or provider truth. */
export function compileCommanderBrief(value: unknown, options: {
  project: string; limit: number; previousFingerprint?: string; now?: number;
}) {
  const source = snapshotSchema.parse(value);
  if (source.project !== options.project) throw new Error("Brief project does not match requested scope");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("Invalid brief limit");
  const now = options.now ?? Date.now();
  const observed = Date.parse(source.generatedAt);
  const current = Number.isFinite(now) && Number.isFinite(observed) && observed <= now + 5_000 && now - observed <= 60_000;
  const healthy = (item: SourceItem) => item.claimedBy !== null
    && Number.isFinite(Date.parse(item.claimExpiresAt ?? "")) && Date.parse(item.claimExpiresAt!) > now;
  const decision = (item: SourceItem) => ["decision", "question"].includes(item.kind) && ["ready", "active"].includes(item.status);
  const all = [...source.ready, ...source.active, ...source.blocked, ...source.knowledge, ...source.recentlyCompleted];
  const unique = [...new Map(all.map((item) => [item.id, item])).values()];
  const attentionSource = unique.filter(decision).sort(order);
  const activeSource = source.active.filter((item) => !healthy(item) && !decision(item)).sort(order);
  const blockedSource = source.blocked.sort(order);
  const readySource = source.ready.filter((item) => !decision(item) && item.kind === "task").sort(order);
  const completedSource = source.recentlyCompleted.filter((item) => item.kind === "task").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || order(a, b));
  // A broad overview must leave room for both a useful next read and a result,
  // even when a backlog of exceptions would consume the entire row budget.
  const readyReserve = readySource.length > 0 && options.limit >= 2 ? 1 : 0;
  const resultReserve = completedSource.length > 0 && options.limit >= 3 ? 1 : 0;
  let remaining = options.limit - readyReserve - resultReserve;
  const seen = new Set<string>();
  const take = (items: SourceItem[], reason: (item: SourceItem) => string) => {
    const selected: CommanderItem[] = [];
    for (const item of items) {
      if (!remaining || seen.has(item.id)) continue;
      remaining--; seen.add(item.id);
      const texts = [item.title, item.summary ?? "", item.nextAction ?? ""];
      selected.push({ id: item.id, title: item.title.slice(0, 240), status: item.status, reason: reason(item), updatedAt: item.updatedAt,
        ...(item.summary ? { summary: item.summary.slice(0, 240) } : {}),
        ...(item.nextAction ? { nextAction: item.nextAction.slice(0, 240) } : {}),
        ...(texts.some((text) => text.length > 240) ? { truncated: true as const } : {}),
      });
    }
    return selected;
  };
  const attention = take(attentionSource, () => "open_decision_or_question");
  const blocked = take(blockedSource, () => "blocked");
  const active = take(activeSource, () => "claim_expired_or_unverified");
  remaining += readyReserve;
  const ready = take(readySource, (item) => item.nextAction ? `ready_with_next_action;priority=${item.priority}` : "ready_missing_next_action");
  const actionableShown = seen.size;
  remaining += resultReserve;
  const recentlyCompleted = take(completedSource.slice(0, 2), () => "recorded_done_not_provider_verified");
  const candidates = attentionSource.length + blockedSource.length + activeSource.length + readySource.length;
  const sourceTruncated = ["ready", "active", "blocked"].some((status) =>
    (source.counts.byStatus[status] ?? 0) > ({ ready: source.ready, active: source.active, blocked: source.blocked, done: source.recentlyCompleted }[status]!.length));
  const omitted = { actionable: candidates - actionableShown, activeWithLiveClaims: source.active.filter((item) => healthy(item) && !decision(item)).length,
    history: unique.filter((item) => !seen.has(item.id) && item.status !== "active" && ![...attentionSource, ...blockedSource, ...readySource, ...completedSource].some((candidate) => candidate.id === item.id)).length,
    completed: Math.max(0, (source.counts.byStatus.done ?? 0) - recentlyCompleted.length),
    artifacts: source.recentArtifacts.length, runs: source.activeRuns?.length ?? null,
    reservations: source.activeReservations?.length ?? null, sourceTruncated };
  const coverage = { ledger: current ? "current" : "stale", provider: "unavailable_in_brief", capacity: "unknown",
    execution: "requires_current_admission", runs: "not_evaluated_expand_item", changes: "snapshot_replacement_not_event_history" };
  const expansion = { item: { tool: "get_runner_context", argument: "id", value: "use exact row id" },
    policy: { tool: "get_project_attachment", arguments: { project: source.project } },
    omitted: { tool: "list_work", arguments: { project: source.project } } };
  const material = { contract: "commander-brief/v1", project: source.project, workspace: source.workspace ?? null,
    counts: source.counts, attention, ready, active, blocked, recentlyCompleted, omitted, coverage, expansion };
  const fingerprint = sha256(stableJson({ material,
    // Bind every actionable row, including output omissions and text suffixes.
    // Output clipping is safe to repeat only when the complete scan is unchanged.
    evaluated: [...attentionSource, ...activeSource, ...blockedSource, ...readySource, ...completedSource].sort(order),
    // These are historical ledger observations, not current provider admission.
    runs: source.activeRuns ?? null, reservations: source.activeReservations ?? null, artifacts: source.recentArtifacts,
  }));
  // Output omissions are distinct from an incomplete canonical source scan.
  const unchanged = current && !sourceTruncated
    && !(source.activeRuns?.length) && !(source.activeReservations?.length)
    && options.previousFingerprint === fingerprint;
  if (unchanged) return { contract: material.contract, project: source.project, generatedAt: source.generatedAt,
    status: "unchanged" as const, fingerprint, counts: source.counts, ready: [], active: [], blocked: [], coverage,
    attention: undefined, omitted, expansion, recentlyCompleted: undefined };
  return { ...material, generatedAt: source.generatedAt, status: current ? "current" as const : "stale" as const, fingerprint };
}

function order(a: SourceItem, b: SourceItem) {
  return b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function renderCommanderBrief(value: ReturnType<typeof compileCommanderBrief>): string {
  if (value.status === "unchanged") return `Unchanged commander view. Provider availability and execution admission remain unverified.${value.omitted.actionable ? ` ${value.omitted.actionable} other actionable records remain omitted; list_work project=${value.project} expands them.` : ""}`;
  const rows = [...(value.attention ?? []), ...value.blocked, ...value.active, ...value.ready, ...(value.recentlyCompleted ?? [])];
  return [
    `${value.project}: ${value.status} ledger. Provider/capacity unverified; refresh admission before execution.`,
    ...rows.map((item) => `${item.reason}: ${item.title} [record updated ${item.updatedAt}]${item.summary ? ` — ${item.summary}` : ""}${item.nextAction && item.nextAction !== item.summary ? ` Next: ${item.nextAction}` : ""}${item.truncated ? " [text truncated]" : ""} [get_runner_context id=${item.id}]`),
    ...(value.omitted?.runs ? [`${value.omitted.runs} run observations not evaluated; expand their work before judging health.`] : []),
    ...(value.omitted && (value.omitted.actionable || value.omitted.sourceTruncated) ? ["More work omitted; expand list_work for this project before assuming no other attention."] : []),
  ].join("\n");
}
