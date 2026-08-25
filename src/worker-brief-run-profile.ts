import { sha256, stableJson } from "./canonical-json.js";
import {
  compareRunnerProfileProvenanceV1,
  runnerProfileProvenanceV1,
  runnerProfileVersionOrUnknownV1,
  type RunnerProfileProvenanceV1,
} from "./runner-profile-provenance.js";
import type { VersionedWorkRun } from "./runs.js";
import {
  assertWorkerBriefCurrentV1,
  compileWorkerBriefV1,
  workerBriefJson,
  type CompileWorkerBriefInputV1,
  type WorkerBriefCapabilityClass,
  type WorkerBriefFreshnessFactsV1,
  type WorkerBriefV1,
} from "./worker-brief.js";

export const RUN_BOUND_WORKER_BRIEF_COMPILER_VERSION = "0.3.0" as const;

export type WorkerBriefRunBindingV1 = Pick<
  VersionedWorkRun,
  "id" | "generation" | "leaseGeneration" | "runnerProfile" | "runnerProfileVersion"
>;

export type CompileRunBoundWorkerBriefInputV1 = Omit<
  CompileWorkerBriefInputV1,
  "dispatch"
>;

export type RunBoundWorkerBriefFreshnessFactsV1 = Omit<
  WorkerBriefFreshnessFactsV1,
  "runId" | "runGeneration" | "leaseGeneration"
>;

export type RunBoundWorkerBriefV1 = Omit<
  WorkerBriefV1,
  "compilerVersion" | "identity"
> & {
  compilerVersion: typeof RUN_BOUND_WORKER_BRIEF_COMPILER_VERSION;
  identity: Omit<WorkerBriefV1["identity"], "dispatch"> & {
    dispatch: WorkerBriefV1["identity"]["dispatch"] & {
      runnerProfileVersion: string | null;
    };
  };
};

export type CompatibleRunProfileWorkerBriefV1 = WorkerBriefV1 | RunBoundWorkerBriefV1;

interface AdmittedRunBindingV1 {
  id: unknown;
  generation: unknown;
  leaseGeneration: unknown;
  runnerProfile: unknown;
  runnerProfileVersion: unknown;
}

/**
 * Compile worker guidance from one authoritative durable run.
 *
 * The run supplies profile ID/version plus run/lease generations. Historical
 * unknown profile versions remain explicit null and are never inferred as a
 * current version. This compiler grants zero authority; it only makes the
 * already-authoritative run provenance part of brief identity and replay.
 */
export function compileRunBoundWorkerBriefV1(
  input: CompileRunBoundWorkerBriefInputV1,
  run: WorkerBriefRunBindingV1,
  capabilityClass: WorkerBriefCapabilityClass,
): RunBoundWorkerBriefV1 {
  const binding = admitRunBinding(run);
  const profile = runnerProfileProvenanceV1(
    binding.runnerProfile,
    binding.runnerProfileVersion,
  );
  const base = compileWorkerBriefV1(withDispatch(input, {
    runId: binding.id as string,
    runGeneration: binding.generation as number,
    leaseGeneration: binding.leaseGeneration as number,
    runnerProfile: profile.profileId,
    capabilityClass,
  }));
  const { semanticDigest: _semanticDigest, ...baseWithoutDigest } = base;
  const withoutDigest = deepFreeze({
    ...baseWithoutDigest,
    compilerVersion: RUN_BOUND_WORKER_BRIEF_COMPILER_VERSION,
    identity: {
      ...base.identity,
      dispatch: {
        ...base.identity.dispatch,
        runnerProfileVersion: profile.profileVersion,
      },
    },
  });
  return deepFreeze({
    ...withoutDigest,
    semanticDigest: sha256(stableJson(withoutDigest)),
  }) as RunBoundWorkerBriefV1;
}

/**
 * Recover profile provenance from either a current profile-bound brief or an
 * older worker-brief/v1. A missing historical field is explicit unknown/null.
 */
