import { createHash } from "node:crypto";
import { z } from "zod";

export const SMOLRUNNER_RECEIPT_INTAKE_SCHEMA_VERSION = 1 as const;

export const smolRunnerReceiptStates = [
  "queued",
  "reserved",
  "starting",
  "running",
  "verifying",
  "waiting_external",
  "continuation_required",
  "failed",
  "completed",
  "cancelled",
  "unavailable",
] as const;

export const smolRunnerTransitionKinds = [
  "queue_recorded",
  "reservation_recorded",
  "execution_started",
  "progress_checkpoint",
  "continuation_required",
  "execution_failed",
  "execution_completed",
  "cancellation_acknowledged",
  "executor_unavailable",
] as const;

export type SmolRunnerReceiptState = typeof smolRunnerReceiptStates[number];
export type SmolRunnerTransitionKind = typeof smolRunnerTransitionKinds[number];

const terminalStates = new Set<SmolRunnerReceiptState>([
  "failed",
  "completed",
  "cancelled",
  "unavailable",
]);
const heartbeatStates = new Set<SmolRunnerReceiptState>([
  "starting",
  "running",
  "verifying",
]);
const startedStates = new Set<SmolRunnerReceiptState>([
  "starting",
  "running",
  "verifying",
  "waiting_external",
  "continuation_required",
  "completed",
]);

const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const lowerTokenPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const executionIdPattern = /^exec_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const attemptIdPattern = /^attempt_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const workspaceReceiptPattern = /^smolrunner:workspace:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const logReferencePattern = /^smolrunner:log:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const artifactReferencePattern = /^smolrunner:artifact:sha256:[a-f0-9]{64}$/;
const refPattern = /^(?:refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,220}|[a-f0-9]{40})$/;

const boundedGeneration = z.number().int().min(0).max(1_000_000_000);
const boundedCount = z.number().int().min(0).max(1_000_000);
const canonicalTimestamp = z.string().max(32).refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Timestamp must be canonical ISO-8601 UTC with milliseconds");
const token = z.string().regex(tokenPattern);
const lowerToken = z.string().regex(lowerTokenPattern);
const digest = z.string().regex(digestPattern);
const revision = z.string().regex(revisionPattern);

const authoritySchema = z.object({
  merge: z.literal(false),
  deploy: z.literal(false),
  credentials: z.literal(false),
  spending: z.literal(false),
  providerAdministration: z.literal(false),
}).strict();

const coverageSchema = z.object({
  state: z.enum(["complete", "partial"]),
  truncated: z.boolean(),
  omitted: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.state === "complete" && (value.truncated || value.omitted)) {
    context.addIssue({
      code: "custom",
      message: "Complete receipt coverage cannot be truncated or omitted",
    });
  }
});

const progressSchema = z.object({
  completed: boundedCount,
  total: boundedCount.nullable(),
  unit: z.enum(["actions", "tests", "files", "phases"]),
}).strict().superRefine((value, context) => {
  if (value.total !== null && value.completed > value.total) {
    context.addIssue({
      code: "custom",
      message: "Progress completed cannot exceed total",
    });
  }
});

const outcomeCountsSchema = z.object({
  completed: boundedCount,
  failed: boundedCount,
  skipped: boundedCount,
  compensated: boundedCount,
  rolledBack: boundedCount,
  rollbackFailed: boundedCount,
}).strict();

const reservationSchema = z.object({
  id: token,
  generation: boundedGeneration,
  expiresAt: canonicalTimestamp,
}).strict();

const heartbeatSchema = z.object({
  intervalSeconds: z.number().int().min(1).max(60),
  leaseExpiresAt: canonicalTimestamp,
}).strict();

const queueSchema = z.object({
  admittedAt: canonicalTimestamp,
  position: z.union([boundedCount, z.literal("unknown")]),
  capacityState: z.enum(["available", "busy", "reserved", "unavailable", "unknown"]),
}).strict();

