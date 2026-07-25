import type { WorkRun, WorkRunCommand } from "./runs.js";
import { ConflictError } from "./store.js";

/**
 * Commands a runner may request while acting under an existing run authority
 * grant. Authority acquisition, reassignment, retry admission, and
 * cancellation remain server/supervisor-owned operations.
 */
export const runnerAuthorityCommands = [
  "start",
  "run",
  "wait",
  "block",
  "resume",
  "succeed",
  "fail",
] as const satisfies readonly WorkRunCommand[];

export type RunnerAuthorityCommand = typeof runnerAuthorityCommands[number];

export interface RunAuthorityFence {
  resource: `run:${string}`;
  holderId: string;
  generation: number;
  expiresAt: string;
}

/** Returns the current run authority grant, or null when no runner owns one. */
export function runAuthorityFence(
  run: Pick<WorkRun, "id" | "leaseOwnerId" | "leaseGeneration" | "leaseExpiresAt">,
): RunAuthorityFence | null {
  if (!run.leaseOwnerId || !run.leaseExpiresAt) return null;
  return {
    resource: `run:${run.id}`,
    holderId: run.leaseOwnerId,
    generation: run.leaseGeneration,
    expiresAt: run.leaseExpiresAt,
  };
}

/**
 * Prevent the runner surface from acquiring authority through a transition.
 *
 * The durable run transition still owns generation, holder, and expiry checks.
 * This guard narrows the external runner protocol so a blocked run must return
 * to server-owned scheduling before it can resume or finish. Exact idempotent
 * replays remain possible because only the still-blocked state is rejected.
 */
export function requireRunnerTransitionAuthority(
  run: Pick<WorkRun, "status">,
  command: RunnerAuthorityCommand,
): void {
  if (
    run.status === "blocked"
    && (command === "resume" || command === "succeed" || command === "fail")
  ) {
    throw new ConflictError(
      "Blocked run has no current runner authority; server-owned scheduling must reassign it",
    );
  }
}
