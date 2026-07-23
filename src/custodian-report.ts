import { expireClaims } from "./leases.ts";
import { StensiblyStore, type Item, type ItemKind, type ItemStatus } from "./store.ts";

export interface CustodianItem {
  id: string;
  project: string;
  kind: ItemKind;
  title: string;
  status: ItemStatus;
  priority: number;
  nextAction: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  updatedAt: string;
}

export interface DuplicateTitleGroup {
  project: string;
  normalizedTitle: string;
  items: CustodianItem[];
}

export interface CustodianReport {
  generatedAt: string;
  scope: { project: string | null };
  settings: {
    staleDays: number;
    expiringWithinMinutes: number;
  };
  summary: {
    expiredClaims: number;
    expiringClaims: number;
    missingNextActions: number;
    staleReady: number;
    staleBlocked: number;
    duplicateTitleGroups: number;
  };
  expiredClaimIds: string[];
  expiringClaims: CustodianItem[];
  missingNextActions: CustodianItem[];
  staleReady: CustodianItem[];
  staleBlocked: CustodianItem[];
  duplicateTitleGroups: DuplicateTitleGroup[];
}

export function inspectScrapbook(
  store: StensiblyStore,
  options: {
    project?: string;
    staleDays?: number;
    expiringWithinMinutes?: number;
    now?: Date;
  } = {},
): CustodianReport {
  const staleDays = options.staleDays ?? 7;
  const expiringWithinMinutes = options.expiringWithinMinutes ?? 5;
  if (!Number.isFinite(staleDays) || staleDays < 0 || staleDays > 3650) {
    throw new RangeError("staleDays must be between 0 and 3650");
  }
  if (
    !Number.isFinite(expiringWithinMinutes)
    || expiringWithinMinutes < 0
    || expiringWithinMinutes > 10_080
  ) {
    throw new RangeError("expiringWithinMinutes must be between 0 and 10080");
  }

  const now = options.now ?? new Date();
  const expiredClaimIds = expireClaims(store, now);
  const items = store.listItems(options.project ? { project: options.project } : {});
  const staleCutoff = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const expiringCutoff = now.getTime() + expiringWithinMinutes * 60 * 1000;

  const expiringClaims = items
    .filter((item) => {
      if (item.status !== "active" || !item.claimExpiresAt) return false;
      const expiry = new Date(item.claimExpiresAt).getTime();
      return expiry > now.getTime() && expiry <= expiringCutoff;
    })
    .sort((left, right) =>
      (left.claimExpiresAt ?? "").localeCompare(right.claimExpiresAt ?? ""),
    )
    .map(toCustodianItem);

  const missingNextActions = items
    .filter((item) =>
      item.status !== "done"
      && item.status !== "archived"
      && requiresNextAction(item.kind, item.status)
      && !item.nextAction?.trim(),
    )
    .sort(priorityFirst)
    .map(toCustodianItem);

  const staleReady = items
    .filter((item) =>
      item.status === "ready" && new Date(item.updatedAt).getTime() <= staleCutoff,
    )
    .sort(oldestFirst)
    .map(toCustodianItem);

  const staleBlocked = items
    .filter((item) =>
      item.status === "blocked" && new Date(item.updatedAt).getTime() <= staleCutoff,
    )
    .sort(oldestFirst)
    .map(toCustodianItem);

  const duplicateTitleGroups = findDuplicateTitles(items);

  return {
    generatedAt: now.toISOString(),
    scope: { project: options.project ?? null },
    settings: { staleDays, expiringWithinMinutes },
    summary: {
      expiredClaims: expiredClaimIds.length,
      expiringClaims: expiringClaims.length,
      missingNextActions: missingNextActions.length,
      staleReady: staleReady.length,
      staleBlocked: staleBlocked.length,
      duplicateTitleGroups: duplicateTitleGroups.length,
    },
    expiredClaimIds,
    expiringClaims,
    missingNextActions,
    staleReady,
    staleBlocked,
    duplicateTitleGroups,
  };
}

export function reportHasFindings(report: CustodianReport): boolean {
  return Object.values(report.summary).some((count) => count > 0);
}

function requiresNextAction(kind: ItemKind, status: ItemStatus): boolean {
  if (status === "blocked" || status === "active") return true;
  return kind === "task" || kind === "question" || kind === "handoff";
}

function findDuplicateTitles(items: Item[]): DuplicateTitleGroup[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (item.status === "done" || item.status === "archived") continue;
    const normalizedTitle = normalizeTitle(item.title);
    if (!normalizedTitle) continue;
    const key = `${item.project}\u0000${normalizedTitle}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const [project = "", normalizedTitle = ""] = key.split("\u0000", 2);
      return {
        project,
        normalizedTitle,
        items: group.sort(priorityFirst).map(toCustodianItem),
      };
    })
    .sort((left, right) =>
      left.project.localeCompare(right.project)
      || left.normalizedTitle.localeCompare(right.normalizedTitle),
    );
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function priorityFirst(left: Item, right: Item): number {
  return right.priority - left.priority || left.updatedAt.localeCompare(right.updatedAt);
}

function oldestFirst(left: Item, right: Item): number {
  return left.updatedAt.localeCompare(right.updatedAt) || right.priority - left.priority;
}

function toCustodianItem(item: Item): CustodianItem {
  return {
    id: item.id,
    project: item.project,
    kind: item.kind,
    title: item.title,
    status: item.status,
    priority: item.priority,
    nextAction: item.nextAction,
    claimedBy: item.claimedBy,
    claimExpiresAt: item.claimExpiresAt,
    updatedAt: item.updatedAt,
  };
}
