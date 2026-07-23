import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  tokenScopes,
  type TokenScope,
} from "./auth.ts";
import { StensiblyStore } from "./store.ts";

const args = Bun.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
  } else {
    const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
    const store = new StensiblyStore(databasePath);
    try {
      if (command === "create") {
        const options = parseCreateArgs(args.slice(1));
        const created = createApiToken(store, options);
        console.log(JSON.stringify(created, null, 2));
        console.error("Save the token now. Stensibly stores only its hash.");
      } else if (command === "list") {
        requireNoArgs(args.slice(1), "list");
        console.log(JSON.stringify(listApiTokens(store), null, 2));
      } else if (command === "revoke") {
        const id = args[1];
        if (!id || args.length !== 2) throw new Error("Usage: bun run tokens revoke <token-id>");
        console.log(JSON.stringify(revokeApiToken(store, id), null, 2));
      } else {
        throw new Error(`Unknown token command: ${command}`);
      }
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
      if (unknown.length > 0) throw new Error(`Unknown token scope: ${unknown.join(", ")}`);
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
  if (scopes.length === 0) throw new Error("create requires --scopes read, write, or admin");
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
  bun run tokens list
  bun run tokens revoke <token-id>

Examples:
  bun run tokens create --name local-agent --scopes read,write --projects scrapbook
  bun run tokens create --name observer --scopes read --all-projects
  bun run tokens revoke tok_abc123

Environment:
  STENSIBLY_DB  SQLite database path (default: stensibly.sqlite)`;
}