export const smolRunnerAttemptBindingSchema = z.object({
  attemptId: z.string().regex(attemptIdPattern),
  workspaceId: token,
  projectId: token,
  itemId: token,
  claimGeneration: boundedGeneration,
  runId: z.string().regex(runIdPattern),
  runGeneration: boundedGeneration,
  leaseGeneration: boundedGeneration,
  executionEnvelopeVersion: z.number().int().min(1).max(65_535),
  executorAdapter: z.literal("smolrunner"),
  runnerProfileId: lowerToken,
  repository: z.string().regex(repositoryPattern),
  requestedBase: z.string().max(240).regex(refPattern).refine(
    (value) => !value.includes("..") && !value.includes("@{") && !value.includes("\\"),
    "Requested base contains an unsafe ref form",
  ),
  resolvedBaseCommit: revision,
  candidateHead: revision.nullable(),
  verificationProfileId: lowerToken,
  workspaceReceiptRef: z.string().regex(workspaceReceiptPattern),
}).strict();

export const smolRunnerPublicReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  producer: z.object({
    name: z.literal("smolrunner"),
    version: token,
  }).strict(),
  executionId: z.string().regex(executionIdPattern),
  checkpointGeneration: z.number().int().min(1).max(1_000_000_000),
  executionEnvelopeVersion: z.number().int().min(1).max(65_535),
  operation: z.object({
    family: lowerToken,
    schemaVersion: z.number().int().min(1).max(65_535),
  }).strict(),
  repository: z.string().regex(repositoryPattern),
  runnerProfileId: lowerToken,
  profileId: lowerToken,
  workspaceReceiptRef: z.string().regex(workspaceReceiptPattern),
  source: z.object({
    digest,
    commit: revision,
    tree: revision,
  }).strict(),
  phaseId: lowerToken,
  state: z.enum(smolRunnerReceiptStates),
  observedAt: canonicalTimestamp,
  startedAt: canonicalTimestamp.nullable(),
  terminalAt: canonicalTimestamp.nullable(),
  queue: queueSchema.nullable(),
  reservation: reservationSchema.nullable(),
  heartbeat: heartbeatSchema.nullable(),
  progress: progressSchema.nullable(),
  outcome: z.object({
    disposition: z.enum([
      "none",
      "continuation_required",
      "failed",
      "succeeded",
      "cancelled",
      "unavailable",
    ]),
    publicCode: lowerToken.nullable(),
    counts: outcomeCountsSchema,
    freshObservationRequired: z.boolean(),
    continuationBarriers: z.array(lowerToken).max(32),
    deferredActions: z.array(lowerToken).max(64),
    nextAction: z.enum([
      "continue",
      "wait_external",
      "fresh_observation",
      "retry_same_executor",
      "handoff",
      "cancel",
      "block",
      "await_external_ci",
      "await_merge_decision",
      "none",
    ]),
  }).strict(),
  evidence: z.object({
    receiptDigest: digest,
    logRef: z.string().regex(logReferencePattern).nullable(),
    artifactRef: z.string().regex(artifactReferencePattern).nullable(),
  }).strict(),
  coverage: coverageSchema,
  authority: authoritySchema,
}).strict().superRefine((value, context) => {
  const expectedDisposition: Record<SmolRunnerReceiptState, typeof value.outcome.disposition> = {
    queued: "none",
    reserved: "none",
    starting: "none",
    running: "none",
    verifying: "none",
    waiting_external: "none",
    continuation_required: "continuation_required",
    failed: "failed",
    completed: "succeeded",
    cancelled: "cancelled",
    unavailable: "unavailable",
  };
  if (value.outcome.disposition !== expectedDisposition[value.state]) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "disposition"],
      message: "Receipt state and terminal disposition do not agree",
    });
  }

  if (startedStates.has(value.state) && value.startedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["startedAt"],
      message: "Post-start receipt states require a start timestamp",
    });
  }
  if ((value.state === "queued" || value.state === "reserved" || value.state === "unavailable")
    && value.startedAt !== null) {
    context.addIssue({
      code: "custom",
      path: ["startedAt"],
      message: "Pre-start receipt states cannot include a start timestamp",
    });
  }
  if (terminalStates.has(value.state) !== (value.terminalAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["terminalAt"],
      message: "Terminal receipt states require exactly one terminal timestamp",
    });
  }
  if (value.startedAt !== null && Date.parse(value.startedAt) > Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["startedAt"],
      message: "Start timestamp cannot be later than the receipt observation",
    });
  }
  if (value.terminalAt !== null && Date.parse(value.terminalAt) > Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["terminalAt"],
      message: "Terminal timestamp cannot be later than the receipt observation",
    });
  }
  if (heartbeatStates.has(value.state) && value.heartbeat === null) {
    context.addIssue({
      code: "custom",
      path: ["heartbeat"],
      message: "Active receipt states require a bounded heartbeat contract",
    });
  }
  if (!heartbeatStates.has(value.state) && value.heartbeat !== null) {
    context.addIssue({
      code: "custom",
      path: ["heartbeat"],
      message: "Non-active receipt states cannot claim an active heartbeat",
    });
  }
  if (value.heartbeat !== null && Date.parse(value.heartbeat.leaseExpiresAt) < Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["heartbeat", "leaseExpiresAt"],
      message: "Heartbeat lease cannot already be expired at observation time",
    });
  }
  if (value.state === "reserved" && value.reservation === null) {
    context.addIssue({
      code: "custom",
      path: ["reservation"],
      message: "Reserved state requires reservation evidence",
    });
  }
  if (value.state === "waiting_external" && value.outcome.nextAction !== "wait_external") {
    context.addIssue({
      code: "custom",
      path: ["outcome", "nextAction"],
      message: "External wait state requires a named external-wait next action",
    });
  }
  if (value.state === "continuation_required"
    && !value.outcome.freshObservationRequired
    && value.outcome.continuationBarriers.length === 0
    && value.outcome.deferredActions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Continuation-required state must identify a bounded continuation reason",
    });
  }
  if ((value.state === "failed" || value.state === "unavailable") && value.outcome.publicCode === null) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "publicCode"],
      message: "Failure and unavailable states require a stable public code",
    });
  }
  if (value.state === "completed" && value.outcome.counts.failed !== 0) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "counts", "failed"],
      message: "Successful completion cannot report failed actions",
    });
  }
});

