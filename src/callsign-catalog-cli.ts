import {
  browseCallsignCatalog,
  buildCallsignReservationRequest,
  callsignAvailabilityStates,
  type BrowseCallsignCatalogInput,
  type BrowseCallsignCatalogResult,
  type CallsignReservationRequest,
  type CallsignReservationRequestInput,
} from "./callsign-catalog.ts";
import {
  baseCallsignCategories,
  callsignCollisionKey,
  type BaseCallsignCategory,
} from "./callsign-suggestions.ts";

export type ParsedCallsignCatalogCliArgs =
  | {
    help: boolean;
    json: boolean;
    command: "browse";
    input: BrowseCallsignCatalogInput;
  }
  | {
    help: boolean;
    json: boolean;
    command: "request";
    input: CallsignReservationRequestInput;
  };

export function parseCallsignCatalogCliArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): ParsedCallsignCatalogCliArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  const command = args[0] === "request" ? "request" : "browse";
  const commandArgs = args[0] === "browse" || args[0] === "request" ? args.slice(1) : args;
  return command === "request"
    ? parseRequestArgs(commandArgs, env, now)
    : parseBrowseArgs(commandArgs);
}

export function formatCallsignCatalogOutput(
  result: BrowseCallsignCatalogResult | CallsignReservationRequest,
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2);
  if ("entries" in result) {
    const rows = result.entries.map((entry) =>
      `${entry.callsign}\t${entry.category}\t${entry.state}${entry.previouslyUsed ? "\tpreviously-used" : ""}`
    );
    if (result.nextCursor) rows.push(`next-cursor\t${result.nextCursor}`);
    return rows.join("\n");
  }
  return [
    `Request ${result.requestedCallsign} (${result.collisionKey})`,
    `Workspace: ${result.workspace}`,
    `Worker session: ${result.workerSessionId}`,
    `Run: ${result.runId}`,
    `Expires: ${result.expiresAt}`,
    `Fingerprint: ${result.fingerprint}`,
    "Reservation accepted: false",
  ].join("\n");
}

export function callsignCatalogUsage(): string {
  return `Usage:
  bun run callsign-catalog -- browse [options]
  bun run callsign-catalog -- request <callsign> [options]

Browse the curated local catalog or build a typed reservation request. A request
remains unaccepted until a later durable server operation accepts it.

Browse options:
  --query <text>          Search display names and collision keys
  --category <names>     Comma-separated categories; repeatable
  --state <names>        Comma-separated availability states; repeatable
  --limit <1-100>        Page size (default: 25)
  --cursor <value>       Stable cursor from a prior result
  --json                 Emit typed JSON

Request options:
  --workspace <slug>     Workspace (default: STENSIBLY_WORKSPACE or default)
  --worker-session <id>  Worker session ID (or STENSIBLY_WORKER_SESSION)
  --run-id <run_...>     Exact run ID (or STENSIBLY_RUN_ID)
  --request-id <id>      Replay ID; defaults from run and collision key
  --requested-at <time>  ISO-8601 UTC time (default: current time)
  --expires-at <time>    Exact expiry; mutually exclusive with --ttl-seconds
  --ttl-seconds <n>      Lifetime from request time (default: 43200)
  --expected-generation <n>
  --inherit-from-run <run_...>
  --transfer-reference <id>
  --json                 Emit typed JSON

Categories: ${baseCallsignCategories.join(", ")}
States: ${callsignAvailabilityStates.join(", ")}`;
}

function parseBrowseArgs(args: string[]): ParsedCallsignCatalogCliArgs {
  let help = false;
  let json = false;
  let query: string | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  const categories: BaseCallsignCategory[] = [];
  const states: (typeof callsignAvailabilityStates)[number][] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--query") {
      query = requireValue(args, ++index, "--query");
      continue;
    }
    if (argument === "--limit") {
      limit = Number(requireValue(args, ++index, "--limit"));
      continue;
    }
    if (argument === "--cursor") {
      cursor = requireValue(args, ++index, "--cursor");
      continue;
    }
    if (argument === "--category") {
      categories.push(...splitList(requireValue(args, ++index, "--category")).map(parseCategory));
      continue;
    }
    if (argument === "--state") {
      states.push(...splitList(requireValue(args, ++index, "--state")).map(parseState));
      continue;
    }
    throw new Error(`Unknown browse argument: ${argument}`);
  }

  return {
    help,
    json,
    command: "browse",
    input: {
      ...(query === undefined ? {} : { query }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(categories.length === 0 ? {} : { categories }),
      ...(states.length === 0 ? {} : { states }),
    },
  };
}

