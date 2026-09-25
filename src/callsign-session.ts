/**
 * One-command callsign session lifecycle for workers.
 *
 * Wraps the #454 dogfood registry so a worker never hand-writes the command
 * grammar, invents a name, tracks its generation, or polls for a receipt:
 *
 *   callsign                               this session's callsign: the held one, or a
 *                                          fresh namegen proposal reserved on the spot
 *   callsign sign                          print the signature block for a comment
 *   callsign status                        active leases, read-only
 *   callsign end                           release the lease this session holds (optional;
 *                                          leases expire on their own)
 *
 * A callsign remains presentation/attribution metadata only. Reserving one
 * grants no authority, capability, continuity, or approval.
 */
import { homedir, hostname } from "node:os";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  parseGitHubCallsignReceipt,
  projectGitHubCallsignRegistry,
  type GitHubCallsignActiveLease,
  type ParsedGitHubCallsignReceipt,
} from "./github-callsign-registry.js";
import { proposeCallsigns as proposeNamegenCallsigns, resolveVibe } from "./callsign-namegen.js";
import {
  defaultRecentDays,
  readRegistryComments,
  registrarReceipts,
  registrySnapshotFromReceipts,
  resolveVibeChoice,
} from "./callsign-namegen-cli.js";

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

/** A reserve comment posted but not yet answered, kept so a retry resumes it. */
interface PendingReservation {
  version: 1;
  pending: true;
  repository: string;
  issueNumber: number;
  callsign: string;
  runId: string;
  sessionId: string;
  requestCommentUrl: string;
  postedAt: string;
}

type StoredState = SessionState | PendingReservation;

/**
 * The worker session this process belongs to.
 *
 * Several agent sessions share one machine and one $HOME, so anything derived
 * from the environment alone collides across them.
 */
export function sessionKey(): string {
  return process.env.CALLSIGN_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CODEX_SESSION_ID
    || "";
}

/** The session every lease is keyed by; refuses rather than guess one. */
export function requireSessionId(explicit?: string): string {
  const raw = explicit ?? sessionKey();
  if (!raw) {
    throw new Error(
      "No agent session id (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or CALLSIGN_SESSION_ID). "
        + "Set CALLSIGN_SESSION_ID to something unique to this session, or sign `unregistered`.",
    );
  }
  return slug(raw).slice(0, 160) || "session";
}

export function statePath(sessionId: string = requireSessionId()): string {
  const base = process.env.CALLSIGN_STATE_DIR
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "callsign");
  // One file per session. A shared path hands one worker another's lease.
  return join(base, `session-${slug(sessionId)}.json`);
}

async function readStored(sessionId?: string): Promise<StoredState | null> {
  try {
    return JSON.parse(await readFile(statePath(sessionId), "utf8")) as StoredState;
  } catch {
    return null;
  }
}

async function readState(sessionId?: string): Promise<SessionState | null> {
  const stored = await readStored(sessionId);
  return stored && !("pending" in stored) ? stored : null;
}