export const smolRunnerReceiptIntakeSchema = z.object({
  schemaVersion: z.literal(SMOLRUNNER_RECEIPT_INTAKE_SCHEMA_VERSION),
  attempt: smolRunnerAttemptBindingSchema,
  receipt: smolRunnerPublicReceiptSchema,
}).strict().superRefine((value, context) => {
  const expectedCommit = value.attempt.candidateHead ?? value.attempt.resolvedBaseCommit;
  const equalityChecks: Array<[unknown, unknown, (string | number)[], string]> = [
    [value.receipt.executionEnvelopeVersion, value.attempt.executionEnvelopeVersion, ["receipt", "executionEnvelopeVersion"], "Execution-envelope version changed across the adapter boundary"],
    [value.receipt.repository, value.attempt.repository, ["receipt", "repository"], "Repository identity changed across the adapter boundary"],
    [value.receipt.runnerProfileId, value.attempt.runnerProfileId, ["receipt", "runnerProfileId"], "Runner profile changed across the adapter boundary"],
    [value.receipt.profileId, value.attempt.verificationProfileId, ["receipt", "profileId"], "Verification profile changed across the adapter boundary"],
    [value.receipt.workspaceReceiptRef, value.attempt.workspaceReceiptRef, ["receipt", "workspaceReceiptRef"], "Workspace receipt changed across the adapter boundary"],
    [value.receipt.source.commit, expectedCommit, ["receipt", "source", "commit"], "Receipt source commit does not match the exact attempt candidate"],
  ];
  for (const [actual, expected, path, message] of equalityChecks) {
    if (actual !== expected) context.addIssue({ code: "custom", path, message });
  }
});

export type SmolRunnerAttemptBinding = z.infer<typeof smolRunnerAttemptBindingSchema>;
export type SmolRunnerPublicReceipt = z.infer<typeof smolRunnerPublicReceiptSchema>;
export type SmolRunnerReceiptIntake = z.infer<typeof smolRunnerReceiptIntakeSchema>;

