import {
  parseMailThreadHandle,
  type MailThreadHandle,
} from "./mail-thread-contract.js";

export type MailPublicHandle = `${string}-${"HANDOFF" | "REVIEW" | "DECISION" | "INCIDENT"}:${string}`;

export interface MailPublicHandleAliasRecord {
  readonly version: 1;
  readonly threadId: string;
  readonly project: string;
  readonly projectCode: string;
  readonly internalHandle: MailThreadHandle;
  readonly preferredPublicHandle: MailPublicHandle;
  readonly legacyPublicHandles: readonly MailPublicHandle[];
}

const projectCodePattern = /^[A-HJKMNP-Z2-9]{2,8}$/u;
const publicHandlePattern = /^([A-HJKMNP-Z2-9]{2,8})-(HANDOFF|REVIEW|DECISION|INCIDENT):([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8})$/u;

export function parseMailProjectCode(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Mail project code is invalid");
  const normalized = value.toUpperCase();
  if (!projectCodePattern.test(normalized)) {
    throw new TypeError("Mail project code is invalid");
  }
  return normalized;
}

export function parseMailPublicHandle(value: unknown): MailPublicHandle {
  if (typeof value !== "string") throw new TypeError("Mail public handle is invalid");
  const normalized = value.toUpperCase();
  if (!publicHandlePattern.test(normalized)) {
    throw new TypeError("Mail public handle is invalid");
  }
  return normalized as MailPublicHandle;
}

export function createMailPublicHandle(
  projectCode: string,
  internalHandle: string,
): MailPublicHandle {
  const code = parseMailProjectCode(projectCode);
  const internal = parseMailThreadHandle(internalHandle);
  const separator = internal.indexOf(":");
  const className = internal.slice("STN-".length, separator);
  const token = internal.slice(separator + 1);
  return parseMailPublicHandle(`${code}-${className}:${token}`);
}

export function createMailPublicHandleAliasRecord(input: {
  threadId: string;
  project: string;
  projectCode: string;
  internalHandle: string;
  legacyPublicHandles?: readonly string[];
}): MailPublicHandleAliasRecord {
  const threadId = exactIdentifier(input.threadId, "Mail thread ID", 240);
  const project = exactIdentifier(input.project, "Mail project", 120);
  const projectCode = parseMailProjectCode(input.projectCode);
  const internalHandle = parseMailThreadHandle(input.internalHandle);
  const preferredPublicHandle = createMailPublicHandle(projectCode, internalHandle);
  const canonicalSuffix = handleSuffix(internalHandle);
  const legacy = input.legacyPublicHandles ?? [internalHandle];
  if (!Array.isArray(legacy) || legacy.length > 8) {
    throw new TypeError("Mail public handle aliases are invalid");
  }

  const seen = new Set<string>([preferredPublicHandle]);
  const legacyPublicHandles: MailPublicHandle[] = [];
  for (const value of legacy) {
    const handle = parseMailPublicHandle(value);
    if (handleSuffix(handle) !== canonicalSuffix) {
      throw new TypeError("Mail public handle alias does not identify the same continuation token and class");
    }
    if (seen.has(handle)) continue;
    seen.add(handle);
    legacyPublicHandles.push(handle);
  }

  return Object.freeze({
    version: 1 as const,
    threadId,
    project,
    projectCode,
    internalHandle,
    preferredPublicHandle,
    legacyPublicHandles: Object.freeze(legacyPublicHandles),
  });
}

export function resolveMailPublicHandle(
  record: MailPublicHandleAliasRecord,
  handle: string,
): MailThreadHandle | null {
  const frozen = freezeMailPublicHandleAliasRecord(record);
  const candidate = parseMailPublicHandle(handle);
  if (
    candidate === frozen.preferredPublicHandle
    || frozen.legacyPublicHandles.includes(candidate)
  ) {
    return frozen.internalHandle;
  }
  return null;
}

export function freezeMailPublicHandleAliasRecord(
  input: MailPublicHandleAliasRecord,
): MailPublicHandleAliasRecord {
  if (input.version !== 1) {
    throw new TypeError("Mail public handle alias version is invalid");
  }
  return createMailPublicHandleAliasRecord({
    threadId: input.threadId,
    project: input.project,
    projectCode: input.projectCode,
    internalHandle: input.internalHandle,
    legacyPublicHandles: input.legacyPublicHandles,
  });
}

function handleSuffix(handle: string): string {
  const separator = handle.indexOf("-");
  return handle.slice(separator + 1);
}

function exactIdentifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
