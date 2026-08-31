import { tokenScopes, type TokenScope } from "./auth.js";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { runnerCredentialTools } from "./token-contracts.js";
import { createConvexWorkLedgerFromEnv } from "./convex-ledger.js";
import { SqliteTokenProvider } from "./sqlite-token-provider.js";
import { StensiblyStore } from "./store.js";
import {
  ConvexTokenProvider,
  type ApiTokenManager,
} from "./token-provider.js";

const oneShotWorkstationTools = runnerCredentialTools.filter((tool) =>
  tool !== "heartbeat_runner_run"
);

const args = Bun.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
  } else {
    const { provider, close, description } = createProvider();
    try {
      if (command === "create") {
        const options = parseCreateArgs(args.slice(1));
        const created = await provider.create(options);
        console.log(JSON.stringify(created, null, 2));
        console.error("Save the token now. Stensibly stores only its hash.");
      } else if (command === "create-runner") {
        const options = parseCreateRunnerArgs(args.slice(1));
        const created = await provider.create({
          name: options.name,
          scopes: ["write"],
          projects: [options.project],
          runnerGrant: {
            version: 1,
            actorId: options.actorId,
            runnerType: options.runnerType,
            adapterId: options.adapterId,
            profiles: options.profiles,
            tools: [...oneShotWorkstationTools],
          },
        });
        try {
          await writePrivateToken(options.outputFile, created.token);
        } catch {
          await provider.revoke(created.id).catch(() => undefined);
          throw new Error("Runner token installation failed; the registered token was revoked");
        }
        const { token: _secret, ...record } = created;
        console.log(JSON.stringify({ ...record, installed: true }, null, 2));
      } else if (command === "list") {
        requireNoArgs(args.slice(1), "list");
        console.log(JSON.stringify(await provider.list(), null, 2));
      } else if (command === "revoke") {
        const id = args[1];
        if (!id || args.length !== 2) {
          throw new Error("Usage: bun run tokens revoke <token-id>");
        }
        console.log(JSON.stringify(await provider.revoke(id), null, 2));
      } else {
        throw new Error(`Unknown token command: ${command}`);
      }
      console.error(`Token authority: ${description}`);
    } finally {
      close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseCreateRunnerArgs(args: string[]): {
  name: string;
  project: string;
  actorId: string;
  runnerType: string;
  adapterId: string;
  profiles: string[];
  outputFile: string;
} {
  const values = new Map<string, string>();
  const supported = new Set([
    "--name", "--project", "--actor-id", "--runner-type", "--adapter-id",
    "--profiles", "--output-file",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag || !supported.has(flag)) throw new Error(`Unknown create-runner argument: ${flag ?? "missing"}`);
    if (values.has(flag)) throw new Error(`Duplicate create-runner argument: ${flag}`);
    values.set(flag, requireValue(args, index + 1, flag));
  }
  const outputFile = values.get("--output-file") ?? "";
  if (!isAbsolute(outputFile)) throw new Error("--output-file must be an absolute path");
  const profiles = (values.get("--profiles") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (profiles.length === 0) throw new Error("--profiles requires at least one named profile");
  return {
    name: values.get("--name") ?? "",
    project: values.get("--project") ?? "",
    actorId: values.get("--actor-id") ?? "",
    runnerType: values.get("--runner-type") ?? "",
    adapterId: values.get("--adapter-id") ?? "",
    profiles,
    outputFile,
  };
}

async function writePrivateToken(path: string, token: string): Promise<void> {
  const parent = dirname(path);
  const metadata = await stat(parent);
  if (
    !metadata.isDirectory()
    || await realpath(parent) !== parent
    || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o077) !== 0
  ) throw new Error("Runner token parent must be a canonical owner-only directory");
  let created = false;
  try {
    const file = await open(path, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(`${token}\n`, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (created) await unlink(path).catch(() => undefined);
    throw error;
  }
}

function createProvider(): {
  provider: ApiTokenManager;
  close: () => void;
  description: string;
} {
  const backend = Bun.env.STENSIBLY_BACKEND ?? "sqlite";
  if (backend === "convex") {
    const ledger = createConvexWorkLedgerFromEnv();
    return {
      provider: new ConvexTokenProvider({
        client: ledger.client,
        serviceSecret: ledger.serviceSecret,
        workspace: ledger.workspace,
      }),
      close: () => {},
      description: `Convex workspace ${ledger.workspace}`,
    };
  }
  if (backend === "sqlite") {
    const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
    const store = new StensiblyStore(databasePath);
    return {
      provider: new SqliteTokenProvider(store),
      close: () => store.close(),
      description: `SQLite ${databasePath}`,
    };
  }
  throw new Error(`Unknown STENSIBLY_BACKEND: ${backend}`);
}

function parseCreateArgs(args: string[]): {
  name: string;
  scopes: TokenScope[];
  projects?: string[] | null;
} {
  let name: string | undefined;
  let scopes: TokenScope[] = [];
  let projects: string[] | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--name") {
      name = requireValue(args, ++index, "--name");
      continue;
    }
    if (argument === "--scopes") {
      const requested = requireValue(args, ++index, "--scopes")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      const unknown = requested.filter((scope) =>
        !tokenScopes.includes(scope as TokenScope),
      );
      if (unknown.length > 0) {
        throw new Error(`Unknown token scope: ${unknown.join(", ")}`);
      }
      scopes = requested as TokenScope[];
      continue;
    }
    if (argument === "--projects") {
      projects = requireValue(args, ++index, "--projects")
        .split(",")
        .map((project) => project.trim())
        .filter(Boolean);
      continue;
    }
    if (argument === "--all-projects") {
      projects = null;
      continue;
    }
    throw new Error(`Unknown create argument: ${argument}`);
  }

  if (!name) throw new Error("create requires --name");
  if (scopes.length === 0) {
    throw new Error("create requires --scopes read, write, or admin");
  }
  return { name, scopes, projects };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function requireNoArgs(args: string[], commandName: string): void {
  if (args.length > 0) throw new Error(`${commandName} accepts no arguments`);
}

function usage(): string {
  return `Stensibly API tokens

Usage:
  bun run tokens create --name <name> --scopes <read,write,admin> [--projects <a,b>]
  bun run tokens create-runner --name <name> --project <project> --actor-id <actor> \\
    --runner-type <type> --adapter-id <adapter> --profiles <profile,...> \\
    --output-file <absolute-owner-only-path>
  bun run tokens list
  bun run tokens revoke <token-id>

Examples:
  bun run tokens create --name local-agent --scopes read,write --projects scrapbook
  bun run tokens create --name observer --scopes read --all-projects
  bun run tokens revoke tok_abc123

Environment:
  STENSIBLY_BACKEND         sqlite (default) or convex
  STENSIBLY_DB              SQLite database path (default: stensibly.sqlite)
  CONVEX_URL                Convex deployment URL when backend=convex
  STENSIBLY_SERVICE_SECRET  Private Convex gateway secret
  STENSIBLY_WORKSPACE       Convex workspace slug (default: default)`;
}
