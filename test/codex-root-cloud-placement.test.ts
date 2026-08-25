import { describe, expect, test } from "bun:test";
import {
  adjudicateCodexCloudPlacementV1,
  type CodexCloudPlacementPreflightInputV1,
} from "../src/codex-root-cloud-placement.js";

const head = "a".repeat(40);

function placement(
  overrides: Partial<CodexCloudPlacementPreflightInputV1> = {},
): CodexCloudPlacementPreflightInputV1 {
  const facts = {
    ownerRef: "github:teamleaderleo/quarry#1052",
    ownerGeneration: 3,
    remoteRef: "refs/heads/main",
    head,
    settlement: "open" as const,
    experimentFreeze: "open" as const,
  };
  return {
    version: 1,
    phase: "pre_dispatch",
    repository: "teamleaderleo/quarry",
    missionRef: "github:teamleaderleo/quarry#1052",
    expected: facts,
    current: facts,
    inspection: {
      isolatedTemporaryCwd: true,
      repositoryDiagnosticPaths: [],
    },
    ...overrides,
  };
}

describe("Codex cloud placement preflight", () => {
  test("admits exact freshly resolved facts without authorizing dispatch or application", () => {
    const result = adjudicateCodexCloudPlacementV1(placement());
    expect(result.placementEligible).toBeTrue();
    expect(result.disposition).toBe("admit");
    expect(result.authorizesDispatch).toBeFalse();
    expect(result.authorizesResultApplication).toBeFalse();
    expect(result.denials).toEqual([]);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("stale-releases the #1052 shape already settled and frozen before dispatch", () => {
    const current = {
      ...placement().current,
      settlement: "settled" as const,
      experimentFreeze: "frozen" as const,
    };
    const result = adjudicateCodexCloudPlacementV1(placement({ current }));
    expect(result.placementEligible).toBeFalse();
    expect(result.disposition).toBe("stale_release");
    expect(result.denials).toEqual(["canonical_mission_settled", "experiment_frozen"]);
  });

  test("rechecks exact owner/ref/head and repository hygiene before result application", () => {
    const result = adjudicateCodexCloudPlacementV1(placement({
      phase: "pre_result_application",
      current: {
        ...placement().current,
        ownerGeneration: 4,
        head: "b".repeat(40),
      },
      inspection: {
        isolatedTemporaryCwd: false,
        repositoryDiagnosticPaths: ["error.log"],
      },
    }));
    expect(result.disposition).toBe("stale_release");
    expect(result.denials).toEqual([
      "canonical_owner_changed",
      "canonical_head_changed",
      "inspection_cwd_not_isolated",
      "repository_diagnostic_created",
    ]);
  });
});