export function workerBriefRunnerProfileProvenanceV1(
  brief: CompatibleRunProfileWorkerBriefV1,
): RunnerProfileProvenanceV1 {
  const parsed = JSON.parse(
    workerBriefJson(brief as unknown as WorkerBriefV1),
  ) as {
    identity: {
      dispatch: {
        runnerProfile: unknown;
        runnerProfileVersion?: unknown;
      };
    };
  };
  const dispatch = parsed.identity.dispatch;
  return runnerProfileProvenanceV1(
    dispatch.runnerProfile,
    Object.prototype.hasOwnProperty.call(dispatch, "runnerProfileVersion")
      ? runnerProfileVersionOrUnknownV1(dispatch.runnerProfileVersion)
      : null,
  );
}

/**
 * Revalidate mutable brief inputs while deriving run identity/profile facts
 * from the current durable run record. Version drift makes the brief stale
 * before any downstream runtime/effect admission.
 */
export function assertRunBoundWorkerBriefCurrentV1(
  brief: CompatibleRunProfileWorkerBriefV1,
  current: RunBoundWorkerBriefFreshnessFactsV1,
  run: WorkerBriefRunBindingV1,
): void {
  const binding = admitRunBinding(run);
  assertWorkerBriefCurrentV1(
    brief as unknown as WorkerBriefV1,
    {
      ...current,
      runId: binding.id as string,
      runGeneration: binding.generation as number,
      leaseGeneration: binding.leaseGeneration as number,
    },
  );

  const briefProfile = workerBriefRunnerProfileProvenanceV1(brief);
  const currentProfile = runnerProfileProvenanceV1(
    binding.runnerProfile,
    binding.runnerProfileVersion,
  );
  const compatibility = compareRunnerProfileProvenanceV1(
    briefProfile,
    currentProfile,
  );
  if (compatibility !== "exact" && compatibility !== "legacy_unknown_match") {
    throw new RangeError(
      `Worker brief runner profile provenance is stale: ${compatibility}`,
    );
  }
}

export function runBoundWorkerBriefIsCurrentV1(
  brief: CompatibleRunProfileWorkerBriefV1,
  current: RunBoundWorkerBriefFreshnessFactsV1,
  run: WorkerBriefRunBindingV1,
): boolean {
  try {
    assertRunBoundWorkerBriefCurrentV1(brief, current, run);
    return true;
  } catch {
    return false;
  }
}

export function runBoundWorkerBriefJsonV1(
  brief: CompatibleRunProfileWorkerBriefV1,
): string {
  return workerBriefJson(brief as unknown as WorkerBriefV1);
}

function withDispatch(
  input: CompileRunBoundWorkerBriefInputV1,
  dispatch: CompileWorkerBriefInputV1["dispatch"],
): CompileWorkerBriefInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Run-bound worker brief compile input must be an object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.prototype.hasOwnProperty.call(descriptors, "dispatch")) {
    throw new TypeError("Run-bound worker brief compile input cannot supply dispatch");
  }
  Object.defineProperty(descriptors, "dispatch", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: dispatch,
  });
  return Object.create(Object.getPrototypeOf(input), descriptors) as CompileWorkerBriefInputV1;
}

function admitRunBinding(run: WorkerBriefRunBindingV1): AdmittedRunBindingV1 {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new TypeError("Worker brief run binding must be an object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(run);
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of [
    "id",
    "generation",
    "leaseGeneration",
    "runnerProfile",
    "runnerProfileVersion",
  ] as const) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (key === "runnerProfileVersion") {
        throw new RangeError(
          "Run-bound worker brief requires an explicit runner profile version or null",
        );
      }
      throw new TypeError(`Worker brief run binding is missing field ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Worker brief run binding field ${key} must be an enumerable data property`,
      );
    }
    if (key === "runnerProfileVersion" && descriptor.value === undefined) {
      throw new RangeError(
        "Run-bound worker brief requires an explicit runner profile version or null",
      );
    }
    output[key] = descriptor.value;
  }
  return output as unknown as AdmittedRunBindingV1;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
