import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assessCallsign,
  defaultNamegenVibe,
  namegenVibePools,
  namegenVibes,
  proposeCallsigns,
  resolveVibe,
  type NamegenVibe,
  type NamegenAssessment,
  type NamegenProposalResult,
} from "./callsign-namegen.js";
import { callsignSigil } from "./callsign-sigils.js";
import {
  parseGitHubCallsignReceipt,
  projectGitHubCallsignRegistry,
  type ParsedGitHubCallsignReceipt,
} from "./github-callsign-registry.js";

/**
 * `namegen propose | check | derive`: pick a free, distinctive callsign and
 * show the sigil and collision key the #454 registrar will derive for it.
 *
 * Read-only. It never posts the reserve command; the registrar's receipt is
 * the only thing that makes a name held.
 */

export const defaultRegistryRepository = "teamleaderleo/stensibly";
export const defaultRegistryIssue = 454;
const registrarLogin = "github-actions[bot]";
export const defaultRecentDays = 14;

export type NamegenSubcommand = "propose" | "check" | "derive";

export interface NamegenCliArgs {
  subcommand: NamegenSubcommand | "help";
  names: string[];
  json: boolean;
  offline: boolean;
  registryFile: string | null;
  repository: string;
  issue: number;
  recentDays: number;
  count: number;
  seed: string | undefined;
  run: string | undefined;
  session: string | undefined;
  ttl: string;
  avoid: string[];
  /** Explicit --vibe; the effective vibe comes from resolveVibeChoice. */
  vibe: string | undefined;
}

export interface VibeChoice {
  vibe: NamegenVibe;
  source: "flag" | "env" | "repo" | "user" | "default";
  path?: string;
}

export interface RegistrySnapshot {
  source: string;
  evaluatedAt: string;
  active: Array<{ callsign: string; sigil: string; generation: number; runId: string; expiresAt: string }>;
  /** Active names plus names accepted or released inside the recent window. */
  taken: string[];
  /** Every name the registrar has ever accepted, for exact and sound-alike checks. */
  history: string[];
}

export interface IssueComment {
  id: number;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
}

export function parseNamegenArgs(
  rawArgs: readonly string[],
  env: Record<string, string | undefined> = process.env,
): NamegenCliArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  const parsed: NamegenCliArgs = {
    subcommand: "propose",
    names: [],
    json: false,
    offline: false,
    registryFile: null,
    repository: defaultRegistryRepository,
    issue: defaultRegistryIssue,
    recentDays: defaultRecentDays,
    count: 1,
    seed: undefined,
    run: env.CALLSIGN_RUN_ID,
    session: env.CALLSIGN_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_SESSION_ID,
    ttl: "24h",
    avoid: [],
    vibe: undefined,
  };
  let subcommandSeen = false;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? "";
    if (optionsEnded || !raw.startsWith("-")) {
      if (
        !subcommandSeen && !optionsEnded && parsed.names.length === 0
        && (raw === "propose" || raw === "check" || raw === "derive" || raw === "help")
      ) {
        parsed.subcommand = raw;
        subcommandSeen = true;
        continue;
      }
      parsed.names.push(raw);
      continue;
    }
    if (raw === "--") {
      optionsEnded = true;
      continue;
    }
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const argument = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const flag = (): void => {
      if (inline !== undefined) throw new Error(`${argument} takes no value`);
    };
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case "--help":
      case "-h":
        flag();
        parsed.subcommand = "help";
        break;
      case "--json":
        flag();
        parsed.json = true;
        break;
      case "--offline":
        flag();
        parsed.offline = true;
        break;
      case "--registry-file":
        parsed.registryFile = value();
        break;
      case "--repo":
        parsed.repository = value();
        break;
      case "--issue":
        parsed.issue = positiveInteger(value(), "--issue");
        break;
      case "--recent-days":
        parsed.recentDays = positiveInteger(value(), "--recent-days");
        break;
      case "--count":
        parsed.count = positiveInteger(value(), "--count");
        break;
      case "--seed":
        parsed.seed = value();
        break;
      case "--run":
        parsed.run = value();
        break;
      case "--session":
        parsed.session = value();
        break;
      case "--vibe":
        parsed.vibe = value();
        break;
      case "--ttl":
        parsed.ttl = value();
        break;
      case "--avoid":
        parsed.avoid.push(...value().split(",").map((entry) => entry.trim()).filter(Boolean));
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (parsed.subcommand === "propose" && parsed.names.length > 0) {
    throw new Error(`propose takes no names; did you mean: namegen check ${parsed.names.join(" ")}`);
  }
  if ((parsed.subcommand === "check" || parsed.subcommand === "derive") && parsed.names.length === 0) {
    throw new Error(`${parsed.subcommand} needs at least one callsign`);
  }
  return parsed;
}

