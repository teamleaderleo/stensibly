/**
 * One-command callsign session lifecycle for workers.
 *
 * Wraps the #454 dogfood registry so a worker never hand-writes the command
 * grammar, invents a name, tracks its generation, or polls for a receipt:
 *
 *   callsign start --scope cmux-ci        reserve a fresh name, wait for the receipt
 *   callsign sign                          print the signature block for a comment
 *   callsign status                        active leases, read-only
 *   callsign end                           release the lease this session holds
 *
 * A callsign remains presentation/attribution metadata only. Reserving one
 * grants no authority, capability, continuity, or approval.
 */
import { homedir, hostname } from "node:os";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  parseGitHubCallsignReceipt,
  projectGitHubCallsignRegistry,
  type GitHubCallsignActiveLease,
  type ParsedGitHubCallsignReceipt,
} from "./github-callsign-registry.js";
import { suggestCallsigns } from "./callsign-suggestions.js";

const defaultRepository = "teamleaderleo/stensibly";
const defaultIssueNumber = 454;
const registrarLogin = "github-actions[bot]";
const receiptPollIntervalMs = 5_000;
const receiptTimeoutMs = 180_000;
const reserveAttempts = 4;

export interface SessionState {
  version: 1;
  repository: string;
  issueNumber: number;
  callsign: string;
  sigil: string;
  collisionKey: string;
  generation: number;
  runId: string;
  sessionId: string;
  acceptedAt: string;
  expiresAt: string;
  receiptCommentUrl: string;
  requestCommentUrl: string;
}

function statePath(): string {
  const base = process.env.CALLSIGN_STATE_DIR
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "callsign");
  return join(base, "session.json");
}

async function readState(): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as SessionState;
  } catch {
    return null;
  }
}