export interface SmolRunnerReceiptTransition {
  schemaVersion: 1;
  transitionKind: SmolRunnerTransitionKind;
  attempt: SmolRunnerAttemptBinding;
  executionId: string;
  checkpointGeneration: number;
  producerVersion: string;
  sourceCommit: string;
  sourceTree: string;
  state: SmolRunnerReceiptState;
  phaseId: string;
  observedAt: string;
  receiptDigest: string;
  queue: SmolRunnerPublicReceipt["queue"];
  reservation: SmolRunnerPublicReceipt["reservation"];
  heartbeat: SmolRunnerPublicReceipt["heartbeat"];
  progress: SmolRunnerPublicReceipt["progress"];
  disposition: SmolRunnerPublicReceipt["outcome"]["disposition"];
  publicCode: string | null;
  nextAction: SmolRunnerPublicReceipt["outcome"]["nextAction"];
  coverage: SmolRunnerPublicReceipt["coverage"];
  authority: SmolRunnerPublicReceipt["authority"];
  fingerprint: `sha256:${string}`;
}

export function parseSmolRunnerReceiptIntake(input: unknown): SmolRunnerReceiptTransition {
  const parsed = smolRunnerReceiptIntakeSchema.parse(input);
  const transition = {
    schemaVersion: SMOLRUNNER_RECEIPT_INTAKE_SCHEMA_VERSION,
    transitionKind: transitionKind(parsed.receipt.state),
    attempt: parsed.attempt,
    executionId: parsed.receipt.executionId,
    checkpointGeneration: parsed.receipt.checkpointGeneration,
    producerVersion: parsed.receipt.producer.version,
    sourceCommit: parsed.receipt.source.commit,
    sourceTree: parsed.receipt.source.tree,
    state: parsed.receipt.state,
    phaseId: parsed.receipt.phaseId,
    observedAt: parsed.receipt.observedAt,
    receiptDigest: parsed.receipt.evidence.receiptDigest,
    queue: parsed.receipt.queue,
    reservation: parsed.receipt.reservation,
    heartbeat: parsed.receipt.heartbeat,
    progress: parsed.receipt.progress,
    disposition: parsed.receipt.outcome.disposition,
    publicCode: parsed.receipt.outcome.publicCode,
    nextAction: parsed.receipt.outcome.nextAction,
    coverage: parsed.receipt.coverage,
    authority: parsed.receipt.authority,
  } as const;
  return {
    ...transition,
    fingerprint: digestCanonical(transition),
  };
}

export type SmolRunnerReceiptReplayDecision =
  | { status: "insert" }
  | { status: "duplicate" }
  | { status: "advance" }
  | { status: "stale"; reason: "checkpoint_generation" }
  | { status: "conflict"; reason: "attempt_identity" | "execution_identity" | "checkpoint_semantics" | "checkpoint_gap" | "candidate_head_regression" | "terminal_immutable" | "state_transition" | "observation_time" };

export function compareSmolRunnerReceiptTransitions(
  previous: SmolRunnerReceiptTransition | null,
  incoming: SmolRunnerReceiptTransition,
): SmolRunnerReceiptReplayDecision {
  if (previous === null) return { status: "insert" };
  if (stableJson(stableAttemptIdentity(previous.attempt)) !== stableJson(stableAttemptIdentity(incoming.attempt))) {
    return { status: "conflict", reason: "attempt_identity" };
  }
  if (previous.executionId !== incoming.executionId) {
    return { status: "conflict", reason: "execution_identity" };
  }
  if (incoming.checkpointGeneration < previous.checkpointGeneration) {
    return { status: "stale", reason: "checkpoint_generation" };
  }
  if (incoming.checkpointGeneration === previous.checkpointGeneration) {
    return incoming.fingerprint === previous.fingerprint
      ? { status: "duplicate" }
      : { status: "conflict", reason: "checkpoint_semantics" };
  }
  if (incoming.checkpointGeneration !== previous.checkpointGeneration + 1) {
    return { status: "conflict", reason: "checkpoint_gap" };
  }
  if (previous.attempt.candidateHead !== null && incoming.attempt.candidateHead === null) {
    return { status: "conflict", reason: "candidate_head_regression" };
  }
  if (terminalStates.has(previous.state)) {
    return { status: "conflict", reason: "terminal_immutable" };
  }
  if (Date.parse(incoming.observedAt) < Date.parse(previous.observedAt)) {
    return { status: "conflict", reason: "observation_time" };
  }
  if (!allowedNextStates(previous.state).has(incoming.state)) {
    return { status: "conflict", reason: "state_transition" };
  }
  return { status: "advance" };
}

