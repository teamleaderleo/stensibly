export const runStatuses = [
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export type WorkRunStatus = typeof runStatuses[number];