async function writeState(state: SessionState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearState(): Promise<void> {
  await rm(statePath(), { force: true });
}

async function gh(args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout;
}

/** Every registrar receipt on the registry issue, oldest first. */
async function fetchReceipts(
  repository: string,
  issueNumber: number,
): Promise<ParsedGitHubCallsignReceipt[]> {
  const raw = await gh([
    "api",
    `repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
    "--paginate",
    "--jq",
    ".[] | @json",
  ]);
  const receipts: ParsedGitHubCallsignReceipt[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const comment = JSON.parse(line) as {
      id: number;
      html_url: string;
      body: string;
      user: { login: string };
    };
    if (comment.user.login !== registrarLogin) continue;
    try {
      receipts.push(parseGitHubCallsignReceipt({
        body: comment.body,
        commentId: comment.id,
        commentUrl: comment.html_url,
      }));
    } catch {
      // Not a receipt (status output, unrelated bot comment). Ignore.
    }
  }
  return receipts.sort((left, right) => left.commentId - right.commentId);
}

/**
 * Names never used before, ordered best-first.
 *
 * Avoids every collision key the registry has ever issued, not merely the
 * active ones, so a name is not recycled while its history is still legible.
 */
export function proposeCallsigns(
  receipts: readonly ParsedGitHubCallsignReceipt[],
  count: number,
  categories?: readonly string[],
): string[] {
  const avoid = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.callsign) avoid.add(receipt.callsign);
    if (receipt.collisionKey) avoid.add(receipt.collisionKey);
  }
  const result = suggestCallsigns({
    count,
    avoid: [...avoid],
    ...(categories && categories.length > 0
      ? { categories: categories as never }
      : {}),
  });
  return result.suggestions.map((suggestion) => suggestion.callsign);
}

export function slug(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return cleaned.length === 0 ? "session" : cleaned.slice(0, 80);
}

export function deriveRunId(scope: string | undefined): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/gu, "");
  return `run_${slug(scope ?? "worker")}_${stamp}_${randomBytes(4).toString("hex")}`;
}

export function deriveSessionId(scope: string | undefined): string {
  const provided = process.env.CALLSIGN_SESSION_ID
    ?? process.env.CLAUDE_SESSION_ID
    ?? process.env.CODEX_SESSION_ID;
  if (provided) return slug(provided).slice(0, 160).replace(/^$/u, "session");
  return `${slug(hostname())}-${slug(scope ?? "worker")}-${randomBytes(5).toString("hex")}`
    .slice(0, 160);
}

async function postComment(
  repository: string,
  issueNumber: number,
  body: string,
): Promise<string> {
  const out = await gh(
    ["issue", "comment", String(issueNumber), "--repo", repository, "--body-file", "-"],
    body,
  );
  const url = out.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`Could not read comment URL from gh output: ${out}`);
  return url;
}

/** Waits for the registrar's canonical receipt for exactly this request. */
async function awaitReceipt(
  repository: string,
  issueNumber: number,
  requestCommentUrl: string,
): Promise<ParsedGitHubCallsignReceipt> {
  const deadline = Date.now() + receiptTimeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(receiptPollIntervalMs);
    const receipts = await fetchReceipts(repository, issueNumber);
    const match = receipts.find((receipt) => receipt.requestComment === requestCommentUrl);
    if (match) return match;
  }
  throw new Error(
    `No registrar receipt for ${requestCommentUrl} within ${receiptTimeoutMs / 1000}s. `
      + "The registry may be down; do not assume the callsign is held.",
  );
}

export function signatureBlock(state: SessionState): string {
  return `— ${state.callsign} g${state.generation} ${state.sigil}\nRun: ${state.runId}`;
}

function describeLease(lease: GitHubCallsignActiveLease): string {
  return `${lease.callsign} g${lease.generation} ${lease.sigil}  `
    + `run=${lease.runId}  expires=${lease.expiresAt}`;
}

async function commandStart(args: Map<string, string>, flags: Set<string>): Promise<number> {
  const repository = args.get("repo") ?? defaultRepository;
  const issueNumber = Number(args.get("issue") ?? defaultIssueNumber);
  const existing = await readState();
  if (existing && !flags.has("force") && Date.parse(existing.expiresAt) > Date.now()) {
    process.stderr.write(
      `Already holding ${existing.callsign} g${existing.generation} until ${existing.expiresAt}.\n`
        + "Use --force to reserve another, or `callsign end` to release it first.\n",
    );
    process.stdout.write(`${signatureBlock(existing)}\n`);
    return 0;
  }

  const scope = args.get("scope");
  const runId = args.get("run") ?? deriveRunId(scope);
  const sessionId = args.get("session") ?? deriveSessionId(scope);
  const ttl = args.get("ttl") ?? "24h";
  const categories = args.get("category")?.split(",").map((entry) => entry.trim());

  const receipts = await fetchReceipts(repository, issueNumber);
  const explicit = args.get("name");
  const candidates = explicit
    ? [explicit]
    : proposeCallsigns(receipts, reserveAttempts, categories);
  if (candidates.length === 0) throw new Error("No callsign candidates available");

  for (const callsign of candidates) {
    process.stderr.write(`Reserving ${callsign}...\n`);
    const requestUrl = await postComment(
      repository,
      issueNumber,
      `/callsign reserve ${callsign}\nrun: ${runId}\nsession: ${sessionId}\nttl: ${ttl}`,
    );
    const receipt = await awaitReceipt(repository, issueNumber, requestUrl);
    if (receipt.status !== "accepted") {
      process.stderr.write(`Rejected (${receipt.reason ?? "no reason given"}).\n`);
      if (explicit) return 1;
      continue;
    }
    if (
      receipt.callsign === null || receipt.sigil === null || receipt.collisionKey === null
      || receipt.generation === null || receipt.acceptedAt === null || receipt.expiresAt === null
    ) {
      throw new Error("Accepted receipt is missing required fields");
    }
    const state: SessionState = {
      version: 1,
      repository,
      issueNumber,
      callsign: receipt.callsign,
      sigil: receipt.sigil,
      collisionKey: receipt.collisionKey,
      generation: receipt.generation,
      runId,
      sessionId,
      acceptedAt: receipt.acceptedAt,
      expiresAt: receipt.expiresAt,
      receiptCommentUrl: receipt.commentUrl,
      requestCommentUrl: requestUrl,
    };
    await writeState(state);
    process.stderr.write(`Accepted, expires ${state.expiresAt}. Receipt ${state.receiptCommentUrl}\n`);
    process.stdout.write(`${signatureBlock(state)}\n`);
    return 0;
  }
  process.stderr.write("Every candidate was rejected. Re-run to draw new names.\n");
  return 1;
}

async function commandSign(): Promise<number> {
  const state = await readState();
  if (!state) {
    process.stderr.write("No callsign held. Run `callsign start` first.\n");
    return 1;
  }
  if (Date.parse(state.expiresAt) <= Date.now()) {
    process.stderr.write(
      `Lease on ${state.callsign} expired at ${state.expiresAt}. Run \`callsign start\` again.\n`,
    );
    return 1;
  }
  process.stdout.write(`${signatureBlock(state)}\n`);
  return 0;
}

async function commandEnd(): Promise<number> {
  const state = await readState();
  if (!state) {
    process.stderr.write("No callsign held; nothing to release.\n");
    return 0;
  }
  const requestUrl = await postComment(
    state.repository,
    state.issueNumber,
    `/callsign release ${state.callsign}\nrun: ${state.runId}\ngeneration: ${state.generation}`,
  );
  const receipt = await awaitReceipt(state.repository, state.issueNumber, requestUrl);
  if (receipt.status !== "released") {
    process.stderr.write(
      `Release not accepted (${receipt.status}: ${receipt.reason ?? "no reason"}). State kept.\n`,
    );
    return 1;
  }
  await clearState();
  process.stderr.write(`Released ${state.callsign} g${state.generation}.\n`);
  return 0;
}

async function commandStatus(args: Map<string, string>): Promise<number> {
  const repository = args.get("repo") ?? defaultRepository;
  const issueNumber = Number(args.get("issue") ?? defaultIssueNumber);
  const receipts = await fetchReceipts(repository, issueNumber);
  const projection = projectGitHubCallsignRegistry(receipts, new Date().toISOString());
  const state = await readState();
  if (state) {
    const held = Date.parse(state.expiresAt) > Date.now() ? "held" : "EXPIRED";
    process.stdout.write(`this session: ${state.callsign} g${state.generation} ${state.sigil} (${held})\n\n`);
  }
  if (projection.activeLeases.length === 0) {
    process.stdout.write("no active leases\n");
    return 0;
  }
  process.stdout.write(`${projection.activeLeases.length} active lease(s):\n`);
  for (const lease of projection.activeLeases) {
    process.stdout.write(`  ${describeLease(lease)}\n`);
  }
  return 0;
}

async function commandSuggest(args: Map<string, string>): Promise<number> {
  const repository = args.get("repo") ?? defaultRepository;
  const issueNumber = Number(args.get("issue") ?? defaultIssueNumber);
  const count = Number(args.get("count") ?? 10);
  const categories = args.get("category")?.split(",").map((entry) => entry.trim());
  const receipts = await fetchReceipts(repository, issueNumber);
  for (const callsign of proposeCallsigns(receipts, count, categories)) {
    process.stdout.write(`${callsign}\n`);
  }
  return 0;
}

function usage(): string {
  return `Usage: callsign <command> [options]

Commands:
  start       Reserve an unused callsign and wait for the registrar receipt
  sign        Print the signature block to append to a PR/issue comment
  status      Show this session's lease and all active leases (read-only)
  suggest     Print candidate names that have never been used
  end         Release the lease this session holds

start options:
  --scope <text>     Short work description, used to derive run/session ids
  --name <Callsign>  Reserve this exact name instead of choosing one
  --run <run_...>    Explicit run id (default: derived from --scope)
  --session <id>     Explicit session id (default: derived from environment)
  --ttl <1h-168h>    Lease length (default: 24h)
  --category <list>  Preferred name pools: animal, object, literary, internet
  --force            Reserve even if this session already holds a lease

Common options:
  --repo <owner/name>  Registry repository (default: ${defaultRepository})
  --issue <number>     Registry issue (default: ${defaultIssueNumber})

A callsign is presentation metadata. It grants no authority or approval.`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index] ?? "";
    if (!entry.startsWith("--")) throw new Error(`Unexpected argument: ${entry}`);
    const key = entry.slice(2);
    if (key === "force") {
      flags.add(key);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    args.set(key, value);
    index += 1;
  }

  switch (command) {
    case "start":
      return await commandStart(args, flags);
    case "sign":
      return await commandSign();
    case "status":
      return await commandStatus(args);
    case "suggest":
      return await commandSuggest(args);
    case "end":
    case "release":
      return await commandEnd();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
      return 1;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
