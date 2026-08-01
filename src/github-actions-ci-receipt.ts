import {
  compileGitHubActionsCiReceiptV1 as compileCoreReceipt,
} from "./github-actions-ci-receipt-core.js";
import type {
  CiJobConclusion,
  CiQueueReceiptV1,
  CiRunConclusion,
  CiTrustedClock,
} from "./ci-queue-receipt.js";

export * from "./github-actions-ci-receipt-core.js";

const runJobCompatibility = Object.freeze({
  success: Object.freeze(["success", "neutral", "skipped"] as const),
  failure: Object.freeze([
    "success", "failure", "cancelled", "neutral", "skipped",
  ] as const),
  cancelled: Object.freeze(["success", "cancelled", "neutral", "skipped"] as const),
  neutral: Object.freeze(["success", "neutral", "skipped"] as const),
  skipped: Object.freeze(["skipped"] as const),
  timed_out: Object.freeze([
    "success", "cancelled", "neutral", "skipped", "timed_out",
  ] as const),
  action_required: Object.freeze(["action_required", "skipped"] as const),
  stale: Object.freeze(["stale", "skipped"] as const),
  startup_failure: Object.freeze(["startup_failure", "skipped"] as const),
} satisfies Record<CiRunConclusion, readonly CiJobConclusion[]>);

export function compileGitHubActionsCiReceiptV1(
  value: unknown,
  trustedClock: CiTrustedClock,
): CiQueueReceiptV1 {
  const receipt = compileCoreReceipt(value, trustedClock);
  if (receipt.conclusion === null) {
    throw new RangeError("GitHub Actions completed run requires a conclusion");
  }
  const compatible: readonly CiJobConclusion[] =
    runJobCompatibility[receipt.conclusion];
  for (const job of receipt.jobs) {
    if (job.conclusion === null || !compatible.includes(job.conclusion)) {
      throw new RangeError(
        `GitHub Actions ${job.name} conclusion is incompatible with the run conclusion`,
      );
    }
  }
  return receipt;
}
