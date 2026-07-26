export const EXECUTION_ENVELOPE_SCHEMA_VERSION = 1 as const;

export const executionScopeClasses = [
  "atomic",
  "segmented",
  "exploratory",
  "long-running",
  "portfolio",
  "review",
] as const;

export const durableAccessClasses = [
  "private",
  "project",
  "workspace",
] as const;

export const durableRetentionClasses = [
  "ephemeral",
  "standard",
  "extended",
  "indefinite",
] as const;

export type ExecutionScopeClass = (typeof executionScopeClasses)[number];
export type DurableAccessClass = (typeof durableAccessClasses)[number];
export type DurableRetentionClass = (typeof durableRetentionClasses)[number];

export interface ExecutionEnvelope {
  schemaVersion: typeof EXECUTION_ENVELOPE_SCHEMA_VERSION;
  objective: string;
  scopeClass: ExecutionScopeClass;
  estimate: {
    lowMinutes: number;
    likelyMinutes: number;
    highMinutes: number;
    confidence: number;
  };
  budget: {
    expectedMessages: number;
    expectedToolCalls: number;
    expectedReviewMinutes: number;
  };
  boundaries: {
    softCheckpointMinutes: number;
    forcedHandoffMinutes: number;
    hardRecoveryMinutes: number;
  };
  completion: {
    requiredOutputs: string[];
    verificationRequired: boolean;
    continuationStateRequired: boolean;
    acceptanceChecks: string[];
  };
  durableState: {
    accessClass: DurableAccessClass;
    retentionClass: DurableRetentionClass;
    redactionRequired: boolean;
    deleteAfter: string | null;
  };
}

export interface ExecutionActual {
  durationMinutes?: number;
  messagesConsumed?: number;
  toolCalls?: number;
  filesChanged?: number;
  reviewMinutes?: number;
  estimateErrorReasons?: string[];
}

const MAX_DURATION_MINUTES = 525_600;
const MAX_MESSAGES = 100_000;
const MAX_TOOL_CALLS = 1_000_000;
const MAX_LIST_ENTRIES = 100;
const MAX_TEXT_LENGTH = 2_000;
const CREDENTIAL_PATTERN = /(?:stn\.tok_|sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9._-]+/i;

export function parseExecutionEnvelope(value: unknown): ExecutionEnvelope {
  const input = strictRecord(value, "Execution envelope", [
    "schemaVersion",
    "objective",
    "scopeClass",
    "estimate",
    "budget",
    "boundaries",
    "completion",
    "durableState",
  ]);
  if (input.schemaVersion !== EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(
      `Execution envelope schema version must be ${EXECUTION_ENVELOPE_SCHEMA_VERSION}`,
    );
  }

  const estimate = strictRecord(input.estimate, "Execution estimate", [
    "lowMinutes",
    "likelyMinutes",
    "highMinutes",
    "confidence",
  ]);
  const lowMinutes = boundedInteger(
    estimate.lowMinutes,
    "Low duration estimate",
    0,
    MAX_DURATION_MINUTES,
  );
  const likelyMinutes = boundedInteger(
    estimate.likelyMinutes,
    "Likely duration estimate",
    0,
    MAX_DURATION_MINUTES,
  );
  const highMinutes = boundedInteger(
    estimate.highMinutes,
    "High duration estimate",
    0,
    MAX_DURATION_MINUTES,
  );
  if (lowMinutes > likelyMinutes || likelyMinutes > highMinutes) {
    throw new TypeError(
      "Execution duration estimates must satisfy lowMinutes <= likelyMinutes <= highMinutes",
    );
  }
  const confidence = finiteNumber(estimate.confidence, "Estimate confidence", 0, 1);

  const budget = strictRecord(input.budget, "Execution budget", [
    "expectedMessages",
    "expectedToolCalls",
    "expectedReviewMinutes",
  ]);
  const boundaries = strictRecord(input.boundaries, "Execution boundaries", [
    "softCheckpointMinutes",
    "forcedHandoffMinutes",
    "hardRecoveryMinutes",
  ]);
  const softCheckpointMinutes = boundedInteger(
    boundaries.softCheckpointMinutes,
    "Soft checkpoint boundary",
    0,
    MAX_DURATION_MINUTES,
  );
  const forcedHandoffMinutes = boundedInteger(
    boundaries.forcedHandoffMinutes,
    "Forced handoff boundary",
    0,
    MAX_DURATION_MINUTES,
  );
  const hardRecoveryMinutes = boundedInteger(
    boundaries.hardRecoveryMinutes,
    "Hard recovery boundary",
    0,
    MAX_DURATION_MINUTES,
  );
  if (
    softCheckpointMinutes > forcedHandoffMinutes
    || forcedHandoffMinutes > hardRecoveryMinutes
  ) {
    throw new TypeError(
      "Execution boundaries must satisfy softCheckpointMinutes <= forcedHandoffMinutes <= hardRecoveryMinutes",
    );
  }

  const completion = strictRecord(input.completion, "Execution completion policy", [
    "requiredOutputs",
    "verificationRequired",
    "continuationStateRequired",
    "acceptanceChecks",
  ]);
  const durableState = strictRecord(input.durableState, "Execution durable-state policy", [
    "accessClass",
    "retentionClass",
    "redactionRequired",
    "deleteAfter",
  ]);

  return {
    schemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
    objective: boundedText(input.objective, "Execution objective", MAX_TEXT_LENGTH),
    scopeClass: enumValue(input.scopeClass, executionScopeClasses, "Execution scope class"),
    estimate: {
      lowMinutes,
      likelyMinutes,
      highMinutes,
      confidence,
    },
    budget: {
      expectedMessages: boundedInteger(
        budget.expectedMessages,
        "Expected messages",
        0,
        MAX_MESSAGES,
      ),
      expectedToolCalls: boundedInteger(
        budget.expectedToolCalls,
        "Expected tool calls",
        0,
        MAX_TOOL_CALLS,
      ),
      expectedReviewMinutes: boundedInteger(
        budget.expectedReviewMinutes,
        "Expected review minutes",
        0,
        MAX_DURATION_MINUTES,
      ),
    },
    boundaries: {
      softCheckpointMinutes,
      forcedHandoffMinutes,
      hardRecoveryMinutes,
    },
    completion: {
      requiredOutputs: boundedTextList(
        completion.requiredOutputs,
        "Required outputs",
      ),
      verificationRequired: booleanValue(
        completion.verificationRequired,
        "Verification required",
      ),
      continuationStateRequired: booleanValue(
        completion.continuationStateRequired,
        "Continuation state required",
      ),
      acceptanceChecks: boundedTextList(
        completion.acceptanceChecks,
        "Acceptance checks",
      ),
    },
    durableState: {
      accessClass: enumValue(
        durableState.accessClass,
        durableAccessClasses,
        "Durable-state access class",
      ),
      retentionClass: enumValue(
        durableState.retentionClass,
        durableRetentionClasses,
        "Durable-state retention class",
      ),
      redactionRequired: booleanValue(
        durableState.redactionRequired,
        "Durable-state redaction required",
      ),
      deleteAfter: nullableIsoTimestamp(durableState.deleteAfter, "Durable-state deletion time"),
    },
  };
}