async function writeState(state: StoredState): Promise<void> {
  const path = statePath(state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Serialises start/end within one session (subagents share their parent's
 * session id), so two concurrent calls never reserve two names.
 */
async function withSessionLock<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath(sessionId)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2 * receiptTimeoutMs + 60_000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockPath).catch(() => null))?.mtimeMs!;
      // A holder that crashed never releases; nothing legitimate runs this long.
      if (Number.isFinite(age) && age > 2 * receiptTimeoutMs + 60_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockPath}`);
      await Bun.sleep(500);
    }
  }
  try {
    return await body();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function clearState(sessionId?: string): Promise<void> {
  await rm(statePath(sessionId), { force: true });
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
  return registrarReceipts(readRegistryComments(repository, issueNumber));
}

/**
 * Names to try, best first, from namegen: clear of active and recent names
 * including near-collisions, and of every earlier name that reads as the same
 * word. Seeded by session so a retried start replays its order.
 */
export function proposeCallsigns(
  receipts: readonly ParsedGitHubCallsignReceipt[],
  count: number,
  options: { vibe?: string; session?: string; now?: Date } = {},
): string[] {
  const snapshot = registrySnapshotFromReceipts(receipts, {
    source: "registry",
    evaluatedAt: (options.now ?? new Date()).toISOString(),
    recentDays: defaultRecentDays,
  });
  return proposeNamegenCallsigns({
    ...(options.session === undefined ? {} : { session: options.session }),
    taken: snapshot.taken,
    history: snapshot.history,
    activeSigils: snapshot.active.map((lease) => lease.sigil),
    ...(options.vibe === undefined ? {} : { vibe: resolveVibe(options.vibe) }),
    count,
  }).proposals.map((proposal) => proposal.callsign);
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
  const provided = sessionKey();
  if (provided) return slug(provided).slice(0, 160) || "session";
  // No session identity available: never reuse a name another worker could also
  // derive, so fall back to something unique per invocation.
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

/**
 * Waits for the registrar's canonical receipt for exactly this request.
 *
 * Uses the shared glaeda-gh daemon when it runs here, so concurrent sessions
 * do not each poll GitHub; otherwise reads the issue on a slow bounded loop.
 */
async function awaitReceipt(
  repository: string,
  issueNumber: number,
  requestCommentUrl: string,
): Promise<ParsedGitHubCallsignReceipt> {
  const findReceipt = async () =>
    (await fetchReceipts(repository, issueNumber))
      .find((receipt) => receipt.requestComment === requestCommentUrl);
  const glaeda = waitWithGlaeda(repository, issueNumber, requestCommentUrl);
  if (glaeda !== "unavailable") {
    // The daemon already watched for the full timeout; one direct read settles it.
    const match = await findReceipt();
    if (match) return match;
    if (glaeda === "timeout") throw receiptTimeout(requestCommentUrl);
  }
  const deadline = Date.now() + receiptTimeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(receiptPollIntervalMs);
    const match = await findReceipt();
    if (match) return match;
  }
  throw receiptTimeout(requestCommentUrl);
}

function receiptTimeout(requestCommentUrl: string): Error {
  return new Error(
    `No registrar receipt for ${requestCommentUrl} within ${receiptTimeoutMs / 1000}s. `
      + "Run again to keep waiting for this same request; until then sign `pending`.",
  );
}

/**
 * "matched" when glaeda-gh saw the receipt, "timeout" when it watched the whole
 * window, "unavailable" when it is not installed or its daemon is down.
 */
function waitWithGlaeda(
  repository: string,
  issueNumber: number,
  requestCommentUrl: string,
): "matched" | "timeout" | "unavailable" {
  const requestId = requestCommentUrl.split("#issuecomment-")[1];
  if (!requestId) return "unavailable";
  try {
    execFileSync("glaeda-gh", [
      "wait",
      "comment",
      `${repository}#${issueNumber}`,
      "--author",
      registrarLogin,
      "--match",
      `issuecomment-${requestId}\\b`,
      "--since",
      requestCommentUrl,
      "--timeout",
      String(receiptTimeoutMs / 1000),
    ], { stdio: ["ignore", "ignore", "ignore"] });
    return "matched";
  } catch (error) {
    return (error as { status?: number }).status === 2 ? "timeout" : "unavailable";
  }
}

export function signatureBlock(state: SessionState): string {
  return `— ${state.callsign} g${state.generation} ${state.sigil}\nRun: ${state.runId}`;
}

function describeLease(lease: GitHubCallsignActiveLease): string {
  return `${lease.callsign} g${lease.generation} ${lease.sigil}  `
    + `run=${lease.runId}  expires=${lease.expiresAt}`;
}

async function commandStart(args: Map<string, string>, flags: Set<string>): Promise<number> {
  const sessionId = requireSessionId(args.get("session"));
  return await withSessionLock(sessionId, () => startLocked(args, flags, sessionId));
}

async function startLocked(
  args: Map<string, string>,
  flags: Set<string>,
  sessionId: string,
): Promise<number> {
  const repository = args.get("repo") ?? defaultRepository;
  const issueNumber = Number(args.get("issue") ?? defaultIssueNumber);
  const force = flags.has("force");
  const stored = await readStored(sessionId);

  if (stored && "pending" in stored) {
    // An earlier call posted a reserve command and gave up waiting. Finish
    // that request instead of posting another name.
    process.stderr.write(`Waiting for the receipt on ${stored.callsign}...\n`);
    const receipt = await awaitReceipt(stored.repository, stored.issueNumber, stored.requestCommentUrl);
    if (receipt.status === "accepted") return await adopt(receipt, stored);
    process.stderr.write(`${stored.callsign} was rejected (${receipt.reason ?? "no reason given"}).\n`);
    await clearState(sessionId);
  } else if (stored && Date.parse(stored.expiresAt) > Date.now()) {
    if (!force) {
      process.stderr.write(`${stored.callsign} g${stored.generation} is held until ${stored.expiresAt}.\n`);
      process.stdout.write(`${signatureBlock(stored)}\n`);
      return 0;
    }
    // --force picks a new name; release the held one so it is not orphaned.
    if (!(await releaseLease(stored))) return 1;
  }

  const runId = args.get("run") ?? deriveRunId(args.get("scope"));
  const ttl = args.get("ttl") ?? "24h";
  const receipts = await fetchReceipts(repository, issueNumber);
  const explicit = args.get("name");
  // A session whose lease lapsed asks for its old name back first, so its
  // signature stays the same across a long session.
  const previous = stored && !("pending" in stored) && !force ? [stored.callsign] : [];
  const vibe = resolveVibeChoice(args.get("vibe"), process.env, process.cwd()).vibe;
  const candidates = explicit
    ? [explicit]
    : [...new Set([
      ...previous,
      ...proposeCallsigns(receipts, reserveAttempts, { vibe, session: sessionId }),
    ])];

  for (const callsign of candidates) {
    process.stderr.write(`Reserving ${callsign}...\n`);
    const requestCommentUrl = await postComment(
      repository,
      issueNumber,
      `/callsign reserve ${callsign}\nrun: ${runId}\nsession: ${sessionId}\nttl: ${ttl}`,
    );
    const pending: PendingReservation = {
      version: 1,
      pending: true,
      repository,
      issueNumber,
      callsign,
      runId,
      sessionId,
      requestCommentUrl,
      postedAt: new Date().toISOString(),
    };
    await writeState(pending);
    const receipt = await awaitReceipt(repository, issueNumber, requestCommentUrl);
    if (receipt.status === "accepted") return await adopt(receipt, pending);
    process.stderr.write(`Rejected (${receipt.reason ?? "no reason given"}).\n`);
    await clearState(sessionId);
    if (explicit) return 1;
  }
  process.stderr.write("Every candidate was rejected. Re-run to draw new names.\n");
  return 1;
}

