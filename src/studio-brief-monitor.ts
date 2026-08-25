import type { LedgerStatusItem, LedgerStatusReader } from "./studio-status-read-client.js";

/**
 * Read-only studio brief projection (#1632 monitor path).
 *
 * Renders what the ledger currently shows. It never claims, leases,
 * transitions, dispatches, approves, or settles anything; suggested items
 * are observations for a human or canonical runner to act on elsewhere.
 */

export interface StudioBrief {
  project: string;
  activeCount: number;
  blockedCount: number;
  readyCount: number;
  topReadyItem?: LedgerStatusItem;
  topBlockedItem?: LedgerStatusItem;
}

export function evaluateStudioBrief(items: readonly LedgerStatusItem[], project: string): StudioBrief {
  const active = items.filter((item) => item.status === "active");
  const blocked = items.filter((item) => item.status === "blocked");
  const ready = items
    .filter((item) => item.status === "ready")
    .sort((a, b) => b.priority - a.priority);

  return {
    project,
    activeCount: active.length,
    blockedCount: blocked.length,
    readyCount: ready.length,
    topReadyItem: ready[0],
    topBlockedItem: blocked[0],
  };
}

export function studioBriefLogLines(brief: StudioBrief, timestamp: string): string[] {
  const lines = [
    `[Monitor ${timestamp}] Read-only studio brief for ${brief.project}`,
    `  ⚡ In Motion : ${brief.activeCount} item(s) currently held by workers`,
    `  ⚠️ Blocked   : ${brief.blockedCount} item(s)${
      brief.topBlockedItem ? ` (Top: "${brief.topBlockedItem.title}")` : ""
    }`,
    `  🎯 Ready Next: ${brief.readyCount} item(s)${
      brief.topReadyItem ? ` (Top: "${brief.topReadyItem.title}" [p${brief.topReadyItem.priority}])` : ""
    } · observed only, nothing claimed`,
  ];

  if (brief.topBlockedItem) {
    lines.push(
      `  [Attention] Item needs an owner decision: ${brief.topBlockedItem.id} ("${brief.topBlockedItem.title}")`,
      `            Noted next action: ${brief.topBlockedItem.nextAction || "Unspecified"}`,
    );
  } else if (brief.topReadyItem) {
    lines.push(
      `  [Next up] Suggested focus if someone picks up work: ${brief.topReadyItem.id} ("${brief.topReadyItem.title}")`,
      `            Claim it through the canonical ledger before starting; suggested move: ${
        brief.topReadyItem.nextAction || "Begin implementation"
      }`,
    );
  } else {
    lines.push(`  [Status] All clear · no unhandled tasks in queue.`);
  }

  return lines;
}

export interface StudioBriefCycleOptions {
  readonly reader: LedgerStatusReader;
  readonly project: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

/** Runs one read-only brief cycle and returns the observed projection. */
export async function runStudioBriefOnce(options: StudioBriefCycleOptions): Promise<StudioBrief> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const items = await options.reader.listProjectItems(options.project);
  const brief = evaluateStudioBrief(items, options.project);
  for (const line of studioBriefLogLines(brief, now().toLocaleTimeString())) log(line);
  return brief;
}
