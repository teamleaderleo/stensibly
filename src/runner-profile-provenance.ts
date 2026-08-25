export const RUNNER_PROFILE_PROVENANCE_V1 = 1 as const;

export interface RunnerProfileProvenanceV1 {
  version: typeof RUNNER_PROFILE_PROVENANCE_V1;
  profileId: string;
  profileVersion: string | null;
}

export type RunnerProfileCompatibilityV1 =
  | "exact"
  | "legacy_unknown_match"
  | "version_unknown"
  | "different_profile"
  | "different_version";

export type RunnerProfileRolloverDecisionV1 =
  | "reuse_current_run"
  | "fresh_run_required"
  | "exact_version_required";

const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/u;
const CREDENTIAL_SHAPED_TEXT = /stn\.tok_/iu;

export function runnerProfileProvenanceV1(
  profileId: unknown,
  profileVersion?: unknown,
): RunnerProfileProvenanceV1 {
  return Object.freeze({
    version: RUNNER_PROFILE_PROVENANCE_V1,
    profileId: safeText(profileId, "Runner profile ID", 160),
    profileVersion: nullableVersion(profileVersion),
  });
}

export function admitRunnerProfileProvenanceV1(
  value: unknown,
): RunnerProfileProvenanceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runner profile provenance must be an object");
  }
  rejectAccessors(value, "Runner profile provenance");
  const record = value as Record<string, unknown>;
  if (record.profileVersion === undefined) {
    throw new RangeError("Runner profile provenance must state an exact version or null");
  }
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = ["profileId", "profileVersion", "version"].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new RangeError("Runner profile provenance has unexpected fields");
  }
  if (record.version !== RUNNER_PROFILE_PROVENANCE_V1) {
    throw new RangeError(
      `Runner profile provenance version must be ${RUNNER_PROFILE_PROVENANCE_V1}`,
    );
  }
  return runnerProfileProvenanceV1(record.profileId, record.profileVersion);
}

export function compareRunnerProfileProvenanceV1(
  durable: RunnerProfileProvenanceV1,
  requested: RunnerProfileProvenanceV1,
): RunnerProfileCompatibilityV1 {
  const left = admitRunnerProfileProvenanceV1(durable);
  const right = admitRunnerProfileProvenanceV1(requested);
  if (left.profileId !== right.profileId) return "different_profile";
  if (left.profileVersion === null && right.profileVersion === null) {
    return "legacy_unknown_match";
  }
  if (left.profileVersion === null || right.profileVersion === null) {
    return "version_unknown";
  }
  return left.profileVersion === right.profileVersion
    ? "exact"
    : "different_version";
}

export function runnerProfileClaimMatchesV1(
  durable: RunnerProfileProvenanceV1,
  requested: RunnerProfileProvenanceV1,
): boolean {
  const compatibility = compareRunnerProfileProvenanceV1(durable, requested);
  return compatibility === "exact" || compatibility === "legacy_unknown_match";
}

export function runnerProfileRolloverDecisionV1(
  durable: RunnerProfileProvenanceV1,
  requested: RunnerProfileProvenanceV1,
): RunnerProfileRolloverDecisionV1 {
  const compatibility = compareRunnerProfileProvenanceV1(durable, requested);
  if (compatibility === "exact") return "reuse_current_run";
  if (compatibility === "legacy_unknown_match" || compatibility === "version_unknown") {
    return "exact_version_required";
  }
  return "fresh_run_required";
}

export function requireExactRunnerProfileResumeV1(
  durable: RunnerProfileProvenanceV1,
  requested: RunnerProfileProvenanceV1,
): void {
  const compatibility = compareRunnerProfileProvenanceV1(durable, requested);
  if (compatibility === "exact") return;
  if (compatibility === "legacy_unknown_match" || compatibility === "version_unknown") {
    throw new RangeError("Runner resume requires an exact durable profile version");
  }
  throw new RangeError("Runner profile changed; start a fresh run instead of resuming");
}

function nullableVersion(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return safeText(value, "Runner profile version", 160);
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || UNSAFE_TEXT.test(normalized)
    || CREDENTIAL_SHAPED_TEXT.test(normalized)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function rejectAccessors(value: object, label: string): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RangeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new RangeError(`${label} has unexpected fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new RangeError(`${label} cannot contain accessors`);
    }
  }
}