async function adopt(
  receipt: ParsedGitHubCallsignReceipt,
  request: PendingReservation,
): Promise<number> {
  if (
    receipt.callsign === null || receipt.sigil === null || receipt.collisionKey === null
    || receipt.generation === null || receipt.acceptedAt === null || receipt.expiresAt === null
  ) {
    throw new Error("Accepted receipt is missing required fields");
  }
  const state: SessionState = {
    version: 1,
    repository: request.repository,
    issueNumber: request.issueNumber,
    callsign: receipt.callsign,
    sigil: receipt.sigil,
    collisionKey: receipt.collisionKey,
    generation: receipt.generation,
    runId: request.runId,
    sessionId: request.sessionId,
    acceptedAt: receipt.acceptedAt,
    expiresAt: receipt.expiresAt,
    receiptCommentUrl: receipt.commentUrl,
    requestCommentUrl: request.requestCommentUrl,
  };
  await writeState(state);
  process.stderr.write(`Accepted, expires ${state.expiresAt}. Receipt ${state.receiptCommentUrl}\n`);
  process.stdout.write(`${signatureBlock(state)}\n`);
  return 0;
}

async function releaseLease(state: SessionState): Promise<boolean> {
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
    return false;
  }
  await clearState(state.sessionId);
  process.stderr.write(`Released ${state.callsign} g${state.generation}.\n`);
  return true;
}

async function commandSign(): Promise<number> {
  const sessionId = requireSessionId();
  const state = await readState(sessionId);
  if (!state) {
    process.stderr.write("No callsign held. Run `callsign` first.\n");
    return 1;
  }
  if (Date.parse(state.expiresAt) <= Date.now()) {
    process.stderr.write(`Lease on ${state.callsign} expired at ${state.expiresAt}. Run \`callsign\` again.\n`);
    return 1;
  }
  if (state.sessionId !== sessionId) {
    process.stderr.write(
      `Stored lease on ${state.callsign} belongs to session ${state.sessionId}, not this one. `
        + "Refusing to sign another worker's callsign; run `callsign`.\n",
    );
    return 1;
  }
  process.stdout.write(`${signatureBlock(state)}\n`);
  return 0;
}

async function commandEnd(): Promise<number> {
  const sessionId = requireSessionId();
  return await withSessionLock(sessionId, async () => {
    const state = await readState(sessionId);
    if (!state) {
      process.stderr.write("No callsign held; nothing to release.\n");
      return 0;
    }
    return (await releaseLease(state)) ? 0 : 1;
  });
}

async function commandStatus(args: Map<string, string>): Promise<number> {
  const repository = args.get("repo") ?? defaultRepository;
  const issueNumber = Number(args.get("issue") ?? defaultIssueNumber);
  const receipts = await fetchReceipts(repository, issueNumber);
  const projection = projectGitHubCallsignRegistry(receipts, new Date().toISOString());
  const state = sessionKey() ? await readState() : null;
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
  const receipts = await fetchReceipts(repository, issueNumber);
  const vibe = args.get("vibe");
  for (const callsign of proposeCallsigns(receipts, count, vibe === undefined ? {} : { vibe })) {
    process.stdout.write(`${callsign}\n`);
  }
  return 0;
}

function usage(): string {
  return `Usage: callsign <command> [options]

With no command, prints this session's signature: the lease it already holds,
or a fresh name reserved and confirmed on the spot. Run it whenever you need to
sign something; there is nothing to track.

Commands:
  start       Same as no command
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
  --vibe <name>      Name pool: cute (default), ops, lame
  --force            Reserve even if this session already holds a lease

Common options:
  --repo <owner/name>  Registry repository (default: ${defaultRepository})
  --issue <number>     Registry issue (default: ${defaultIssueNumber})

A callsign is presentation metadata. It grants no authority or approval.`;
}

async function main(argv: string[]): Promise<number> {
  // Bare `callsign` (or options only) means: give me this session's callsign.
  const [command, ...rest] = argv[0] === undefined || argv[0].startsWith("--") && argv[0] !== "--help"
    ? ["start", ...argv]
    : argv;
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