function parseRequestArgs(
  args: string[],
  env: Record<string, string | undefined>,
  now: Date,
): ParsedCallsignCatalogCliArgs {
  let help = false;
  let json = false;
  let requestedCallsign: string | undefined;
  let workspace = env.STENSIBLY_WORKSPACE ?? "default";
  let workerSessionId = env.STENSIBLY_WORKER_SESSION;
  let runId = env.STENSIBLY_RUN_ID;
  let requestId = env.STENSIBLY_CALLSIGN_REQUEST_ID;
  let requestedAt = now.toISOString();
  let expiresAt: string | undefined;
  let ttlSeconds = 43_200;
  let ttlExplicit = false;
  let expectedGeneration: number | undefined;
  let inheritanceFromRun: string | undefined;
  let transferReference: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("--") && requestedCallsign === undefined) {
      requestedCallsign = argument;
      continue;
    }
    if (argument === "--workspace") {
      workspace = requireValue(args, ++index, "--workspace");
      continue;
    }
    if (argument === "--worker-session") {
      workerSessionId = requireValue(args, ++index, "--worker-session");
      continue;
    }
    if (argument === "--run-id") {
      runId = requireValue(args, ++index, "--run-id");
      continue;
    }
    if (argument === "--request-id") {
      requestId = requireValue(args, ++index, "--request-id");
      continue;
    }
    if (argument === "--requested-at") {
      requestedAt = requireValue(args, ++index, "--requested-at");
      continue;
    }
    if (argument === "--expires-at") {
      expiresAt = requireValue(args, ++index, "--expires-at");
      continue;
    }
    if (argument === "--ttl-seconds") {
      ttlSeconds = Number(requireValue(args, ++index, "--ttl-seconds"));
      ttlExplicit = true;
      continue;
    }
    if (argument === "--expected-generation") {
      expectedGeneration = Number(requireValue(args, ++index, "--expected-generation"));
      continue;
    }
    if (argument === "--inherit-from-run") {
      inheritanceFromRun = requireValue(args, ++index, "--inherit-from-run");
      continue;
    }
    if (argument === "--transfer-reference") {
      transferReference = requireValue(args, ++index, "--transfer-reference");
      continue;
    }
    throw new Error(`Unknown request argument: ${argument}`);
  }

  if (help) {
    return {
      help: true,
      json,
      command: "request",
      input: {
        workspace: "default",
        requestedCallsign: "Help",
        workerSessionId: "help",
        runId: "run_help",
        requestId: "help",
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 43_200_000).toISOString(),
      },
    };
  }
  if (!requestedCallsign) throw new Error("request requires a callsign");
  if (!workerSessionId) throw new Error("request requires --worker-session or STENSIBLY_WORKER_SESSION");
  if (!runId) throw new Error("request requires --run-id or STENSIBLY_RUN_ID");
  if (expiresAt && ttlExplicit) {
    throw new Error("--expires-at and --ttl-seconds cannot be used together");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 604_800) {
    throw new Error("--ttl-seconds must be an integer from 30 to 604800");
  }
  if ((inheritanceFromRun === undefined) !== (transferReference === undefined)) {
    throw new Error("inheritance requires both --inherit-from-run and --transfer-reference");
  }

  const canonicalRequestedAt = new Date(requestedAt);
  if (!Number.isFinite(canonicalRequestedAt.getTime())) {
    throw new Error("--requested-at must be an ISO-8601 timestamp");
  }
  const resolvedExpiresAt = expiresAt
    ?? new Date(canonicalRequestedAt.getTime() + ttlSeconds * 1_000).toISOString();
  const resolvedRequestId = requestId
    ?? `callsign:${runId}:${callsignCollisionKey(requestedCallsign)}`;

  return {
    help: false,
    json,
    command: "request",
    input: {
      workspace,
      requestedCallsign,
      workerSessionId,
      runId,
      requestId: resolvedRequestId,
      requestedAt,
      expiresAt: resolvedExpiresAt,
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      ...(inheritanceFromRun === undefined || transferReference === undefined
        ? {}
        : {
          inheritance: {
            fromRunId: inheritanceFromRun,
            transferReference,
          },
        }),
    },
  };
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseCategory(value: string): BaseCallsignCategory {
  const normalized = value.toLowerCase();
  if (!baseCallsignCategories.includes(normalized as BaseCallsignCategory)) {
    throw new Error(`Unknown callsign category: ${value}`);
  }
  return normalized as BaseCallsignCategory;
}

function parseState(value: string): (typeof callsignAvailabilityStates)[number] {
  const normalized = value.toLowerCase();
  if (!callsignAvailabilityStates.includes(normalized as (typeof callsignAvailabilityStates)[number])) {
    throw new Error(`Unknown callsign state: ${value}`);
  }
  return normalized as (typeof callsignAvailabilityStates)[number];
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  try {
    const parsed = parseCallsignCatalogCliArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(callsignCatalogUsage());
    } else if (parsed.command === "browse") {
      console.log(formatCallsignCatalogOutput(browseCallsignCatalog(parsed.input), parsed.json));
    } else {
      console.log(
        formatCallsignCatalogOutput(buildCallsignReservationRequest(parsed.input), parsed.json),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
