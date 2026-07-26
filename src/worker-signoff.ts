const limits = {
  callsign: 80,
  mantleName: 80,
  pod: 120,
  stance: 160,
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
  mantle?: WorkerMantleSignoffInput;
  pod?: string;
  runId: string;
  stance: string;
  work: string;
  reviewedRevision?: string;
}

export interface WorkerSignoff {
  version: 1;
  callsign: string;
  mantle: { name: string; version: number } | null;
  pod: string | null;
  runId: string;
  stance: string;
  work: string;
  reviewedRevision: string | null;
  markdown: string;
}

/**
 * Builds descriptive attribution only. The result does not grant or prove
 * authority, ownership, repository access, competence, or review approval.
 */
export function buildWorkerSignoff(input: WorkerSignoffInput): WorkerSignoff {
  const callsign = boundedText(input.callsign, "Worker callsign", limits.callsign);
  const mantle = input.mantle === undefined
    ? null
    : {
      name: boundedText(input.mantle.name, "Mantle name", limits.mantleName),
      version: mantleVersion(input.mantle.version),
    };
  const pod = input.pod === undefined
    ? null
    : boundedText(input.pod, "Pod name", limits.pod);
  const runId = workerRunId(input.runId);
  const stance = boundedText(input.stance, "Worker stance", limits.stance);
  const work = boundedText(input.work, "Work address", limits.work);
  const reviewedRevision = input.reviewedRevision === undefined
    ? null
    : reviewedCommit(input.reviewedRevision);

  const identityParts = [escapeMarkdown(callsign)];
  if (mantle) {
    identityParts.push(`${escapeMarkdown(mantle.name)} mantle v${mantle.version}`);
  }
  if (pod) identityParts.push(`${escapeMarkdown(pod)} pod`);

  const lines = [
    `— ${identityParts.join(" · ")}`,
    `  Run: ${runId}`,
    `  Stance: ${escapeMarkdown(stance)}`,
    `  Work: ${escapeMarkdown(work)}`,
  ];
  if (reviewedRevision) {
    lines.push(`  Reviewed revision: ${reviewedRevision}`);
  }

  return {
    version: 1,
    callsign,
    mantle,
    pod,
    runId,
    stance,
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
