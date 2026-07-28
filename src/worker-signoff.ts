const limits = {
  callsign: 80,
  mantleName: 80,
  pod: 120,
  intention: 240,
  work: 320,
  runId: 160,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const revisionPattern = /^[a-fA-F0-9]{7,64}$/;

export interface WorkerMantleSignoffInput {
  name: string;
  version: number;
}

export interface WorkerSignoffInput {
  callsign: string;
  callsignLeaseGeneration?: number;
  mantle?: WorkerMantleSignoffInput;
  pod?: string;
  intention?: string;
  runId?: string;
  work?: string;
  reviewedRevision?: string;
}

export interface WorkerSignoff {
  version: 3;
  callsign: string;
  callsignLeaseGeneration: number | null;
  mantle: { name: string; version: number } | null;
  pod: string | null;
  intention: string | null;
  runId: string | null;
  work: string | null;
  reviewedRevision: string | null;
  markdown: string;
}

/**
 * Builds descriptive attribution only. The result does not grant or prove
 * authority, ownership, repository access, competence, or review approval.
 *
 * Routine output needs only a callsign, with pod and intention when useful.
 * Run, work, mantle, lease generation, and revision metadata are optional
 * expanded provenance.
 *
 * A caller may provide callsignLeaseGeneration only from an accepted canonical
 * callsign lease. This helper validates the number and renders it; it cannot
 * prove that a lease exists.
 */
export function buildWorkerSignoff(input: WorkerSignoffInput): WorkerSignoff {
  const callsign = boundedText(input.callsign, "Worker callsign", limits.callsign);
  const callsignLeaseGeneration = input.callsignLeaseGeneration === undefined
    ? null
    : leaseGeneration(input.callsignLeaseGeneration);
  const mantle = input.mantle === undefined
    ? null
    : {
      name: boundedText(input.mantle.name, "Mantle name", limits.mantleName),
      version: mantleVersion(input.mantle.version),
    };
  const pod = input.pod === undefined
    ? null
    : boundedText(input.pod, "Pod name", limits.pod);
  const intention = input.intention === undefined
    ? null
    : boundedText(input.intention, "Worker intention", limits.intention);
  const runId = input.runId === undefined ? null : workerRunId(input.runId);
  const work = input.work === undefined
    ? null
    : boundedText(input.work, "Work address", limits.work);
  const reviewedRevision = input.reviewedRevision === undefined
    ? null
    : reviewedCommit(input.reviewedRevision);

  const callsignDisplay = callsignLeaseGeneration === null
    ? escapeMarkdown(callsign)
    : `${escapeMarkdown(callsign)} g${callsignLeaseGeneration}`;
  const identityParts = [callsignDisplay];
  if (mantle) {
    identityParts.push(`${escapeMarkdown(mantle.name)} mantle v${mantle.version}`);
  }
  if (pod) identityParts.push(escapeMarkdown(pod));

  const lines = [`— ${identityParts.join(" · ")}`];
  if (intention) lines.push(`  Intention: ${escapeMarkdown(intention)}`);
  if (runId) lines.push(`  Run: ${runId}`);
  if (work) lines.push(`  Work: ${escapeMarkdown(work)}`);
  if (reviewedRevision) {
    lines.push(`  Reviewed revision: ${reviewedRevision}`);
  }

  return {
    version: 3,
    callsign,
    callsignLeaseGeneration,
    mantle,
    pod,
    intention,
    runId,
    work,
    reviewedRevision,
    markdown: lines.join("\n"),
  };
}

function boundedText(value: string, label: string, maximumLength: number): string {
  if (unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const normalized = value.trim().replace(/ {2,}/g, " ");
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function leaseGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new RangeError(
      "Callsign lease generation must be an integer from 1 to 1000000000",
    );
  }
  return value;
}

function mantleVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 9_999) {
    throw new RangeError("Mantle version must be an integer from 1 to 9999");
  }
  return value;
}

function workerRunId(value: string): string {
  const normalized = boundedText(value, "Run ID", limits.runId);
  if (!runIdPattern.test(normalized)) {
    throw new RangeError("Run ID must start with run_ and contain only letters, digits, dot, underscore, colon, or hyphen");
  }
  return normalized;
}

function reviewedCommit(value: string): string {
  if (unsafeTextPattern.test(value)) {
    throw new RangeError("Reviewed revision contains unsupported control characters");
  }
  const normalized = value.trim();
  if (!revisionPattern.test(normalized)) {
    throw new RangeError("Reviewed revision must be 7 to 64 hexadecimal characters");
  }
  return normalized.toLowerCase();
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_\[\]<>]/g, "\\$&");
}