/**
 * Registry snapshot from registrar receipts, using the registrar's own parser
 * and lease projection so namegen never re-implements lease semantics.
 */
/** Registrar receipts among issue comments, oldest first, parsed by the registrar's own parser. */
export function registrarReceipts(comments: readonly IssueComment[]): ParsedGitHubCallsignReceipt[] {
  const receipts: ParsedGitHubCallsignReceipt[] = [];
  for (const comment of comments) {
    if (comment.user?.login !== registrarLogin || !comment.body) continue;
    if (!comment.body.trimStart().startsWith("callsign-receipt/v0")) continue;
    try {
      receipts.push(parseGitHubCallsignReceipt({
        body: comment.body,
        commentId: comment.id,
        commentUrl: comment.html_url,
      }));
    } catch {
      // The registrar ignores malformed receipts too.
    }
  }
  return receipts.sort((left, right) => left.commentId - right.commentId);
}

export function registrySnapshotFromComments(
  comments: readonly IssueComment[],
  input: { source: string; evaluatedAt: string; recentDays: number },
): RegistrySnapshot {
  return registrySnapshotFromReceipts(registrarReceipts(comments), input);
}

export function registrySnapshotFromReceipts(
  receipts: readonly ParsedGitHubCallsignReceipt[],
  input: { source: string; evaluatedAt: string; recentDays: number },
): RegistrySnapshot {
  const projection = projectGitHubCallsignRegistry(receipts, input.evaluatedAt);
  const cutoff = Date.parse(projection.evaluatedAt) - input.recentDays * 24 * 60 * 60 * 1_000;
  const taken = new Set(projection.activeLeases.map((lease) => lease.callsign));
  const history = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.callsign === null || receipt.status === "rejected") continue;
    history.add(receipt.callsign);
    const at = Date.parse(receipt.acceptedAt ?? receipt.releasedAt ?? "");
    if (Number.isFinite(at) && at >= cutoff) taken.add(receipt.callsign);
  }
  return {
    source: input.source,
    evaluatedAt: projection.evaluatedAt,
    active: projection.activeLeases.map((lease) => ({
      callsign: lease.callsign,
      sigil: lease.sigil,
      generation: lease.generation,
      runId: lease.runId,
      expiresAt: lease.expiresAt,
    })),
    taken: [...taken].sort(),
    history: [...history].sort(),
  };
}

/**
 * The effective vibe: --vibe, then CALLSIGN_VIBE, then the nearest
 * `.callsign.json` above the working directory (a team's repo), then the
 * user's `$XDG_CONFIG_HOME/callsign/config.json`, then the default.
 */
export function resolveVibeChoice(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
  readJson: (path: string) => unknown = defaultReadJson,
): VibeChoice {
  if (flag !== undefined) return { vibe: resolveVibe(flag), source: "flag" };
  if (env.CALLSIGN_VIBE) return { vibe: resolveVibe(env.CALLSIGN_VIBE), source: "env" };
  // Walk up to the repository root only, so a stray file in an unrelated
  // ancestor (such as $HOME) never overrides a repository without one.
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const path = join(directory, ".callsign.json");
    const vibe = configuredVibe(readJson(path), path);
    if (vibe !== undefined) return { vibe, source: "repo", path };
    if (isRepositoryRoot(directory) || dirname(directory) === directory) break;
  }
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const userPath = join(configHome, "callsign", "config.json");
  const userVibe = configuredVibe(readJson(userPath), userPath);
  if (userVibe !== undefined) return { vibe: userVibe, source: "user", path: userPath };
  return { vibe: defaultNamegenVibe, source: "default" };
}

