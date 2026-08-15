export const mailThreadClasses = [
  "handoff",
  "review",
  "decision",
  "incident",
] as const;
export type MailThreadClass = (typeof mailThreadClasses)[number];

export const mailThreadStates = [
  "open",
  "quiet",
  "resolved",
  "superseded",
] as const;
export type MailThreadState = (typeof mailThreadStates)[number];

export type MailThreadHandle = `STN-${"HANDOFF" | "REVIEW" | "DECISION" | "INCIDENT"}:${string}`;

export interface MailThreadRecord {
  version: 1;
  threadId: string;
  handle: MailThreadHandle;
  workspace: string;
  project: string;
  threadClass: MailThreadClass;
  canonicalSubject: string;
  sourceIdentity: string;
  currentMaterialFingerprint: string | null;
  resolutionCondition: string;
  state: MailThreadState;
  continuesFromThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface CreateMailThreadRecordInput {
  threadId: string;
  handle: string;
  workspace: string;
  project: string;
  threadClass: MailThreadClass;
  canonicalSubject: string;
  sourceIdentity: string;
  resolutionCondition: string;
  continuesFromThreadId?: string | null;
  createdAt: string;
}

const classSet = new Set<string>(mailThreadClasses);
const stateSet = new Set<string>(mailThreadStates);
// Match the landed #1494 human-copyable alphabet: omit 0/O and 1/I/L.
const handleAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const handlePattern = /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8})$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const credentialShapedPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{24,}|bearer\s+[A-Za-z0-9._~+\/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

export function mailThreadHandlePrefix(threadClass: MailThreadClass): string {
  switch (threadClass) {
    case "handoff": return "STN-HANDOFF";
    case "review": return "STN-REVIEW";
    case "decision": return "STN-DECISION";
    case "incident": return "STN-INCIDENT";
  }
}

export function createMailThreadHandle(
  threadClass: MailThreadClass,
  token: string,
): MailThreadHandle {
  if (!classSet.has(threadClass)) throw new TypeError("Mail thread class is invalid");
  if (typeof token !== "string") throw new TypeError("Mail thread handle token is invalid");
  const normalized = token.toUpperCase();
  if (
    normalized.length < 4
    || normalized.length > 8
    || [...normalized].some((character) => !handleAlphabet.includes(character))
  ) {
    throw new TypeError("Mail thread handle token is invalid");
  }
  return `${mailThreadHandlePrefix(threadClass)}:${normalized}` as MailThreadHandle;
}

export function generateMailThreadHandle(
  threadClass: MailThreadClass,
  tokenLength = 6,
  entropy: Uint8Array = secureMailThreadEntropy(tokenLength),
): MailThreadHandle {
  if (!Number.isInteger(tokenLength) || tokenLength < 4 || tokenLength > 8) {
    throw new RangeError("Mail thread handle length is invalid");
  }
  if (!(entropy instanceof Uint8Array) || entropy.byteLength < tokenLength) {
    throw new TypeError("Mail thread handle entropy is invalid");
  }
  let token = "";
  for (let index = 0; index < tokenLength; index += 1) {
    token += handleAlphabet[entropy[index]! % handleAlphabet.length];
  }
  return createMailThreadHandle(threadClass, token);
}

export function parseMailThreadHandle(value: unknown): MailThreadHandle {
  if (typeof value !== "string") throw new TypeError("Mail thread handle is invalid");
  const normalized = value.toUpperCase();
  if (!handlePattern.test(normalized)) throw new TypeError("Mail thread handle is invalid");
  return normalized as MailThreadHandle;
}

export function createMailThreadRecord(
  input: CreateMailThreadRecordInput,
): MailThreadRecord {
  const threadClass = exactThreadClass(input.threadClass);
  const handle = parseMailThreadHandle(input.handle);
  if (!handle.startsWith(`${mailThreadHandlePrefix(threadClass)}:`)) {
    throw new TypeError("Mail thread handle class does not match thread class");
  }
  const createdAt = exactTimestamp(input.createdAt, "Mail thread creation time");
  return freezeMailThreadRecord({
    version: 1,
    threadId: exactIdentifier(input.threadId, "Mail thread ID", 240),
    handle,
    workspace: exactIdentifier(input.workspace, "Mail thread workspace", 120),
    project: exactIdentifier(input.project, "Mail thread project", 120),
    threadClass,
    canonicalSubject: exactDisplayText(input.canonicalSubject, "Mail thread subject", 240),
    sourceIdentity: exactIdentifier(input.sourceIdentity, "Mail thread source identity", 320),
    currentMaterialFingerprint: null,
    resolutionCondition: exactDisplayText(
      input.resolutionCondition,
      "Mail thread resolution condition",
      800,
    ),
    state: "open",
    continuesFromThreadId: input.continuesFromThreadId === undefined || input.continuesFromThreadId === null
      ? null
      : exactIdentifier(input.continuesFromThreadId, "Mail thread parent ID", 240),
    createdAt,
    updatedAt: createdAt,
    resolvedAt: null,
  });
}

export function updateMailThreadMaterial(
  current: MailThreadRecord,
  input: {
    materialFingerprint: string;
    resolutionCondition: string;
    state: MailThreadState;
    updatedAt: string;
  },
): MailThreadRecord {
  const record = freezeMailThreadRecord(current);
  const nextState = exactThreadState(input.state);
  if (
    (record.state === "resolved" || record.state === "superseded")
    && nextState !== record.state
  ) {
    throw new Error("Terminal mail thread state cannot be reopened");
  }
  const updatedAt = exactTimestamp(input.updatedAt, "Mail thread update time");
  if (Date.parse(updatedAt) < Date.parse(record.updatedAt)) {
    throw new RangeError("Mail thread update time cannot move backwards");
  }
  const resolvedAt = nextState === "resolved"
    ? record.resolvedAt ?? updatedAt
    : record.resolvedAt;
  return freezeMailThreadRecord({
    ...record,
    currentMaterialFingerprint: exactSha256(
      input.materialFingerprint,
      "Mail thread material fingerprint",
    ),
    resolutionCondition: exactDisplayText(
      input.resolutionCondition,
      "Mail thread resolution condition",
      800,
    ),
    state: nextState,
    updatedAt,
    resolvedAt,
  });
}

export function freezeMailThreadRecord(input: MailThreadRecord): MailThreadRecord {
  if (input.version !== 1) throw new TypeError("Mail thread version is invalid");
  const threadClass = exactThreadClass(input.threadClass);
  const handle = parseMailThreadHandle(input.handle);
  if (!handle.startsWith(`${mailThreadHandlePrefix(threadClass)}:`)) {
    throw new TypeError("Mail thread handle class does not match thread class");
  }
  const state = exactThreadState(input.state);
  const createdAt = exactTimestamp(input.createdAt, "Mail thread creation time");
  const updatedAt = exactTimestamp(input.updatedAt, "Mail thread update time");
  const resolvedAt = input.resolvedAt === null
    ? null
    : exactTimestamp(input.resolvedAt, "Mail thread resolution time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError("Mail thread update time precedes creation");
  }
  if (resolvedAt !== null && state !== "resolved") {
    throw new TypeError("Only resolved mail threads may carry a resolution time");
  }
  if (state === "resolved" && resolvedAt === null) {
    throw new TypeError("Resolved mail thread requires a resolution time");
  }
  return Object.freeze({
    version: 1,
    threadId: exactIdentifier(input.threadId, "Mail thread ID", 240),
    handle,
    workspace: exactIdentifier(input.workspace, "Mail thread workspace", 120),
    project: exactIdentifier(input.project, "Mail thread project", 120),
    threadClass,
    canonicalSubject: exactDisplayText(input.canonicalSubject, "Mail thread subject", 240),
    sourceIdentity: exactIdentifier(input.sourceIdentity, "Mail thread source identity", 320),
    currentMaterialFingerprint: input.currentMaterialFingerprint === null
      ? null
      : exactSha256(input.currentMaterialFingerprint, "Mail thread material fingerprint"),
    resolutionCondition: exactDisplayText(
      input.resolutionCondition,
      "Mail thread resolution condition",
      800,
    ),
    state,
    continuesFromThreadId: input.continuesFromThreadId === null
      ? null
      : exactIdentifier(input.continuesFromThreadId, "Mail thread parent ID", 240),
    createdAt,
    updatedAt,
    resolvedAt,
  });
}

export function exactMailThreadIdentifier(
  value: unknown,
  label: string,
  max = 320,
): string {
  return exactIdentifier(value, label, max);
}

export function exactMailThreadTimestamp(value: unknown, label: string): string {
  return exactTimestamp(value, label);
}

export function exactMailThreadSha256(value: unknown, label: string): string {
  return exactSha256(value, label);
}

export function exactMailDisplayText(value: unknown, label: string, max: number): string {
  return exactDisplayText(value, label, max);
}

function secureMailThreadEntropy(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function exactThreadClass(value: unknown): MailThreadClass {
  if (typeof value !== "string" || !classSet.has(value)) {
    throw new TypeError("Mail thread class is invalid");
  }
  return value as MailThreadClass;
}

function exactThreadState(value: unknown): MailThreadState {
  if (typeof value !== "string" || !stateSet.has(value)) {
    throw new TypeError("Mail thread state is invalid");
  }
  return value as MailThreadState;
}

function exactIdentifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/u.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactDisplayText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || controlPattern.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
