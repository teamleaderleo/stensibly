import { callsignCollisionKey } from "./callsign-suggestions.ts";
import { callsignSigil } from "./callsign-sigils.ts";

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const receiptHeader = "callsign-receipt/v0";

export type GitHubCallsignCommand = GitHubCallsignReserveCommand | GitHubCallsignReleaseCommand;

export interface GitHubCallsignReserveCommand {
  version: 0;
  kind: "reserve";
  callsign: string;
  collisionKey: string;
  runId: string;
  sessionId: string;
  ttlHours: number;
}

export interface GitHubCallsignReleaseCommand {
  version: 0;
  kind: "release";
  callsign: string;
  collisionKey: string;
  runId: string;
  generation: number;
}

export type GitHubCallsignReceiptStatus = "accepted" | "rejected" | "released";

export interface ParsedGitHubCallsignReceipt {
  version: 0;
  status: GitHubCallsignReceiptStatus;
  commentId: number;
  commentUrl: string;
  callsign: string | null;
  sigil: string | null;
  collisionKey: string | null;
  requestComment: string;
  runId: string | null;
  sessionId: string | null;
  generation: number | null;
  acceptedAt: string | null;
  expiresAt: string | null;
  releasedAt: string | null;
  reason: string | null;
  receiptAuthority: "github-actions[bot]";
}

export interface GitHubCallsignActiveLease {
  callsign: string;
  sigil: string;
  collisionKey: string;
  requestComment: string;
  runId: string;
  sessionId: string;
  generation: number;
  acceptedAt: string;
  expiresAt: string;
  receiptCommentId: number;
  receiptCommentUrl: string;
}

export interface GitHubCallsignRegistryProjection {
  version: 0;
  evaluatedAt: string;
  activeLeases: GitHubCallsignActiveLease[];
  maximumGenerationByCollisionKey: ReadonlyMap<string, number>;
}

export interface GitHubCallsignReceiptDraft {
  version: 0;
  status: GitHubCallsignReceiptStatus;
  callsign: string | null;
  sigil: string | null;
  collisionKey: string | null;
  requestComment: string;
  runId: string | null;
  sessionId: string | null;
  generation: number | null;
  acceptedAt: string | null;
  expiresAt: string | null;
  releasedAt: string | null;
  reason: string | null;
  receiptAuthority: "github-actions[bot]";
}

export type GitHubCallsignDecision =
  | {
    outcome: "accepted" | "released" | "rejected";
    reaction: "+1" | "-1";
    receipt: GitHubCallsignReceiptDraft;
    existingReceipt: null;
  }
  | {
    outcome: "replay";
    reaction: "+1" | "-1";
    receipt: null;
    existingReceipt: ParsedGitHubCallsignReceipt;
  };

export function parseGitHubCallsignCommand(body: string): GitHubCallsignCommand {
  const block = firstParagraph(body, "Callsign command");
  const lines = block.split(/\r?\n/u).map((line) => line.trim());
  const commandLine = lines[0];
  if (!commandLine) throw new RangeError("Callsign command is empty");

  const match = /^\/callsign\s+(reserve|release)\s+(.+)$/u.exec(commandLine);
  if (!match) {
    throw new RangeError("Callsign command must start with /callsign reserve or /callsign release");
  }
  const kind = match[1];
  const callsign = canonicalCallsign(match[2] ?? "");
  const collisionKey = callsignCollisionKey(callsign);
  const fields = parseFields(lines.slice(1), "Callsign command");

  if (kind === "reserve") {
    requireExactFields(fields, ["run", "session", "ttl"]);
    return {
      version: 0,
      kind: "reserve",
      callsign,
      collisionKey,
      runId: canonicalRunId(requiredField(fields, "run")),
      sessionId: canonicalIdentifier(requiredField(fields, "session"), "Worker session", 160),
      ttlHours: canonicalTtl(requiredField(fields, "ttl")),
    };
  }

  requireExactFields(fields, ["run", "generation"]);
  return {
    version: 0,
    kind: "release",
    callsign,
    collisionKey,
    runId: canonicalRunId(requiredField(fields, "run")),
    generation: canonicalGeneration(requiredField(fields, "generation")),
  };
}

