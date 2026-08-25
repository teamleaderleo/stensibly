import type { LedgerStatusReader } from "./studio-status-read-client.js";

/**
 * Read-only overnight studio summary (#1632 monitor path).
 *
 * Combines local repository health observations with one read-only ledger
 * snapshot for morning review. It does not claim work under lease fences,
 * gathers no approvals, and makes no ledger changes of any kind.
 */

export interface OvernightLocalHealth {
  readonly gitClean: boolean;
  readonly typecheckPass: boolean;
  readonly testPass: boolean;
}

export interface OvernightLedgerCounts {
  readonly openTasksCount: number;
  readonly readyTasksCount: number;
  readonly blockedCount: number;
}

export interface OvernightSummary {
  readonly timestamp: string;
  readonly localHealth: OvernightLocalHealth;
  /** Present only when the read-only ledger snapshot succeeded. */
  readonly ledgerCounts?: OvernightLedgerCounts;
  /** Human-readable explanation when the ledger snapshot was skipped. */
  readonly ledgerNote?: string;
}

export function buildOvernightSummary(input: {
  timestamp: string;
  localHealth: OvernightLocalHealth;
  ledgerCounts?: OvernightLedgerCounts;
  ledgerNote?: string;
}): OvernightSummary {
  return {
    timestamp: input.timestamp,
    localHealth: input.localHealth,
    ...(input.ledgerCounts ? { ledgerCounts: input.ledgerCounts } : {}),
    ...(input.ledgerNote ? { ledgerNote: input.ledgerNote } : {}),
  };
}

function mark(pass: boolean): string {
  return pass ? "✅ PASS" : "❌ FAIL";
}

export function overnightSummaryLogLines(summary: OvernightSummary): string[] {
  const time = new Date(summary.timestamp).toLocaleTimeString();
  const lines = [
    `🌙 [Summary ${time}] === Overnight Studio Summary (read-only) ===`,
    `  [Git] Clean working tree: ${summary.localHealth.gitClean ? "✅ Clean" : "⚠️ Uncommitted changes detected"}`,
    `  [TypeScript] Typecheck: ${mark(summary.localHealth.typecheckPass)}`,
    `  [Tests] Core test suite: ${mark(summary.localHealth.testPass)}`,
  ];

  if (summary.ledgerCounts) {
    lines.push(
      `  [Ledger] Live obligations: ${summary.ledgerCounts.openTasksCount} total | ${summary.ledgerCounts.readyTasksCount} ready | ${summary.ledgerCounts.blockedCount} blocked (one read-only snapshot)`,
    );
  } else {
    lines.push(`  [Ledger] Read skipped: ${summary.ledgerNote ?? "unavailable"}`);
  }

  lines.push(`🌙 [Summary] Snapshot complete — morning review material only; no ledger changes were made.`);
  return lines;
}

export interface OvernightSummaryCycleOptions {
  readonly reader: LedgerStatusReader;
  readonly project: string;
  readonly localHealth: OvernightLocalHealth;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Runs one read-only summary pass. A failed ledger read degrades into a
 * note instead of hiding the local health observations.
 */
export async function runOvernightSummaryOnce(options: OvernightSummaryCycleOptions): Promise<OvernightSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();

  let ledgerCounts: OvernightLedgerCounts | undefined;
  let ledgerNote: string | undefined;
  try {
    const items = await options.reader.listProjectItems(options.project);
    ledgerCounts = {
      openTasksCount: items.filter((item) => item.status !== "done").length,
      readyTasksCount: items.filter((item) => item.status === "ready").length,
      blockedCount: items.filter((item) => item.status === "blocked").length,
    };
  } catch (err) {
    ledgerNote = err instanceof Error ? err.message : String(err);
  }

  const summary = buildOvernightSummary({ timestamp, localHealth: options.localHealth, ledgerCounts, ledgerNote });
  for (const line of overnightSummaryLogLines(summary)) log(line);
  return summary;
}
