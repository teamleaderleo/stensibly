import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";

export interface McpSetupEvidence {
  readonly version: 1;
  readonly accountId: string;
  readonly project: string;
  readonly connectedAt: string | null;
  readonly firstReadAt: string | null;
  readonly containsSecrets: false;
}

export interface McpSetupEvidenceReader {
  getMcpSetupEvidence(input: {
    accountId: string;
    project: string;
  }): Promise<McpSetupEvidence>;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function admitMcpSetupEvidence(
  value: unknown,
  expected: { accountId: string; project: string },
): McpSetupEvidence {
  const record = exactRecord(value, [
    "version",
    "accountId",
    "project",
    "connectedAt",
    "firstReadAt",
    "containsSecrets",
  ]);
  const accountId = exactIdentity(record.accountId, "MCP setup account", 160);
  const project = exactProject(record.project);
  if (
    accountId !== exactIdentity(expected.accountId, "Expected MCP setup account", 160)
    || project !== exactProject(expected.project)
  ) {
    throw new Error("MCP setup evidence scope is invalid");
  }
  if (record.version !== 1 || record.containsSecrets !== false) {
    throw new Error("MCP setup evidence contract is invalid");
  }
  const connectedAt = nullableTimestamp(record.connectedAt, "MCP connection time");
  const firstReadAt = nullableTimestamp(record.firstReadAt, "MCP first-read time");
  if (firstReadAt !== null && connectedAt === null) {
    throw new Error("MCP first-read evidence requires connection evidence");
  }
  if (
    connectedAt !== null
    && firstReadAt !== null
    && Date.parse(firstReadAt) < Date.parse(connectedAt)
  ) {
    throw new Error("MCP first-read evidence predates connection evidence");
  }
  return Object.freeze({
    version: 1 as const,
    accountId,
    project,
    connectedAt,
    firstReadAt,
    containsSecrets: false as const,
  });
}

export function emptyMcpSetupEvidence(input: {
  accountId: string;
  project: string;
}): McpSetupEvidence {
  return Object.freeze({
    version: 1 as const,
    accountId: exactIdentity(input.accountId, "MCP setup account", 160),
    project: exactProject(input.project),
    connectedAt: null,
    firstReadAt: null,
    containsSecrets: false as const,
  });
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("MCP setup evidence is invalid");
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error("MCP setup evidence is invalid");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw new Error("MCP setup evidence is invalid");
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      throw new Error("MCP setup evidence is invalid");
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("MCP setup evidence is invalid");
    }
    result[field] = descriptor.value;
  }
  return result;
}

function exactIdentity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || containsRealisticRetainedCredential(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function exactProject(value: unknown): string {
  const project = exactIdentity(value, "MCP setup project", 80);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(project)) {
    throw new Error("MCP setup project is invalid");
  }
  return project;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
