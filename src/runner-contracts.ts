import type { ActorInput } from "./schemas.js";
import type {
  HeartbeatWorkRunInput,
  ListWorkRunsInput,
  TransitionWorkRunInput,
  WorkRun,
} from "./runs.js";

export interface ClaimRunnerWorkInput {
  actor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  project?: string;
  runId?: string;
  externalRunId?: string;
  leaseSeconds?: number;
  idempotencyKey?: string;
}

export interface RunnerLedger {
  claimRunnerWork(input: ClaimRunnerWorkInput): Promise<WorkRun | null>;
  getRun(id: string): Promise<WorkRun>;
  listRuns(input?: ListWorkRunsInput): Promise<WorkRun[]>;
  heartbeatRun(input: HeartbeatWorkRunInput): Promise<WorkRun>;
  transitionRun(input: TransitionWorkRunInput): Promise<WorkRun>;
}

export function runnerLedger(value: unknown): RunnerLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RunnerLedger>;
  return typeof candidate.claimRunnerWork === "function"
    && typeof candidate.getRun === "function"
    && typeof candidate.listRuns === "function"
    && typeof candidate.heartbeatRun === "function"
    && typeof candidate.transitionRun === "function"
    ? candidate as RunnerLedger
    : null;
}
