import type {
  RunnerResumeCommandV1,
  RunnerStartCommandV1,
} from "./runner-adapter-v1.js";

export type RunnerExecutableCommandV1 =
  | RunnerStartCommandV1
  | RunnerResumeCommandV1;

export function assertRunnerCommandAuthorityActiveV1(
  command: RunnerStartCommandV1,
  now?: Date,
): RunnerStartCommandV1;
export function assertRunnerCommandAuthorityActiveV1(
  command: RunnerResumeCommandV1,
  now?: Date,
): RunnerResumeCommandV1;
export function assertRunnerCommandAuthorityActiveV1(
  command: RunnerExecutableCommandV1,
  now = new Date(),
): RunnerExecutableCommandV1 {
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime)) {
    throw new RangeError("Runner command authority check requires a valid current time");
  }

  const issuedAt = Date.parse(command.issuedAt);
  if (currentTime < issuedAt) {
    throw new RangeError("Runner command cannot execute before its issue time");
  }

  const expiresAt = Date.parse(command.authority.expiresAt);
  if (currentTime >= expiresAt) {
    throw new RangeError("Runner command authority expired before execution");
  }

  return command;
}
