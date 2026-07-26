import { createHash } from "node:crypto";

const limits = {
  adapter: 80,
  profile: 120,
  workerSessionId: 160,
  callsign: 80,
  capability: 80,
  tool: 120,
  project: 80,
  stance: 80,
  relationId: 160,
  capabilities: 32,
  tools: 100,
  projects: 50,
  stances: 16,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const slugPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface WorkerEnrolmentRequestInput {
  adapter: string;
  profile: string;
  workerSessionId: string;
  callsign?: string;
  capabilities: string[];
  toolAllowlist?: string[];
  projectScope: string[];
  preferredStances?: string[];
  startedAt: string;
  expiresAt: string;
  heartbeatSeconds: number;
  correlationId?: string;
  causationId?: string;
}

export interface WorkerEnrolmentRequest {
  version: 1;
  adapter: string;
  profile: string;
  workerSessionId: string;
  callsign: string | null;
  capabilities: string[];
  toolAllowlist: string[];
  projectScope: string[];
  preferredStances: string[];
  startedAt: string;
  expiresAt: string;
  heartbeatSeconds: number;
  correlationId: string | null;
  causationId: string | null;
  grantsAuthority: false;
  fingerprint: string;
}

/**
 * Canonicalises a worker's requested enrolment metadata for later durable
 * replay checks. The result grants no workspace membership, project access,
 * tool permission, claim, run lease, repository access, or execution authority.
 */
export function buildWorkerEnrolmentRequest(
  input: WorkerEnrolmentRequestInput,
): WorkerEnrolmentRequest {
  const adapter = boundedSlug(input.adapter, "Runner adapter", limits.adapter);
  const profile = boundedSlug(input.profile, "Runner profile", limits.profile);
  const workerSessionId = boundedIdentifier(
    input.workerSessionId,
    "Worker session ID",
    limits.workerSessionId,
  );
  const callsign = input.callsign === undefined
    ? null
    : boundedText(input.callsign, "Worker callsign", limits.callsign);
  const capabilities = boundedSlugList(
    input.capabilities,
    "Capability",
    limits.capability,
    1,
    limits.capabilities,
  );
  const toolAllowlist = boundedSlugList(
    input.toolAllowlist ?? [],
    "Tool",
    limits.tool,
    0,
    limits.tools,
  );
  const projectScope = boundedProjectList(
    input.projectScope,
    1,
    limits.projects,
  );
  const preferredStances = boundedSlugList(
    input.preferredStances ?? [],
    "Preferred stance",
    limits.stance,
    0,
    limits.stances,
  );
  const startedAt = canonicalTimestamp(input.startedAt, "Enrolment start");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Enrolment expiry");
  const heartbeatSeconds = boundedHeartbeat(input.heartbeatSeconds);
  const startedMs = Date.parse(startedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= startedMs) {
    throw new RangeError("Enrolment expiry must be later than start");
  }
  if (expiresMs - startedMs < heartbeatSeconds * 1_000) {
    throw new RangeError("Enrolment lifetime must include at least one heartbeat interval");
  }
  const correlationId = input.correlationId === undefined
    ? null
    : boundedIdentifier(input.correlationId, "Correlation ID", limits.relationId);
  const causationId = input.causationId === undefined
    ? null
    : boundedIdentifier(input.causationId, "Causation ID", limits.relationId);

  const canonical = {
    version: 1 as const,
    adapter,
    profile,
    workerSessionId,
    callsign,
    capabilities,
    toolAllowlist,
    projectScope,
    preferredStances,
    startedAt,
    expiresAt,
    heartbeatSeconds,
    correlationId,
    causationId,
    grantsAuthority: false as const,
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;

  return { ...canonical, fingerprint };
}

function boundedText(value: string, label: string, maximumLength: number): string {
  assertSafeText(value, label);
  const normalized = value.trim().replace(/ {2,}/g, " ");
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function boundedSlug(value: string, label: string, maximumLength: number): string {
  assertSafeText(value, label);
  const normalized = value.trim().toLowerCase();
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  if (!slugPattern.test(normalized)) {
    throw new RangeError(`${label} must be a lowercase slug`);
  }
  return normalized;
}

function boundedProject(value: string): string {
  assertSafeText(value, "Project");
  const normalized = value.trim().toLowerCase();
  if ([...normalized].length > limits.project) {
    throw new RangeError(`Project must be at most ${limits.project} characters`);
  }
  if (!projectPattern.test(normalized)) {
    throw new RangeError("Project must be a lowercase project slug");
  }
  return normalized;
}

function boundedIdentifier(value: string, label: string, maximumLength: number): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  if (!identifierPattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function boundedSlugList(
  values: string[],
  label: string,
  maximumEntryLength: number,
  minimumItems: number,
  maximumItems: number,
): string[] {
  if (!Array.isArray(values) || values.length < minimumItems || values.length > maximumItems) {
    throw new RangeError(`${label} list must contain ${minimumItems} to ${maximumItems} entries`);
  }
  return canonicalUniqueList(
    values.map((value) => boundedSlug(value, label, maximumEntryLength)),
    label,
  );
}

function boundedProjectList(
  values: string[],
  minimumItems: number,
  maximumItems: number,
): string[] {
  if (!Array.isArray(values) || values.length < minimumItems || values.length > maximumItems) {
    throw new RangeError(`Project scope must contain ${minimumItems} to ${maximumItems} entries`);
  }
  return canonicalUniqueList(values.map(boundedProject), "Project");
}

function canonicalUniqueList(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new RangeError(`${label} list contains duplicate entries`);
    seen.add(value);
  }
  return [...seen].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, label: string): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if (!timestampPattern.test(normalized)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  const comparableInput = normalized.includes(".")
    ? normalized
    : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparableInput) {
    throw new RangeError(`${label} must be a valid calendar timestamp`);
  }
  return canonical;
}

function boundedHeartbeat(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 86_400) {
    throw new RangeError("Heartbeat interval must be an integer from 30 to 86400 seconds");
  }
  return value;
}

function assertSafeText(value: string, label: string): void {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
}
