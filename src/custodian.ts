import { runCustodianPolicy, type CustodianMode } from "./custodian-policy.js";
import { reportHasFindings } from "./custodian-report.js";
import { validateOptionalProjectScope } from "./project-scope.js";
import { StensiblyStore } from "./store.js";

export interface CustodianCliOptions {
  project?: string;
  staleDays: number;
  expiringWithinMinutes: number;
  mode: CustodianMode;
  maxActions: number;
  failOnFindings: boolean;
  showHelp: boolean;
}

export function parseCustodianArgs(args: string[]): CustodianCliOptions {
  const options: CustodianCliOptions = {
    staleDays: 7,
    expiringWithinMinutes: 5,
    mode: "observe",
    maxActions: 100,
    failOnFindings: false,
    showHelp: false,
  };
  let explicitMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.showHelp = true;
      continue;
    }
    if (argument === "--fail-on-findings") {
      options.failOnFindings = true;
      continue;
    }
    if (argument === "--project") {
      options.project = requireValue(args, ++index, "--project");
      continue;
    }
    if (argument === "--stale-days") {
      options.staleDays = parseNumber(
        requireValue(args, ++index, "--stale-days"),
        "--stale-days",
      );
      continue;
    }
    if (argument === "--expiring-within") {
      options.expiringWithinMinutes = parseNumber(
        requireValue(args, ++index, "--expiring-within"),
        "--expiring-within",
      );
      continue;
    }
    if (argument === "--max-actions") {
      options.maxActions = parseInteger(
        requireValue(args, ++index, "--max-actions"),
        "--max-actions",
      );
      continue;
    }
    if (argument === "--mode") {
      if (explicitMode) throw new Error("Choose only one custodian mode");
      options.mode = parseMode(requireValue(args, ++index, "--mode"));
      explicitMode = true;
      continue;
    }
    if (argument === "--dry-run" || argument === "--apply") {
      if (explicitMode) throw new Error("Choose only one custodian mode");
      options.mode = argument === "--dry-run" ? "dry-run" : "apply";
      explicitMode = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  const project = validateOptionalProjectScope(options.project, "--project");
  if (project !== undefined) options.project = project;
  if (options.maxActions < 0 || options.maxActions > 10_000) {
    throw new Error("--max-actions must be between 0 and 10000");
  }
  return options;
}

export function custodianUsage(): string {
  return `Stensibly custodian

Usage:
  bun run custodian [options]

Modes:
  observe (default)           Read-only findings and all eligible-action reporting
  dry-run                     Read-only exact bounded action plan
  apply                       Apply bounded invariant reconciliation only

Options:
  --mode <mode>               observe, dry-run, or apply
  --dry-run                   Alias for --mode dry-run
  --apply                     Alias for --mode apply
  --max-actions <count>       Maximum expired claims to plan or reconcile (default: 100)
  --project <slug>            Inspect and apply within one project only
  --stale-days <days>         Flag ready or blocked work older than this (default: 7)
  --expiring-within <mins>    Flag live claims expiring within this window (default: 5)
  --fail-on-findings          Exit with status 2 when the report contains findings
  --help                      Show this help

Automation policy:
  - elapsed claims: eligible for bounded reconciliation in apply mode
  - expiring claims: notify only
  - missing next actions, stale work, and duplicate titles: report only
  - semantic transitions such as block, unblock, complete, handoff, and reassignment: disabled

Environment:
  STENSIBLY_DB                SQLite database path (default: stensibly.sqlite)`;
}

function main(): void {
  try {
    const options = parseCustodianArgs(Bun.argv.slice(2));
    if (options.showHelp) {
      console.log(custodianUsage());
      return;
    }

    const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
    const store = new StensiblyStore(databasePath);
    try {
      const result = runCustodianPolicy(store, {
        ...(options.project === undefined ? {} : { project: options.project }),
        staleDays: options.staleDays,
        expiringWithinMinutes: options.expiringWithinMinutes,
        mode: options.mode,
        maxActions: options.maxActions,
      });
      console.log(JSON.stringify(result, null, 2));
      if (options.failOnFindings && reportHasFindings(result.report)) process.exitCode = 2;
    } finally {
      store.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} requires a number`);
  return parsed;
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} requires a whole number`);
  return parsed;
}

function parseMode(value: string): CustodianMode {
  if (value === "observe" || value === "dry-run" || value === "apply") return value;
  throw new Error("--mode must be observe, dry-run, or apply");
}

if (import.meta.main) main();