export function parseNullableExecutionEnvelope(value: unknown): ExecutionEnvelope | null {
  return value === null || value === undefined ? null : parseExecutionEnvelope(value);
}

export function parseExecutionActual(value: unknown): ExecutionActual {
  if (value === null || value === undefined) return {};
  const input = strictRecord(value, "Execution actual", [
    "durationMinutes",
    "messagesConsumed",
    "toolCalls",
    "filesChanged",
    "reviewMinutes",
    "estimateErrorReasons",
  ]);
  const output: ExecutionActual = {};
  if (input.durationMinutes !== undefined) {
    output.durationMinutes = finiteNumber(
      input.durationMinutes,
      "Actual duration minutes",
      0,
      MAX_DURATION_MINUTES,
    );
  }
  if (input.messagesConsumed !== undefined) {
    output.messagesConsumed = boundedInteger(
      input.messagesConsumed,
      "Messages consumed",
      0,
      MAX_MESSAGES,
    );
  }
  if (input.toolCalls !== undefined) {
    output.toolCalls = boundedInteger(
      input.toolCalls,
      "Actual tool calls",
      0,
      MAX_TOOL_CALLS,
    );
  }
  if (input.filesChanged !== undefined) {
    output.filesChanged = boundedInteger(
      input.filesChanged,
      "Files changed",
      0,
      MAX_TOOL_CALLS,
    );
  }
  if (input.reviewMinutes !== undefined) {
    output.reviewMinutes = finiteNumber(
      input.reviewMinutes,
      "Actual review minutes",
      0,
      MAX_DURATION_MINUTES,
    );
  }
  if (input.estimateErrorReasons !== undefined) {
    output.estimateErrorReasons = boundedTextList(
      input.estimateErrorReasons,
      "Estimate error reasons",
    );
  }
  return output;
}

export function executionEnvelopeJson(value: ExecutionEnvelope): string {
  return JSON.stringify(parseExecutionEnvelope(value));
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const output = value as Record<string, unknown>;
  const unexpected = Object.keys(output).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported field ${unexpected[0]}`);
  }
  return output;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const output = value.trim();
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maximum) {
    throw new TypeError(`${label} may contain at most ${maximum} characters`);
  }
  if (CREDENTIAL_PATTERN.test(output)) {
    throw new TypeError(`${label} must not contain credential-shaped text`);
  }
  return output;
}

function boundedTextList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > MAX_LIST_ENTRIES) {
    throw new TypeError(`${label} may contain at most ${MAX_LIST_ENTRIES} entries`);
  }
  return value.map((entry, index) => boundedText(entry, `${label} entry ${index + 1}`, 500));
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function nullableIsoTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be an ISO timestamp or null`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Values[number];
}
