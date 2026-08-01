import {
  compileGitHubActionsCiReceiptV1 as compileCoreReceipt,
} from "./github-actions-ci-receipt-core.js";
import type {
  CiJobConclusion,
  CiQueueReceiptV1,
  CiRunConclusion,
  CiTrustedClock,
} from "./ci-queue-receipt.js";

export {
  GITHUB_ACTIONS_CI_JOB_NAMES,
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
  GITHUB_ACTIONS_CI_WORKFLOW_NAME,
  GITHUB_ACTIONS_CI_WORKFLOW_PATH,
} from "./github-actions-ci-receipt-core.js";
export type {
  GitHubActionsCiReceiptBundleV1,
  GitHubActionsCiValidationProfile,
  GitHubActionsCompletedJobV1,
  GitHubActionsCompletedRunV1,
  GitHubActionsCompletedStepV1,
  GitHubActionsDiagnosticsArtifactV1,
  GitHubActionsRunPullRequestV1,
} from "./github-actions-ci-receipt-core.js";

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

const maximumSnapshotDepth = 24;
const maximumSnapshotNodes = 10_000;
const maximumSnapshotArrayLength = 1_024;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

export function compileGitHubActionsCiReceiptV1(
  value: unknown,
  trustedClock: CiTrustedClock,
): CiQueueReceiptV1 {
  const receipt = compileCoreReceipt(snapshotInput(value), trustedClock);
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
  return deepFreeze(structuredClone(receipt));
}

function snapshotInput(input: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0;

  const copyDescriptor = (
    descriptor: PropertyDescriptor,
    depth: number,
  ): PropertyDescriptor => {
    if (!("value" in descriptor)) return descriptor;
    return {
      ...descriptor,
      value: copy(descriptor.value, depth + 1),
    };
  };

  const copy = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (depth > maximumSnapshotDepth || nodes > maximumSnapshotNodes) {
      throw new RangeError("GitHub Actions CI receipt bundle exceeds snapshot limits");
    }
    if (value === null || typeof value !== "object") return value;
    if (active.has(value)) {
      throw new RangeError("GitHub Actions CI receipt bundle must not contain cycles");
    }
    active.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
      const keys = Reflect.ownKeys(descriptors);

      if (Array.isArray(value)) {
        const lengthDescriptor = descriptors["length"];
        if (
          !lengthDescriptor
          || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || (lengthDescriptor.value as number) < 0
          || (lengthDescriptor.value as number) > maximumSnapshotArrayLength
        ) {
          throw new RangeError("GitHub Actions CI receipt bundle contains an invalid array length");
        }
        const output: unknown[] = [];
        Object.setPrototypeOf(output, prototype);
        for (const key of keys) {
          if (key === "length") continue;
          Object.defineProperty(output, key, copyDescriptor(descriptors[key]!, depth));
        }
        Object.defineProperty(output, "length", lengthDescriptor);
        Object.freeze(output);
        return output;
      }

      const output = Object.create(prototype) as Record<PropertyKey, unknown>;
      for (const key of keys) {
        Object.defineProperty(output, key, copyDescriptor(descriptors[key]!, depth));
      }
      Object.freeze(output);
      return output;
    } finally {
      active.delete(value);
    }
  };

  return copy(input, 0);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return value;
}
