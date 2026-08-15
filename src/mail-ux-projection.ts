export const MAIL_UX_PROJECTION_VERSION = "mail-ux-projection/v0" as const;

export type MailAttentionClass = "handoff" | "review" | "decision" | "incident";
export type MailThreadState = "active" | "waiting" | "resolved";
export type MailThreadTemperature = "hot" | "active" | "waiting" | "resolved" | "stranded";

export interface MailThreadSnapshot {
  handle: string;
  attentionClass: MailAttentionClass;
  title: string;
  changed: string;
  current: string;
  nextAction: string;
  resolution: string;
  strongestSource: string;
  state: MailThreadState;
  updatedAt: string;
  actionableAt: string | null;
  resolvedAt: string | null;
}

export interface MaterialMailMessage {
  version: typeof MAIL_UX_PROJECTION_VERSION;
  subject: string;
  launchLine: string;
  body: string;
  bodyBytes: number;
  authorizesOperation: false;
  authorizesMutation: false;
}

export interface MailDigestRow {
  handle: string;
  temperature: MailThreadTemperature;
  attentionClass: MailAttentionClass;
  title: string;
  nextAction: string;
  ageHours: number;
  strongestSource: string;
}

export interface MailDigestProjection {
  version: typeof MAIL_UX_PROJECTION_VERSION;
  asOf: string;
  strandedAfterHours: number;
  rows: readonly MailDigestRow[];
  counts: Readonly<Record<MailThreadTemperature, number>>;
  authorizesOperation: false;
  authorizesMutation: false;
}

export interface RelayMeasurement {
  operatorTaps: number;
  turnsToUsefulAction: number;
  mailMessagesFetched: number;
  mailContextBytes: number;
  sourcesExpanded: number;
  staleFactsDiscovered: number;
  oldTranscriptNeeded: boolean;
  successorSucceeded: boolean;
  thirdWorkerSucceeded: boolean | null;
}

const HANDLE_PATTERN = /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):[A-Z0-9]{4,8}$/;
const encoder = new TextEncoder();

export function renderMaterialMailMessage(thread: MailThreadSnapshot): MaterialMailMessage {
  assertThread(thread);
  const launchLine = `Continue ${thread.handle}.`;
  const body = [
    launchLine,
    "",
    thread.title,
    `Changed: ${thread.changed}`,
    `Current: ${thread.current}`,
    `Next: ${thread.nextAction}`,
    `Resolve: ${thread.resolution}`,
    `Source: ${thread.strongestSource}`,
  ].join("\n");

  return Object.freeze({
    version: MAIL_UX_PROJECTION_VERSION,
    subject: `[${thread.handle}] ${thread.title}`,
    launchLine,
    body,
    bodyBytes: encoder.encode(body).byteLength,
    authorizesOperation: false,
    authorizesMutation: false,
  });
}

export function classifyMailThreadTemperature(
  thread: MailThreadSnapshot,
  asOf: string,
  strandedAfterHours = 24,
): MailThreadTemperature {
  assertThread(thread);
  const now = parseTimestamp(asOf, "asOf");
  const updated = parseTimestamp(thread.updatedAt, "updatedAt");
  if (!Number.isFinite(strandedAfterHours) || strandedAfterHours <= 0) {
    throw new TypeError("strandedAfterHours must be positive");
  }
  if (updated > now) {
    throw new TypeError("updatedAt cannot be after asOf");
  }
  if (thread.state === "resolved") return "resolved";

  const quietHours = (now - updated) / 3_600_000;
  if (quietHours >= strandedAfterHours) return "stranded";
  if (thread.state === "waiting") return "waiting";
  if (thread.attentionClass === "review" ||
      thread.attentionClass === "decision" ||
      thread.attentionClass === "incident") {
    return "hot";
  }
  return "active";
}