function configuredVibe(config: unknown, path: string): NamegenVibe | undefined {
  if (config === undefined) return undefined;
  const vibe = typeof config === "object" && config !== null ? (config as { vibe?: unknown }).vibe : undefined;
  if (vibe === undefined) return undefined;
  if (typeof vibe !== "string") throw new Error(`${path}: "vibe" must be a string`);
  try {
    return resolveVibe(vibe);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

function defaultReadJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function isRepositoryRoot(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}

export function reserveCommand(input: {
  callsign: string;
  run: string | undefined;
  session: string | undefined;
  ttl: string;
}): string {
  return [
    `/callsign reserve ${input.callsign}`,
    `run: ${input.run ?? "run_<unique-run-id>"}`,
    `session: ${input.session ?? "<unique-worker-session-id>"}`,
    `ttl: ${input.ttl}`,
  ].join("\n");
}

export function formatProposal(
  result: NamegenProposalResult,
  args: NamegenCliArgs,
  snapshot: RegistrySnapshot | null,
  vibe: VibeChoice = { vibe: result.vibe, source: "default" },
): string {
  const [best, ...alternates] = result.proposals;
  if (!best) throw new Error("No proposal to format");
  const lines = [
    `${best.callsign} ${best.sigil}  (collision key ${best.collisionKey})`,
    ...(best.vibe === result.vibe ? [] : [`The ${result.vibe} pool is used up, so this comes from ${best.vibe}.`]),
    ...(best.nearCollisionRulesRelaxed
      ? ["Every pool is used up under the near-collision rules; this name only avoids same-word matches."]
      : []),
    "",
    `Reserve it with this comment on https://github.com/${args.repository}/issues/${args.issue}:`,
    "",
    reserveCommand({ callsign: best.callsign, run: args.run, session: args.session, ttl: args.ttl }),
    "",
    `Sign as: — ${best.callsign} g<generation from the receipt> ${best.sigil}`,
  ];
  if (alternates.length > 0) {
    lines.push("", `Alternates: ${alternates.map((entry) => `${entry.callsign} ${entry.sigil}`).join(", ")}`);
  }
  const others = namegenVibes.filter((entry) => entry !== vibe.vibe);
  lines.push(
    "",
    `Vibe: ${vibe.vibe} (${vibe.source === "default" ? "default" : vibe.path ?? `from ${vibe.source}`}); `
      + `also ${others.map((entry) => `--vibe ${entry}`).join(", ")}. ${namegenVibePools[vibe.vibe].description}`,
    registryLine(snapshot),
  );
  if (result.seedSource === "random") {
    lines.push("Seed: random; pass --run and --session to replay the same proposal.");
  }
  return lines.join("\n");
}

export function formatAssessment(assessment: NamegenAssessment): string {
  const lines = [
    `${assessment.callsign} ${assessment.sigil}  (collision key ${assessment.collisionKey}, ${assessment.sigilSource} sigil)`,
  ];
  for (const conflict of assessment.conflicts) {
    lines.push(`  conflict: ${conflict.kind} with ${conflict.callsign}`);
  }
  for (const issue of assessment.issues) {
    lines.push(`  ${issue.kind}: ${issue.detail}`);
  }
  if (assessment.conflicts.length === 0 && assessment.issues.length === 0) lines.push("  clear");
  return lines.join("\n");
}

export function namegenUsage(): string {
  return `Usage: namegen [propose|check|derive] [options] [callsign...]

Propose a free, distinctive callsign for the #454 registry and derive the sigil and
collision key the registrar will stamp on its receipt. Read-only: post the printed
reserve command yourself; only the registrar's receipt makes a name held.

Commands:
  propose            Print the best free name (default command)
  check <name...>    Report conflicts with taken names and readability issues
  derive <name...>   Print collision key and sigil only (no registry read)

Options:
  --run <id>          Run id; seeds the proposal and fills the reserve command
  --session <id>      Session id (defaults to CALLSIGN_SESSION_ID, CLAUDE_CODE_SESSION_ID
                      or CODEX_SESSION_ID); seeds the proposal
  --seed <text>       Explicit replay seed instead of run and session
  --count <1-20>      Number of proposals (default 1)
  --vibe <name>       Word pool: ${namegenVibes.map((vibe) => `${vibe}${vibe === defaultNamegenVibe ? " (default)" : ""}`).join(", ")}.
                      Also CALLSIGN_VIBE, a {"vibe": "..."} .callsign.json in the repo,
                      or $XDG_CONFIG_HOME/callsign/config.json. Sigils never depend on it.
  --ttl <hours>h      TTL in the printed reserve command (default 24h)
  --avoid <names>     Extra comma-separated names to stay clear of; repeatable
  --recent-days <n>   Avoid near-collisions with names used in the last n days
                      (default ${defaultRecentDays}); older names are avoided only when
                      they are the same word (exact, look-alike, sound-alike)
  --offline           Skip the registry read (proposals may collide)
  --registry-file <f> Read issue comments JSON (gh api output) instead of GitHub
  --repo <owner/repo> Registry repository (default ${defaultRegistryRepository})
  --issue <n>         Registry issue (default ${defaultRegistryIssue})
  --json              Emit the typed result as JSON

Exit status: 0 ok, 1 error, 2 check found a conflict or issue.`;
}

export function runNamegen(
  args: NamegenCliArgs,
  io: {
    readRegistry: (args: NamegenCliArgs) => IssueComment[];
    now: () => Date;
    vibe?: () => VibeChoice;
  },
): { output: string; exitCode: number } {
  if (args.subcommand === "help") return { output: namegenUsage(), exitCode: 0 };

  if (args.subcommand === "derive") {
    const derived = args.names.map((name) => {
      const sigil = callsignSigil(name);
      return { callsign: sigil.callsign, collisionKey: sigil.collisionKey, sigil: sigil.sigil, sigilSource: sigil.source };
    });
    return {
      output: args.json
        ? JSON.stringify(derived, null, 2)
        : derived.map((entry) => `${entry.callsign}\t${entry.sigil}\t${entry.collisionKey}\t${entry.sigilSource}`).join("\n"),
      exitCode: 0,
    };
  }

  const snapshot = args.offline && args.registryFile === null
    ? null
    : registrySnapshotFromComments(io.readRegistry(args), {
      source: args.registryFile ?? `https://github.com/${args.repository}/issues/${args.issue}`,
      evaluatedAt: io.now().toISOString(),
      recentDays: args.recentDays,
    });
  const taken = [...(snapshot?.taken ?? []), ...args.avoid];
  const history = snapshot?.history ?? [];

  if (args.subcommand === "check") {
    const assessments = args.names.map((name) => assessCallsign(name, taken, history));
    const flagged = assessments.some((entry) => entry.conflicts.length > 0 || entry.issues.length > 0);
    return {
      output: args.json
        ? JSON.stringify({ registry: snapshotSummary(snapshot), assessments }, null, 2)
        : [...assessments.map(formatAssessment), "", registryLine(snapshot)].join("\n"),
      exitCode: flagged ? 2 : 0,
    };
  }

  const vibe = io.vibe?.() ?? { vibe: resolveVibe(args.vibe), source: args.vibe === undefined ? "default" : "flag" };
  const result = proposeCallsigns({
    vibe: vibe.vibe,
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args.run === undefined ? {} : { run: args.run }),
    ...(args.session === undefined ? {} : { session: args.session }),
    taken,
    history,
    activeSigils: snapshot?.active.map((lease) => lease.sigil) ?? [],
    count: args.count,
  });
  return {
    output: args.json
      ? JSON.stringify({
        ...result,
        vibeSource: vibe.source,
        registry: snapshotSummary(snapshot),
        reserveCommand: reserveCommand({
          callsign: result.proposals[0]?.callsign ?? "",
          run: args.run,
          session: args.session,
          ttl: args.ttl,
        }),
      }, null, 2)
      : formatProposal(result, args, snapshot, vibe),
    exitCode: 0,
  };
}

function snapshotSummary(snapshot: RegistrySnapshot | null) {
  if (snapshot === null) return { consulted: false };
  return {
    consulted: true,
    source: snapshot.source,
    evaluatedAt: snapshot.evaluatedAt,
    activeCount: snapshot.active.length,
    recentCount: snapshot.taken.length,
    historyCount: snapshot.history.length,
  };
}

function registryLine(snapshot: RegistrySnapshot | null): string {
  if (snapshot === null) return "Registry not consulted (--offline); the name may already be held.";
  return `Checked against ${snapshot.active.length} active, ${snapshot.taken.length} recent and ${snapshot.history.length} past names on ${snapshot.source} at ${snapshot.evaluatedAt}.`;
}

function readRegistryWithGh(args: NamegenCliArgs): IssueComment[] {
  if (args.registryFile !== null) {
    return JSON.parse(readFileSync(args.registryFile, "utf8")) as IssueComment[];
  }
  return readRegistryComments(args.repository, args.issue);
}

/** Every comment on the registry issue, through the caller's `gh` login. */
export function readRegistryComments(repository: string, issue: number): IssueComment[] {
  let raw: string;
  try {
    raw = execFileSync("gh", [
      "api",
      `repos/${repository}/issues/${issue}/comments?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | @json",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`Could not read the registry with gh (${detail}). Retry, or pass --offline to propose without it.`);
  }
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as IssueComment);
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
  return number;
}

if (import.meta.main) {
  try {
    const args = parseNamegenArgs(process.argv.slice(2));
    const { output, exitCode } = runNamegen(args, {
      readRegistry: readRegistryWithGh,
      now: () => new Date(),
      vibe: () => resolveVibeChoice(args.vibe, process.env, process.cwd()),
    });
    console.log(output);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