export function parseGitHubCallsignReceipt(input: {
  body: string;
  commentId: number;
  commentUrl: string;
}): ParsedGitHubCallsignReceipt {
  const block = firstParagraph(input.body, "Callsign receipt");
  const lines = block.split(/\r?\n/u).map((line) => line.trim());
  if (lines[0] !== receiptHeader) throw new RangeError("Callsign receipt header is invalid");
  const fields = parseFields(lines.slice(1), "Callsign receipt");
  const status = canonicalReceiptStatus(requiredField(fields, "status"));
  const requestComment = canonicalUrl(requiredField(fields, "request-comment"), "Request comment");
  const callsign = optionalField(fields, "callsign") === null
    ? null
    : canonicalCallsign(requiredField(fields, "callsign"));
  const collisionKey = optionalField(fields, "collision-key") === null
    ? null
    : callsignCollisionKey(requiredField(fields, "collision-key"));
  if (callsign !== null && collisionKey !== callsignCollisionKey(callsign)) {
    throw new RangeError("Receipt collision key does not match the callsign");
  }
  const sigil = optionalField(fields, "sigil") === null
    ? null
    : canonicalSigil(requiredField(fields, "sigil"));
  const runId = optionalField(fields, "run") === null
    ? null
    : canonicalRunId(requiredField(fields, "run"));
  const sessionId = optionalField(fields, "session") === null
    ? null
    : canonicalIdentifier(requiredField(fields, "session"), "Worker session", 160);
  const generation = optionalField(fields, "generation") === null
    ? null
    : canonicalGeneration(requiredField(fields, "generation"));
  const acceptedAt = optionalField(fields, "accepted-at") === null
    ? null
    : canonicalTimestamp(requiredField(fields, "accepted-at"), "Accepted time");
  const expiresAt = optionalField(fields, "expires-at") === null
    ? null
    : canonicalTimestamp(requiredField(fields, "expires-at"), "Expiry time");
  const releasedAt = optionalField(fields, "released-at") === null
    ? null
    : canonicalTimestamp(requiredField(fields, "released-at"), "Release time");
  const reason = optionalField(fields, "reason") === null
    ? null
    : canonicalReason(requiredField(fields, "reason"));
  const authority = requiredField(fields, "receipt-authority");
  if (authority !== "github-actions[bot]") {
    throw new RangeError("Callsign receipt authority must be github-actions[bot]");
  }

  if (status === "accepted") {
    if (
      callsign === null || sigil === null || collisionKey === null || runId === null
      || sessionId === null || generation === null || acceptedAt === null || expiresAt === null
      || releasedAt !== null || reason !== null
    ) {
      throw new RangeError("Accepted receipt is missing required lease fields");
    }
    if (Date.parse(expiresAt) <= Date.parse(acceptedAt)) {
      throw new RangeError("Accepted receipt expiry must be later than acceptance");
    }
  } else if (status === "released") {
    if (
      callsign === null || sigil === null || collisionKey === null || runId === null
      || generation === null || releasedAt === null || reason !== null
    ) {
      throw new RangeError("Released receipt is missing required release fields");
    }
  } else if (reason === null) {
    throw new RangeError("Rejected receipt requires a reason");
  }

  if (!Number.isSafeInteger(input.commentId) || input.commentId < 1) {
    throw new RangeError("Receipt comment ID must be a positive integer");
  }

  return {
    version: 0,
    status,
    commentId: input.commentId,
    commentUrl: canonicalUrl(input.commentUrl, "Receipt comment"),
    callsign,
    sigil,
    collisionKey,
    requestComment,
    runId,
    sessionId,
    generation,
    acceptedAt,
    expiresAt,
    releasedAt,
    reason,
    receiptAuthority: "github-actions[bot]",
  };
}

