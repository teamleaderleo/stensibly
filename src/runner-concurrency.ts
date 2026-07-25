import type { RunnerConcurrencyPolicy } from "./runner-contracts.js";

export const defaultRunnerConcurrencyPolicy = {
  globalLimit: 4,
  projectLimit: 2,
} satisfies RunnerConcurrencyPolicy;

export function normalizeRunnerConcurrencyPolicy(
  raw: Partial<RunnerConcurrencyPolicy> | undefined,
): RunnerConcurrencyPolicy {
  return {
    globalLimit: boundedLimit(
      raw?.globalLimit ?? defaultRunnerConcurrencyPolicy.globalLimit,
      "Global runner concurrency limit",
    ),
    projectLimit: boundedLimit(
      raw?.projectLimit ?? defaultRunnerConcurrencyPolicy.projectLimit,
      "Project runner concurrency limit",
    ),
  };
}

function boundedLimit(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 1_000) {
    throw new TypeError(`${label} must be a whole number from 1 to 1000`);
  }
  return normalized;
}
