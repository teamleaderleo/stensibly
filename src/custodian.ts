import { inspectScrapbook, reportHasFindings } from "./custodian-report.ts";
import { StensiblyStore } from "./store.ts";

interface CliOptions {
  project?: string;
  staleDays: number;
  expiringWithinMinutes: number;
  failOnFindings: boolean;
  showHelp: boolean;
}

try {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.showHelp) {
    console.log(usage());
  } else {
    const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
    const store = new StensiblyStore(databasePath);
    try {
      const report = inspectScrapbook(store, {
        ...(options.project ? { project: options.project } : {}),
        staleDays: options.staleDays,
        expiringWithinMinutes: options.expiringWithinMinutes,
      });
      console.log(JSON.stringify(report, null, 2));
      if (options.failOnFindings && reportHasFindings(report)) process.exitCode = 2;
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    staleDays: 7,
    expiringWithinMinutes: 5,
    failOnFindings: false,
    showHelp: false,
  };

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
      options.staleDays = parseNumber(requireValue(args, ++index, "--stale-days"), "--stale-days");
      continue;
    }
    if (argument === "--expiring-within") {
      options.expiringWithinMinutes = parseNumber(
        requireValue(args, ++index, "--expiring-within"),
        "--expiring-within",
      );
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.project && !/^[a-z0-9][a-z0-9-_]*$/.test(options.project)) {
    throw new Error("--project must be a lowercase project slug");
  }
  return options;
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

function usage(): string {
  return `Stensibly custodian

Usage:
  bun run custodian [options]

Options:
  --project <slug>          Inspect one project
  --stale-days <days>       Flag ready or blocked work older than this (default: 7)
  --expiring-within <mins>  Flag live claims expiring within this window (default: 5)
  --fail-on-findings        Exit with status 2 when the report contains findings
  --help                    Show this help

Environment:
  STENSIBLY_DB              SQLite database path (default: stensibly.sqlite)`;
}
