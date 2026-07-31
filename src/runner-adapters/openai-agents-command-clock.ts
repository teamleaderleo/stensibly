import { openAIAgentsObservationTimeV1 } from "./openai-agents-runtime-safety.js";

const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OpenAIAgentsCommandClockV1 {
  readonly version: 1;
  readonly baseObservedAt: string;
  timestamp(ordinal: number): string;
}

/**
 * Admit the injected adapter clock exactly once, before command activity begins.
 * Later observation timestamps are pure ordinal derivations from the frozen base.
 */
export function createOpenAIAgentsCommandClockV1(
  now: () => Date,
  issuedAtValue: string,
): OpenAIAgentsCommandClockV1 {
  const baseObservedAt = openAIAgentsObservationTimeV1(
    now,
    issuedAtValue,
    0,
  );
  const baseMilliseconds = Date.parse(baseObservedAt);
  if (!Number.isSafeInteger(baseMilliseconds)) throw invalidClock();

  return Object.freeze({
    version: 1 as const,
    baseObservedAt,
    timestamp(ordinal: number): string {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw invalidClock();
      }
      const milliseconds = baseMilliseconds + ordinal;
      if (!Number.isSafeInteger(milliseconds)) throw invalidClock();
      try {
        const observedAt = new Date(milliseconds).toISOString();
        if (!exactTimestampPattern.test(observedAt)) throw invalidClock();
        return observedAt;
      } catch {
        throw invalidClock();
      }
    },
  });
}

function invalidClock(): RangeError {
  return new RangeError("OpenAI Agents adapter clock is invalid");
}