export type SmolRunnerReceiptLiveness =
  | { state: "queued" | "reserved" | "waiting_external" | "continuation_required" | "terminal" }
  | { state: "active"; stalledAt: string }
  | { state: "stalled"; stalledAt: string };

export function projectSmolRunnerReceiptLiveness(
  transition: SmolRunnerReceiptTransition,
  now: string,
): SmolRunnerReceiptLiveness {
  const canonicalNow = canonicalTimestamp.parse(now);
  if (terminalStates.has(transition.state)) return { state: "terminal" };
  if (transition.state === "queued") return { state: "queued" };
  if (transition.state === "reserved") return { state: "reserved" };
  if (transition.state === "waiting_external") return { state: "waiting_external" };
  if (transition.state === "continuation_required") return { state: "continuation_required" };
  if (transition.heartbeat === null) {
    throw new RangeError("Active receipt liveness requires heartbeat data");
  }
  const missedHeartbeatAt = Date.parse(transition.observedAt) + transition.heartbeat.intervalSeconds * 3_000;
  const leaseExpiry = Date.parse(transition.heartbeat.leaseExpiresAt);
  const stalledAt = new Date(Math.min(missedHeartbeatAt, leaseExpiry)).toISOString();
  return Date.parse(canonicalNow) >= Date.parse(stalledAt)
    ? { state: "stalled", stalledAt }
    : { state: "active", stalledAt };
}

function stableAttemptIdentity(attempt: SmolRunnerAttemptBinding): Omit<SmolRunnerAttemptBinding, "candidateHead"> {
  const { candidateHead: _candidateHead, ...identity } = attempt;
  return identity;
}

function transitionKind(state: SmolRunnerReceiptState): SmolRunnerTransitionKind {
  switch (state) {
    case "queued": return "queue_recorded";
    case "reserved": return "reservation_recorded";
    case "starting": return "execution_started";
    case "running":
    case "verifying":
    case "waiting_external": return "progress_checkpoint";
    case "continuation_required": return "continuation_required";
    case "failed": return "execution_failed";
    case "completed": return "execution_completed";
    case "cancelled": return "cancellation_acknowledged";
    case "unavailable": return "executor_unavailable";
  }
}

function allowedNextStates(state: SmolRunnerReceiptState): ReadonlySet<SmolRunnerReceiptState> {
  const transitions: Record<SmolRunnerReceiptState, readonly SmolRunnerReceiptState[]> = {
    queued: ["queued", "reserved", "cancelled", "unavailable"],
    reserved: ["reserved", "starting", "cancelled", "unavailable"],
    starting: ["starting", "running", "verifying", "continuation_required", "failed", "cancelled"],
    running: ["running", "verifying", "waiting_external", "continuation_required", "failed", "completed", "cancelled"],
    verifying: ["verifying", "waiting_external", "continuation_required", "failed", "completed", "cancelled"],
    waiting_external: ["waiting_external", "running", "verifying", "continuation_required", "failed", "completed", "cancelled"],
    continuation_required: ["continuation_required", "starting", "running", "verifying", "failed", "cancelled"],
    failed: [],
    completed: [],
    cancelled: [],
    unavailable: [],
  };
  return new Set(transitions[state]);
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) throw new TypeError("Canonical JSON cannot encode undefined");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Canonical JSON value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