export function projectGitHubCallsignRegistry(
  receipts: readonly ParsedGitHubCallsignReceipt[],
  evaluatedAt: string,
): GitHubCallsignRegistryProjection {
  const at = canonicalTimestamp(evaluatedAt, "Registry evaluation time");
  const active = new Map<string, GitHubCallsignActiveLease>();
  const maximum = new Map<string, number>();

  for (const receipt of [...receipts].sort((left, right) => left.commentId - right.commentId)) {
    if (receipt.collisionKey !== null && receipt.generation !== null) {
      maximum.set(
        receipt.collisionKey,
        Math.max(maximum.get(receipt.collisionKey) ?? 0, receipt.generation),
      );
    }
    if (receipt.status === "accepted") {
      const lease = acceptedLease(receipt);
      active.set(lease.collisionKey, lease);
      continue;
    }
    if (receipt.status === "released") {
      const current = receipt.collisionKey === null ? undefined : active.get(receipt.collisionKey);
      if (
        current
        && current.runId === receipt.runId
        && current.generation === receipt.generation
      ) {
        active.delete(current.collisionKey);
      }
    }
  }

  for (const [collisionKey, lease] of active) {
    if (Date.parse(lease.expiresAt) <= Date.parse(at)) active.delete(collisionKey);
  }

  return {
    version: 0,
    evaluatedAt: at,
    activeLeases: [...active.values()].sort((left, right) =>
      left.collisionKey < right.collisionKey ? -1 : left.collisionKey > right.collisionKey ? 1 : 0
    ),
    maximumGenerationByCollisionKey: maximum,
  };
}

export function decideGitHubCallsignCommand(input: {
  command: GitHubCallsignCommand;
  requestComment: string;
  receipts: readonly ParsedGitHubCallsignReceipt[];
  evaluatedAt: string;
}): GitHubCallsignDecision {
  const requestComment = canonicalUrl(input.requestComment, "Request comment");
  const existing = input.receipts.find((receipt) => receipt.requestComment === requestComment);
  if (existing) {
    return {
      outcome: "replay",
      reaction: existing.status === "rejected" ? "-1" : "+1",
      receipt: null,
      existingReceipt: existing,
    };
  }

  const evaluatedAt = canonicalTimestamp(input.evaluatedAt, "Registry decision time");
  const projection = projectGitHubCallsignRegistry(input.receipts, evaluatedAt);
  const active = projection.activeLeases.find(
    (lease) => lease.collisionKey === input.command.collisionKey,
  );
  const sigil = callsignSigil(input.command.callsign).sigil;

  if (input.command.kind === "reserve") {
    if (active) {
      return rejection({
        command: input.command,
        requestComment,
        sigil,
        generation: active.generation,
        reason: `active_collision:${active.runId}`,
      });
    }
    const generation = (projection.maximumGenerationByCollisionKey.get(
      input.command.collisionKey,
    ) ?? 0) + 1;
    const expiresAt = new Date(
      Date.parse(evaluatedAt) + input.command.ttlHours * 60 * 60 * 1_000,
    ).toISOString();
    return {
      outcome: "accepted",
      reaction: "+1",
      existingReceipt: null,
      receipt: {
        version: 0,
        status: "accepted",
        callsign: input.command.callsign,
        sigil,
        collisionKey: input.command.collisionKey,
        requestComment,
        runId: input.command.runId,
        sessionId: input.command.sessionId,
        generation,
        acceptedAt: evaluatedAt,
        expiresAt,
        releasedAt: null,
        reason: null,
        receiptAuthority: "github-actions[bot]",
      },
    };
  }

  if (!active) {
    return rejection({
      command: input.command,
      requestComment,
      sigil,
      generation: null,
      reason: "no_active_lease",
    });
  }
  if (active.runId !== input.command.runId) {
    return rejection({
      command: input.command,
      requestComment,
      sigil,
      generation: active.generation,
      reason: `holder_mismatch:${active.runId}`,
    });
  }
  if (active.generation !== input.command.generation) {
    return rejection({
      command: input.command,
      requestComment,
      sigil,
      generation: active.generation,
      reason: `stale_generation:${active.generation}`,
    });
  }

  return {
    outcome: "released",
    reaction: "+1",
    existingReceipt: null,
    receipt: {
      version: 0,
      status: "released",
      callsign: active.callsign,
      sigil: active.sigil,
      collisionKey: active.collisionKey,
      requestComment,
      runId: active.runId,
      sessionId: active.sessionId,
      generation: active.generation,
      acceptedAt: null,
      expiresAt: null,
      releasedAt: evaluatedAt,
      reason: null,
      receiptAuthority: "github-actions[bot]",
    },
  };
}

