import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjudicateCodexCloudPlacementV1,
  codexCloudCanonicalReadEvidenceV1,
  runCodexCloudInspectionCommandV1,
  type CodexCloudCanonicalPlacementFactsV1,
  type CodexCloudInspectionEvidenceV1,
  type CodexCloudPlacementPreflightInputV1,
  type CodexCloudPlacementPreflightV1,
} from "../src/codex-root-cloud-placement.js";

const temporaryRoots: string[] = [];
const head = "a".repeat(40);
const facts: CodexCloudCanonicalPlacementFactsV1 = {
  ownerRef: "github:teamleaderleo/quarry#1052",
  ownerGeneration: 3,
  remoteRef: "refs/heads/main",
  head,
  settlement: "open",
  experimentFreeze: "open",
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-cloud-placement-test-repo-"));
  temporaryRoots.push(root);
  return root;
}

function canonicalRead(
  receiptId: string,
  observedAt: string,
  current: CodexCloudCanonicalPlacementFactsV1 = facts,
) {
  return codexCloudCanonicalReadEvidenceV1({ receiptId, observedAt, facts: current });
}

async function inspection(
  root: string,
  receiptId: string,
  observedAt: string,
  script = "require('node:fs').writeFileSync('error.log', 'temporary diagnostic')",
): Promise<CodexCloudInspectionEvidenceV1> {
  const result = await runCodexCloudInspectionCommandV1({
    executable: process.execPath,
    args: ["-e", script],
    repositoryRoots: [root],
    receiptId,
    clock: () => new Date(observedAt),
  });
  return result.evidence;
}

function placement(
  read: ReturnType<typeof canonicalRead>,
  inspected: CodexCloudInspectionEvidenceV1,
  overrides: Partial<CodexCloudPlacementPreflightInputV1> = {},
): CodexCloudPlacementPreflightInputV1 {
  return {
    version: 1,
    phase: "pre_dispatch",
    repository: "teamleaderleo/quarry",
    missionRef: "github:teamleaderleo/quarry#1052",
    expected: facts,
    canonicalRead: read,
    inspection: inspected,
    priorDispatch: null,
    ...overrides,
  };
}

function prior(result: CodexCloudPlacementPreflightV1) {
  return { preflightFingerprint: result.fingerprint, ...result.evidenceLink };
}

describe("Codex cloud placement preflight", () => {
  test("runs inspection in owned temporary cwd and scans repository diagnostics", async () => {
    const root = await repository();
    const clean = await inspection(root, "inspection-clean", "2026-08-25T14:00:01.000Z");
    expect(clean.isolatedTemporaryCwd).toBeTrue();
    expect(clean.temporaryDiagnosticPaths).toEqual(["error.log"]);
    expect(clean.repositoryDiagnosticPaths).toEqual([]);

    const diagnostic = join(root, "error.log");
    const dirty = await inspection(
      root,
      "inspection-dirty",
      "2026-08-25T14:00:02.000Z",
      `require('node:fs').writeFileSync(${JSON.stringify(diagnostic)}, 'repository diagnostic')`,
    );
    expect(dirty.repositoryDiagnosticPaths).toEqual([`${await realpath(root)}:error.log`]);
  });

  test("admits exact dispatch evidence without authorizing dispatch or application", async () => {
    const root = await repository();
    const result = adjudicateCodexCloudPlacementV1(placement(
      canonicalRead("read-dispatch", "2026-08-25T14:01:00.000Z"),
      await inspection(root, "inspect-dispatch", "2026-08-25T14:01:01.000Z"),
    ));
    expect(result.placementEligible).toBeTrue();
    expect(result.disposition).toBe("admit");
    expect(result.authorizesDispatch).toBeFalse();
    expect(result.authorizesResultApplication).toBeFalse();
    expect(result.denials).toEqual([]);
  });

  test("stale-releases the #1052 shape already settled and frozen before dispatch", async () => {
    const root = await repository();
    const current = { ...facts, settlement: "settled" as const, experimentFreeze: "frozen" as const };
    const result = adjudicateCodexCloudPlacementV1(placement(
      canonicalRead("read-settled", "2026-08-25T14:02:00.000Z", current),
      await inspection(root, "inspect-settled", "2026-08-25T14:02:01.000Z"),
    ));
    expect(result.disposition).toBe("stale_release");
    expect(result.denials).toEqual(["canonical_mission_settled", "experiment_frozen"]);
  });

  test("cannot replay dispatch evidence as the result-application read", async () => {
    const root = await repository();
    const read = canonicalRead("read-replay", "2026-08-25T14:03:00.000Z");
    const inspected = await inspection(root, "inspect-replay", "2026-08-25T14:03:01.000Z");
    const dispatch = adjudicateCodexCloudPlacementV1(placement(read, inspected));
    const replay = adjudicateCodexCloudPlacementV1(placement(read, inspected, {
      phase: "pre_result_application",
      priorDispatch: prior(dispatch),
    }));
    expect(replay.placementEligible).toBeFalse();
    expect(replay.denials).toEqual(["canonical_read_not_fresh", "inspection_not_fresh"]);
  });

  test("admits a result only after fresh linked canonical read and inspection", async () => {
    const root = await repository();
    const dispatch = adjudicateCodexCloudPlacementV1(placement(
      canonicalRead("read-before-dispatch", "2026-08-25T14:04:00.000Z"),
      await inspection(root, "inspect-before-dispatch", "2026-08-25T14:04:01.000Z"),
    ));
    const result = adjudicateCodexCloudPlacementV1(placement(
      canonicalRead("read-before-result", "2026-08-25T14:05:00.000Z"),
      await inspection(root, "inspect-before-result", "2026-08-25T14:05:01.000Z"),
      { phase: "pre_result_application", priorDispatch: prior(dispatch) },
    ));
    expect(result.placementEligible).toBeTrue();
    expect(result.denials).toEqual([]);
  });

  test("denies a repository diagnostic discovered by the inspection boundary", async () => {
    const root = await repository();
    await writeFile(join(root, "error.log"), "account routing diagnostic");
    const result = adjudicateCodexCloudPlacementV1(placement(
      canonicalRead("read-diagnostic", "2026-08-25T14:06:00.000Z"),
      await inspection(root, "inspect-diagnostic", "2026-08-25T14:06:01.000Z", ""),
    ));
    expect(result.disposition).toBe("stale_release");
    expect(result.denials).toContain("repository_diagnostic_created");
  });
});
