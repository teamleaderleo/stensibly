import { createHash } from "node:crypto";

export const podParticipationModes = [
  "participant",
  "observer",
  "liaison",
] as const;

export type PodParticipationMode = typeof podParticipationModes[number];

const limits = {
  runId: 160,
  pod: 80,
  tag: 80,
  commitmentId: 160,
  relationId: 160,
  participations: 16,
  interests: 32,
  capabilities: 32,
  commitments: 50,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const sha256FingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const slugPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const podPattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface PodParticipationRequestEntryInput {
  pod: string;
  mode: PodParticipationMode;
  interests?: string[];
  capabilities?: string[];
  acceptedCommitmentIds?: string[];
}

export interface PodParticipationRequestInput {
  workerEnrolmentFingerprint: string;
  workerRunId: string;
  participations: PodParticipationRequestEntryInput[];
  startedAt: string;
  expiresAt: string;
  correlationId?: string;
  causationId?: string;
}

export interface PodParticipationRequestEntry {
  pod: string;
  mode: PodParticipationMode;
  interests: string[];
  capabilities: string[];
  acceptedCommitmentIds: string[];
}

export interface PodParticipationRequest {
  version: 1;
  workerEnrolmentFingerprint: string;
  workerRunId: string;
  participations: PodParticipationRequestEntry[];
  startedAt: string;
  expiresAt: string;
  correlationId: string | null;
  causationId: string | null;
  acceptsCommitments: boolean;
  participationActive: false;
  requiresDurableAcceptance: true;
  grantsMembership: false;
  grantsAuthority: false;
  fingerprint: string;
}

/**
 * Canonicalises a run-scoped request to participate in one or more pods.
 *
 * The result is an input boundary only. It does not activate participation,
 * enrol the worker, accept a durable invitation, grant membership, assign a
 * role, claim work, permit tools or repositories, or grant authority. A later
 * attributable durable acceptance record is required before participation is
 * active.
 */
export function buildPodParticipationRequest(
  input: PodParticipationRequestInput,
): PodParticipationRequest {
  const workerEnrolmentFingerprint = enrolmentFingerprint(
    input.workerEnrolmentFingerprint,
  );
  const workerRunId = runId(input.workerRunId);
  const participations = canonicalParticipations(input.participations);
  const startedAt = canonicalTimestamp(input.startedAt, "Participation start");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Participation expiry");
  if (Date.parse(expiresAt) <= Date.parse(startedAt)) {
    throw new RangeError("Participation expiry must be later than start");
  }
  const correlationId = input.correlationId === undefined
    ? null
    : boundedIdentifier(input.correlationId, "Correlation ID", limits.relationId);
  const causationId = input.causationId === undefined
    ? null
    : boundedIdentifier(input.causationId, "Causation ID", limits.relationId);
  const acceptsCommitments = participations.some(
    (participation) => participation.acceptedCommitmentIds.length > 0,
  );

  const canonical = {
    version: 1 as const,
    workerEnrolmentFingerprint,
    workerRunId,
    participations,
    startedAt,
    expiresAt,
    correlationId,
    causationId,
    acceptsCommitments,
    participationActive: false as const,
    requiresDurableAcceptance: true as const,
    grantsMembership: false as const,
    grantsAuthority: false as const,
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;

  return { ...canonical, fingerprint };
}

function canonicalParticipations(
  values: PodParticipationRequestEntryInput[],
): PodParticipationRequestEntry[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > limits.participations) {
    throw new RangeError(
      `Pod participation list must contain 1 to ${limits.participations} entries`,
    );
  }

  const byPod = new Map<string, PodParticipationMode>();
  const acceptedCommitments = new Set<string>();
  const canonical = values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new RangeError("Pod participation entry must be an object");
    }
    const pod = boundedPod(value.pod);
    const mode = participationMode(value.mode);
    const previousMode = byPod.get(pod);
    if (previousMode !== undefined) {
      if (previousMode !== mode) {
        throw new RangeError(
          `Pod participation contains conflicting modes for pod ${pod}`,
        );
      }
      throw new RangeError(`Pod participation contains duplicate pod ${pod}`);
    }
    byPod.set(pod, mode);

    const interests = boundedSlugList(
      value.interests ?? [],
      "Interest",
      limits.interests,
    );
    const capabilities = boundedSlugList(
      value.capabilities ?? [],
      "Capability",
      limits.capabilities,
    );
    const acceptedCommitmentIds = boundedIdentifierList(
      value.acceptedCommitmentIds ?? [],
      "Accepted commitment ID",
      limits.commitmentId,
      limits.commitments,
    );
    if (mode === "observer" && acceptedCommitmentIds.length > 0) {
      throw new RangeError("Observer participation cannot accept commitments");
    }
    for (const commitmentId of acceptedCommitmentIds) {
      if (acceptedCommitments.has(commitmentId)) {
        throw new RangeError(
          `Accepted commitment ID ${commitmentId} appears in more than one pod participation`,
        );
      }
      acceptedCommitments.add(commitmentId);
    }

    return {
      pod,
      mode,
      interests,
      capabilities,
      acceptedCommitmentIds,
    };
  });

  return canonical.sort((left, right) => compareCodePoints(left.pod, right.pod));
}

function enrolmentFingerprint(value: string): string {
  assertSafeText(value, "Worker enrolment fingerprint");
  const normalized = value.trim().toLowerCase();
  if (!sha256FingerprintPattern.test(normalized)) {
    throw new RangeError(
      "Worker enrolment fingerprint must be sha256 followed by 64 lowercase hexadecimal characters",
    );
  }
  return normalized;
}

function runId(value: string): string {
  const normalized = boundedText(value, "Worker run ID", limits.runId);
  if (!runIdPattern.test(normalized)) {
    throw new RangeError(
      "Worker run ID must start with run_ and contain only letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  return normalized;
}

function boundedPod(value: string): string {
  assertSafeText(value, "Pod");
  const normalized = value.trim().toLowerCase();
  if ([...normalized].length > limits.pod) {
    throw new RangeError(`Pod must be at most ${limits.pod} characters`);
  }
  if (!podPattern.test(normalized)) {
    throw new RangeError("Pod must be a lowercase pod slug");
  }
  return normalized;
}

function participationMode(value: PodParticipationMode): PodParticipationMode {
  if (!podParticipationModes.includes(value)) {
    throw new RangeError(`Unknown pod participation mode: ${String(value)}`);
  }
  return value;
}

function boundedSlugList(
  values: string[],
  label: string,
  maximumItems: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new RangeError(`${label} list must contain 0 to ${maximumItems} entries`);
  }
  return canonicalUniqueList(
    values.map((value) => boundedSlug(value, label, limits.tag)),
    label,
  );
}

function boundedIdentifierList(
  values: string[],
  label: string,
  maximumLength: number,
  maximumItems: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new RangeError(`${label} list must contain 0 to ${maximumItems} entries`);
  }
  return canonicalUniqueList(
    values.map((value) => boundedIdentifier(value, label, maximumLength)),
    label,
  );
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

function boundedIdentifier(value: string, label: string, maximumLength: number): string {
  const normalized = boundedText(value, label, maximumLength);
  if (!identifierPattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function boundedText(value: string, label: string, maximumLength: number): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function canonicalUniqueList(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new RangeError(`${label} list contains duplicate entries`);
    seen.add(value);
  }
  return [...seen].sort(compareCodePoints);
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

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeText(value: string, label: string): void {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
}