export function formatGitHubCallsignReceipt(receipt: GitHubCallsignReceiptDraft): string {
  const lines = [receiptHeader, `status: ${receipt.status}`];
  appendField(lines, "callsign", receipt.callsign);
  appendField(lines, "sigil", receipt.sigil);
  appendField(lines, "collision-key", receipt.collisionKey);
  appendField(lines, "request-comment", receipt.requestComment);
  appendField(lines, "run", receipt.runId);
  appendField(lines, "session", receipt.sessionId);
  appendField(lines, "generation", receipt.generation);
  appendField(lines, "accepted-at", receipt.acceptedAt);
  appendField(lines, "expires-at", receipt.expiresAt);
  appendField(lines, "released-at", receipt.releasedAt);
  appendField(lines, "reason", receipt.reason);
  lines.push(`receipt-authority: ${receipt.receiptAuthority}`);
  lines.push("");
  lines.push("The GitHub username is the shared transport principal. Callsign, run, and session fields identify the worker session.");
  return lines.join("\n");
}

export function formatGitHubCallsignCommandRejection(input: {
  requestComment: string;
  reason: string;
}): string {
  const requestComment = canonicalUrl(input.requestComment, "Request comment");
  const reason = canonicalReason(input.reason);
  return [
    receiptHeader,
    "status: rejected",
    `request-comment: ${requestComment}`,
    `reason: ${reason}`,
    "receipt-authority: github-actions[bot]",
    "",
    "The command was rejected before a callsign lease decision could be made.",
  ].join("\n");
}

function rejection(input: {
  command: GitHubCallsignCommand;
  requestComment: string;
  sigil: string;
  generation: number | null;
  reason: string;
}): GitHubCallsignDecision {
  return {
    outcome: "rejected",
    reaction: "-1",
    existingReceipt: null,
    receipt: {
      version: 0,
      status: "rejected",
      callsign: input.command.callsign,
      sigil: input.sigil,
      collisionKey: input.command.collisionKey,
      requestComment: input.requestComment,
      runId: input.command.runId,
      sessionId: input.command.kind === "reserve" ? input.command.sessionId : null,
      generation: input.generation,
      acceptedAt: null,
      expiresAt: null,
      releasedAt: null,
      reason: canonicalReason(input.reason),
      receiptAuthority: "github-actions[bot]",
    },
  };
}

function acceptedLease(receipt: ParsedGitHubCallsignReceipt): GitHubCallsignActiveLease {
  if (
    receipt.status !== "accepted" || receipt.callsign === null || receipt.sigil === null
    || receipt.collisionKey === null || receipt.runId === null || receipt.sessionId === null
    || receipt.generation === null || receipt.acceptedAt === null || receipt.expiresAt === null
  ) {
    throw new RangeError("Receipt cannot be projected as an accepted lease");
  }
  return {
    callsign: receipt.callsign,
    sigil: receipt.sigil,
    collisionKey: receipt.collisionKey,
    requestComment: receipt.requestComment,
    runId: receipt.runId,
    sessionId: receipt.sessionId,
    generation: receipt.generation,
    acceptedAt: receipt.acceptedAt,
    expiresAt: receipt.expiresAt,
    receiptCommentId: receipt.commentId,
    receiptCommentUrl: receipt.commentUrl,
  };
}

