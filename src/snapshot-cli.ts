import { createHash } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.js";
import { createConvexWorkLedgerFromEnv } from "./convex-ledger.js";
import {
  exportSqliteSnapshot,
  parseSnapshot,
  type StensiblySnapshot,
} from "./snapshot.js";
import { StensiblyStore } from "./store.js";

const args = Bun.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
  } else if (command === "export") {
    await exportCommand(args.slice(1));
  } else if (command === "import") {
    await importCommand(args.slice(1));
  } else {
    throw new Error(`Unknown snapshot command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function exportCommand(args: string[]): Promise<void> {
  let output = "stensibly-snapshot.json";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out") {
      output = requireValue(args, ++index, "--out");
      continue;
    }
    throw new Error(`Unknown export argument: ${argument}`);
  }

  const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
  const store = new StensiblyStore(databasePath);
  try {
    const snapshot = exportSqliteSnapshot(store);
    const json = `${JSON.stringify(snapshot, null, 2)}\n`;
    await Bun.write(output, json);
    console.log(JSON.stringify({
      output,
      sha256: createHash("sha256").update(json).digest("hex"),
      counts: snapshotCounts(snapshot),
    }, null, 2));
    console.error("The snapshot contains token hashes. Keep it private and delete it after migration.");
  } finally {
    store.close();
  }
}

async function importCommand(args: string[]): Promise<void> {
  let file: string | undefined;
  let batchSize = 50;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--file") {
      file = requireValue(args, ++index, "--file");
      continue;
    }
    if (argument === "--batch-size") {
      batchSize = Number(requireValue(args, ++index, "--batch-size"));
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
        throw new Error("--batch-size must be an integer between 1 and 100");
      }
      continue;
    }
    throw new Error(`Unknown import argument: ${argument}`);
  }
  if (!file) throw new Error("import requires --file <snapshot.json>");

  const raw = await Bun.file(file).json();
  const snapshot = parseSnapshot(raw);
  const ledger = createConvexWorkLedgerFromEnv();
  const base = {
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  };
  const results: Array<Record<string, unknown>> = [];

  const identityBatches = Math.max(
    Math.ceil(snapshot.projects.length / batchSize),
    Math.ceil(snapshot.actors.length / batchSize),
  );
  for (let index = 0; index < identityBatches; index += 1) {
    results.push(await mutate(ledger.client, convexApi.migration.importProjectsActors, {
      ...base,
      projects: slice(snapshot.projects, index, batchSize),
      actors: slice(snapshot.actors, index, batchSize),
    }));
  }
  for (const items of chunks(snapshot.items, batchSize)) {
    results.push(await mutate(ledger.client, convexApi.migration.importItems, {
      ...base,
      items,
    }));
  }
  for (const events of chunks(snapshot.events, batchSize)) {
    results.push(await mutate(ledger.client, convexApi.migration.importEvents, {
      ...base,
      events,
    }));
  }
  for (const artifacts of chunks(snapshot.artifacts, batchSize)) {
    results.push(await mutate(ledger.client, convexApi.migration.importArtifacts, {
      ...base,
      artifacts,
    }));
  }
  for (const tokens of chunks(snapshot.tokens, batchSize)) {
    results.push(await mutate(ledger.client, convexApi.migration.importTokens, {
      ...base,
      tokens,
    }));
  }

  const remoteItems = await ledger.listWork();
  const sourceIds = new Set(snapshot.items.map((item) => item.id));
  const importedIds = new Set(remoteItems.map((item) => item.id));
  const missing = [...sourceIds].filter((id) => !importedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Import verification failed; missing items: ${missing.slice(0, 10).join(", ")}`);
  }

  console.log(JSON.stringify({
    file,
    workspace: ledger.workspace,
    counts: snapshotCounts(snapshot),
    verifiedItems: sourceIds.size,
    batches: results,
  }, null, 2));
}

async function mutate(
  client: { mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown> },
  reference: FunctionReference<"mutation">,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.mutation(reference, args);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { result };
  }
  return result as Record<string, unknown>;
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function slice<T>(values: T[], index: number, size: number): T[] {
  return values.slice(index * size, (index + 1) * size);
}

function snapshotCounts(snapshot: StensiblySnapshot) {
  return {
    projects: snapshot.projects.length,
    actors: snapshot.actors.length,
    items: snapshot.items.length,
    events: snapshot.events.length,
    artifacts: snapshot.artifacts.length,
    tokens: snapshot.tokens.length,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return `Stensibly snapshots

Usage:
  bun run snapshot export [--out stensibly-snapshot.json]
  bun run snapshot import --file stensibly-snapshot.json [--batch-size 50]

Export environment:
  STENSIBLY_DB              SQLite database path (default: stensibly.sqlite)

Import environment:
  CONVEX_URL                Convex deployment URL
  STENSIBLY_SERVICE_SECRET  Private Convex gateway secret
  STENSIBLY_WORKSPACE       Target workspace slug (default: default)`;
}
