import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const CODEX_ROOT_CLOUD_PLACEMENT_V1 = 1 as const;

export type CodexCloudPlacementPhaseV1 = "pre_dispatch" | "pre_result_application";
export type CodexCloudCanonicalSettlementV1 = "open" | "settled" | "superseded";
export type CodexCloudExperimentFreezeV1 = "open" | "frozen";

export interface CodexCloudCanonicalPlacementFactsV1 {
  readonly ownerRef: string;
  readonly ownerGeneration: number;
  readonly remoteRef: string;
  readonly head: string;
  readonly settlement: CodexCloudCanonicalSettlementV1;
  readonly experimentFreeze: CodexCloudExperimentFreezeV1;
}

export interface CodexCloudPlacementPreflightInputV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly phase: CodexCloudPlacementPhaseV1;
  readonly repository: string;
  readonly missionRef: string;
  readonly expected: CodexCloudCanonicalPlacementFactsV1;
  readonly current: CodexCloudCanonicalPlacementFactsV1;
  readonly inspection: {
    readonly isolatedTemporaryCwd: boolean;
    readonly repositoryDiagnosticPaths: readonly string[];
  };
}

export type CodexCloudPlacementDenialV1 =
  | "canonical_owner_changed"
  | "canonical_ref_changed"
  | "canonical_head_changed"
  | "canonical_mission_settled"
  | "canonical_mission_superseded"
  | "experiment_frozen"
  | "inspection_cwd_not_isolated"
  | "repository_diagnostic_created";

export interface CodexCloudPlacementPreflightV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly phase: CodexCloudPlacementPhaseV1;
  readonly placementEligible: boolean;
  readonly disposition: "admit" | "stale_release";
  readonly authorizesDispatch: false;
  readonly authorizesResultApplication: false;
  readonly denials: readonly CodexCloudPlacementDenialV1[];
  readonly fingerprint: string;
}

/**
 * Pure admission evidence. The caller supplies facts freshly resolved from the
 * canonical issue/PR owner immediately before dispatch or result application.
 * This function neither discovers authority nor performs either action.
 */
export function adjudicateCodexCloudPlacementV1(
  input: CodexCloudPlacementPreflightInputV1,
): CodexCloudPlacementPreflightV1 {
  const parsed = parseInput(input);
  const denials: CodexCloudPlacementDenialV1[] = [];
  if (
    parsed.expected.ownerRef !== parsed.current.ownerRef
    || parsed.expected.ownerGeneration !== parsed.current.ownerGeneration
  ) denials.push("canonical_owner_changed");
  if (parsed.expected.remoteRef !== parsed.current.remoteRef) denials.push("canonical_ref_changed");
  if (parsed.expected.head !== parsed.current.head) denials.push("canonical_head_changed");
  if (parsed.current.settlement === "settled") denials.push("canonical_mission_settled");
  if (parsed.current.settlement === "superseded") denials.push("canonical_mission_superseded");
  if (parsed.current.experimentFreeze === "frozen") denials.push("experiment_frozen");
  if (!parsed.inspection.isolatedTemporaryCwd) denials.push("inspection_cwd_not_isolated");
  if (parsed.inspection.repositoryDiagnosticPaths.length > 0) {
    denials.push("repository_diagnostic_created");
  }
  const uniqueDenials = [...new Set(denials)];
  return deepFreeze({
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    phase: parsed.phase,
    placementEligible: uniqueDenials.length === 0,
    disposition: uniqueDenials.length === 0 ? "admit" : "stale_release",
    authorizesDispatch: false,
    authorizesResultApplication: false,
    denials: uniqueDenials,
    fingerprint: fingerprintCanonicalRequest(parsed),
  });
}

function parseInput(input: CodexCloudPlacementPreflightInputV1): CodexCloudPlacementPreflightInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Codex cloud placement preflight input must be an object");
  }
  if (input.version !== CODEX_ROOT_CLOUD_PLACEMENT_V1) {
    throw new RangeError("Codex cloud placement preflight version is invalid");
  }
  if (input.phase !== "pre_dispatch" && input.phase !== "pre_result_application") {
    throw new RangeError("Codex cloud placement phase is invalid");
  }
  const repository = text(input.repository, "Repository", 240);
  const missionRef = text(input.missionRef, "Mission reference", 240);
  const expected = placementFacts(input.expected, "Expected placement facts");
  const current = placementFacts(input.current, "Current placement facts");
  if (typeof input.inspection?.isolatedTemporaryCwd !== "boolean") {
    throw new TypeError("Cloud inspection isolated-temporary-cwd flag must be boolean");
  }
  if (!Array.isArray(input.inspection.repositoryDiagnosticPaths)
    || input.inspection.repositoryDiagnosticPaths.length > 100) {
    throw new RangeError("Repository diagnostic paths must be a bounded array");
  }
  const repositoryDiagnosticPaths = input.inspection.repositoryDiagnosticPaths.map((path) =>
    text(path, "Repository diagnostic path", 4_096)
  );
  if (new Set(repositoryDiagnosticPaths).size !== repositoryDiagnosticPaths.length) {
    throw new RangeError("Repository diagnostic paths must be unique");
  }
  return deepFreeze({
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    phase: input.phase,
    repository,
    missionRef,
    expected,
    current,
    inspection: {
      isolatedTemporaryCwd: input.inspection.isolatedTemporaryCwd,
      repositoryDiagnosticPaths: [...repositoryDiagnosticPaths].sort(),
    },
  });
}

function placementFacts(
  value: CodexCloudCanonicalPlacementFactsV1,
  label: string,
): CodexCloudCanonicalPlacementFactsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (value.settlement !== "open" && value.settlement !== "settled" && value.settlement !== "superseded") {
    throw new RangeError(`${label} settlement is invalid`);
  }
  if (value.experimentFreeze !== "open" && value.experimentFreeze !== "frozen") {
    throw new RangeError(`${label} experiment freeze is invalid`);
  }
  return deepFreeze({
    ownerRef: text(value.ownerRef, `${label} owner`, 240),
    ownerGeneration: positiveInteger(value.ownerGeneration, `${label} owner generation`),
    remoteRef: gitRef(value.remoteRef, `${label} remote ref`),
    head: sha(value.head, `${label} head`),
    settlement: value.settlement,
    experimentFreeze: value.experimentFreeze,
  });
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return value as number;
}

function gitRef(value: unknown, label: string): string {
  const output = text(value, label, 1_024);
  if (!output.startsWith("refs/") || output.includes("..") || output.includes("@{") || output.endsWith("/")) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function sha(value: unknown, label: string): string {
  const output = text(value, label, 40);
  if (!/^[0-9a-f]{40}$/u.test(output)) throw new RangeError(`${label} must be an exact Git SHA-1`);
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
