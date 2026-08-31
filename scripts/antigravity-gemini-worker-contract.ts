/** Shared contracts for the first-party Antigravity-backed Gemini worker. */

export const ANTIGRAVITY_PROVIDER = "google-antigravity" as const;
export const ANTIGRAVITY_AUTH_CLASS = "google-account-subscription" as const;
export const ANTIGRAVITY_HARNESS = "agy" as const;
export const ANTIGRAVITY_MODEL = "gemini-3.7-flash-high" as const;
export const ANTIGRAVITY_REASONING_EFFORT = "high" as const;
export const ANTIGRAVITY_RECEIPT_SCHEMA_VERSION =
  "antigravity-gemini-worker-receipt/1" as const;
export const ANTIGRAVITY_RESULT_SCHEMA_VERSION =
  "antigravity-gemini-worker-result/1" as const;

export const ANTIGRAVITY_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["complete", "partial", "blocked"] },
    summary: { type: "string", maxLength: 4_000 },
    changed_paths: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 400 },
    },
    verification_attempts: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 500 },
    },
    remaining_limits: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 500 },
    },
  },
  required: [
    "status",
    "summary",
    "changed_paths",
    "verification_attempts",
    "remaining_limits",
  ],
} as const;

export type AntigravityResultStatus = "complete" | "partial" | "blocked";

export interface AntigravityWorkerResult {
  readonly status: AntigravityResultStatus;
  readonly summary: string;
  readonly changedPaths: readonly string[];
  readonly verificationAttempts: readonly string[];
  readonly remainingLimits: readonly string[];
}

export interface AntigravityUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalRecordedTokens: number | null;
}

export type AntigravityQuotaWindowClass =
  | "five_hour"
  | "weekly"
  | "unknown";

export interface AntigravityQuotaObservation {
  readonly model: string | null;
  readonly windowClass: AntigravityQuotaWindowClass;
  readonly windowMinutes: number | null;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
}

export interface AntigravityQuotaSnapshot {
  readonly observedAt: string;
  readonly commandSucceeded: boolean;
  readonly parseState: "recorded" | "not_exposed" | "unrecognized" | "unavailable";
  readonly generation: string | null;
  readonly sourceSha256: string | null;
  readonly observations: readonly AntigravityQuotaObservation[];
}

export type AntigravityAcceptedOutcome =
  | "unknown"
  | "accepted"
  | "rejected"
  | "partial";

export type AntigravityVerificationOutcome =
  | "unknown"
  | "passed"
  | "failed"
  | "not_run";

export interface AntigravityEconomics {
  readonly acceptedOutcome: AntigravityAcceptedOutcome;
  readonly verificationOutcome: AntigravityVerificationOutcome;
  readonly fiveHourQuotaDeltaPercent: number | null;
  readonly weeklyQuotaDeltaPercent: number | null;
  readonly acceptedTasksPerFiveHourQuotaPercent: number | null;
  readonly acceptedTasksPerWeeklyQuotaPercent: number | null;
  readonly acceptedTasksPerSubscriptionDollar: number | null;
  readonly acceptedTasksPerWallClockHourPerQuotaPercent: number | null;
  readonly tokensPerAcceptedTask: number | null;
  readonly operatorMinutesPerAcceptedTask: number | null;
  readonly operatorInterventionMinutes: number | null;
  readonly retries: number;
  readonly cleanupOrRework: "unknown" | "none" | "required";
}