function parseFields(lines: readonly string[], label: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (line.length === 0) continue;
    const match = /^([a-z][a-z0-9-]*):\s*(.+)$/u.exec(line);
    if (!match) throw new RangeError(`${label} field is malformed: ${line}`);
    const key = match[1];
    const value = match[2];
    if (!key || !value) throw new RangeError(`${label} field is malformed`);
    if (fields.has(key)) throw new RangeError(`${label} contains duplicate field: ${key}`);
    fields.set(key, value.trim());
  }
  return fields;
}

function requireExactFields(fields: ReadonlyMap<string, string>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  for (const key of fields.keys()) {
    if (!expectedSet.has(key)) throw new RangeError(`Unknown callsign command field: ${key}`);
  }
  for (const key of expected) requiredField(fields, key);
}

function requiredField(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key);
  if (!value) throw new RangeError(`Missing required field: ${key}`);
  return value;
}

function optionalField(fields: ReadonlyMap<string, string>, key: string): string | null {
  return fields.get(key) ?? null;
}

function firstParagraph(value: string, label: string): string {
  assertSafeText(value, label);
  const normalized = value.replace(/\r\n/gu, "\n").trim();
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  return normalized.split(/\n\s*\n/u, 1)[0] ?? normalized;
}

function canonicalCallsign(value: string): string {
  assertSafeText(value, "Callsign");
  const display = value.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  callsignCollisionKey(display);
  return display;
}

function canonicalRunId(value: string): string {
  const runId = canonicalIdentifier(value, "Run ID", 160);
  if (!runIdPattern.test(runId)) {
    throw new RangeError("Run ID must start with run_ and use supported identifier characters");
  }
  return runId;
}

function canonicalIdentifier(value: string, label: string, maximumLength: number): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > maximumLength) {
    throw new RangeError(`${label} must contain 1 to ${maximumLength} characters`);
  }
  if (!identifierPattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function canonicalTtl(value: string): number {
  const match = /^([1-9][0-9]{0,2})h$/u.exec(value.trim());
  const hours = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new RangeError("Callsign TTL must use 1h through 168h");
  }
  return hours;
}

function canonicalGeneration(value: string): number {
  const generation = Number(value.trim());
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError("Callsign generation must be a positive integer");
  }
  return generation;
}

function canonicalReceiptStatus(value: string): GitHubCallsignReceiptStatus {
  if (value === "accepted" || value === "rejected" || value === "released") return value;
  throw new RangeError("Callsign receipt status is unsupported");
}

function canonicalTimestamp(value: string, label: string): string {
  assertSafeText(value, label);
  const milliseconds = Date.parse(value.trim());
  if (!Number.isFinite(milliseconds)) throw new RangeError(`${label} must be an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}

function canonicalUrl(value: string, label: string): string {
  assertSafeText(value, label);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RangeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new RangeError(`${label} must be a github.com HTTPS URL`);
  }
  return url.toString();
}

function canonicalSigil(value: string): string {
  assertSafeText(value, "Callsign sigil");
  const sigil = value.trim();
  if (sigil.length === 0 || [...sigil].length > 8) {
    throw new RangeError("Callsign sigil must contain 1 to 8 Unicode code points");
  }
  return sigil;
}

function canonicalReason(value: string): string {
  assertSafeText(value, "Receipt reason");
  const reason = value.trim();
  if (reason.length === 0 || [...reason].length > 240) {
    throw new RangeError("Receipt reason must contain 1 to 240 characters");
  }
  return reason;
}

function appendField(lines: string[], key: string, value: string | number | null): void {
  if (value !== null) lines.push(`${key}: ${value}`);
}

function assertSafeText(value: string, label: string): void {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
}