export function compileMailDigest(
  threads: readonly MailThreadSnapshot[],
  asOf: string,
  options: { strandedAfterHours?: number; limit?: number } = {},
): MailDigestProjection {
  const strandedAfterHours = options.strandedAfterHours ?? 24;
  const limit = options.limit ?? 12;
  const now = parseTimestamp(asOf, "asOf");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError("digest limit must be an integer from 1 to 50");
  }

  const rows = threads.map((thread) => {
    const temperature = classifyMailThreadTemperature(thread, asOf, strandedAfterHours);
    const ageFrom = thread.actionableAt ?? thread.updatedAt;
    const age = parseTimestamp(ageFrom, "actionableAt") > now
      ? 0
      : Math.floor((now - parseTimestamp(ageFrom, "actionableAt")) / 3_600_000);
    return {
      handle: thread.handle,
      temperature,
      attentionClass: thread.attentionClass,
      title: thread.title,
      nextAction: thread.nextAction,
      ageHours: age,
      strongestSource: thread.strongestSource,
    } satisfies MailDigestRow;
  });

  rows.sort(compareDigestRows);
  const counts: Record<MailThreadTemperature, number> = {
    hot: 0,
    active: 0,
    waiting: 0,
    resolved: 0,
    stranded: 0,
  };
  for (const row of rows) counts[row.temperature] += 1;

  return Object.freeze({
    version: MAIL_UX_PROJECTION_VERSION,
    asOf,
    strandedAfterHours,
    rows: Object.freeze(rows.slice(0, limit).map((row) => Object.freeze({ ...row }))),
    counts: Object.freeze(counts),
    authorizesOperation: false,
    authorizesMutation: false,
  });
}

export function gmailViewLabel(temperature: MailThreadTemperature): string {
  switch (temperature) {
    case "hot":
    case "active":
    case "stranded":
      return "Stensibly/Attention";
    case "waiting":
      return "Stensibly/Waiting";
    case "resolved":
      return "Stensibly/Resolved";
  }
}

export function relayContextReduction(
  baselineBytes: number,
  measurement: RelayMeasurement,
): { savedBytes: number; reductionRatio: number } {
  if (!Number.isInteger(baselineBytes) || baselineBytes <= 0) {
    throw new TypeError("baselineBytes must be a positive integer");
  }
  if (!Number.isInteger(measurement.mailContextBytes) || measurement.mailContextBytes < 0) {
    throw new TypeError("mailContextBytes must be a non-negative integer");
  }
  const savedBytes = Math.max(0, baselineBytes - measurement.mailContextBytes);
  return Object.freeze({
    savedBytes,
    reductionRatio: savedBytes / baselineBytes,
  });
}

function compareDigestRows(left: MailDigestRow, right: MailDigestRow): number {
  const rank: Record<MailThreadTemperature, number> = {
    hot: 0,
    stranded: 1,
    active: 2,
    waiting: 3,
    resolved: 4,
  };
  const rankDelta = rank[left.temperature] - rank[right.temperature];
  if (rankDelta !== 0) return rankDelta;
  if (left.temperature === "active" || left.temperature === "resolved") {
    const ageDelta = left.ageHours - right.ageHours;
    if (ageDelta !== 0) return ageDelta;
  } else {
    const ageDelta = right.ageHours - left.ageHours;
    if (ageDelta !== 0) return ageDelta;
  }
  return left.handle < right.handle ? -1 : left.handle > right.handle ? 1 : 0;
}

function assertThread(thread: MailThreadSnapshot): void {
  if (!HANDLE_PATTERN.test(thread.handle)) {
    throw new TypeError("mail handle must be a canonical STN handle");
  }
  for (const [field, value] of Object.entries({
    title: thread.title,
    changed: thread.changed,
    current: thread.current,
    nextAction: thread.nextAction,
    resolution: thread.resolution,
    strongestSource: thread.strongestSource,
  })) {
    if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  }
  parseTimestamp(thread.updatedAt, "updatedAt");
  if (thread.actionableAt !== null) parseTimestamp(thread.actionableAt, "actionableAt");
  if (thread.resolvedAt !== null) parseTimestamp(thread.resolvedAt, "resolvedAt");
  if (thread.state === "resolved" && thread.resolvedAt === null) {
    throw new TypeError("resolved threads require resolvedAt");
  }
  if (thread.state !== "resolved" && thread.resolvedAt !== null) {
    throw new TypeError("unresolved threads cannot carry resolvedAt");
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}
