import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath =
  ".github/workflows/junco-1009-tlc-proof-v3.yml";

const obligations = [
  ["coreSafeModel", "CancellationSettlement.cfg"],
  ["activeSafeModel", "CancellationSettlementActive.cfg"],
  ["unsafeFence", "ReplacementRequiresFenceOrSettlement"],
  ["unsafeStale", "StaleGenerationCannotPublish"],
  ["preCloseSuccess", "PreCloseSuccessFailureWitnessAbsent"],
  ["preCloseFailure", "PreCloseFailureReconciliationWitnessAbsent"],
  ["repeatedClose", "RepeatedCloseWitnessAbsent"],
  ["cancelledRetry", "CancelledRetryWitnessAbsent"],
  ["activeRejoin", "ActiveRejoinWitnessAbsent"],
] as const;

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

describe("cancellation settlement TLC proof receipt contract", () => {
  test("publishes one fail-closed record for every proof obligation", () => {
    const source = workflow();

    expect(source).not.toContain(
      "cancelledWaiterHasRetryCapacity:true",
    );
    expect(source).not.toContain(
      "activeRejoinReachesTerminal:true",
    );

    for (const [key, expected] of obligations) {
      expect(source).toContain(expected);
      expect(source).toContain(`steps.proof.outputs.${key}Status`);
      expect(source).toContain(`steps.proof.outputs.${key}Exit`);
      expect(source).toContain(`--arg ${key}Status`);
      expect(source).toContain(`--argjson ${key}Exit`);
      expect(source).toMatch(
        new RegExp(
          `${key}[^\\n]*(?:passed|failed|not_run)`,
          "u",
        ),
      );
    }
  });

  test("keeps stage and aggregate receipt state fail closed", () => {
    const source = workflow();

    expect(source).not.toContain("--arg failed");
    expect(source).toContain("--argjson failed");
    expect(source).toContain("not_run");

    for (const stage of ["install", "parse", "proof"]) {
      expect(source).toContain(`steps.${stage}.outputs.status`);
    }

    expect(source).toContain("all_obligations_passed");
    expect(source).toContain('proof_status="failed"');
    expect(source).toContain('proof_status="passed"');
    expect(source).not.toContain("proofStatus:passed");
  });

  test("requires a pinned SHA-256 before TLC execution", () => {
    const source = workflow();

    expect(source).toContain("TLC_SHA256");
    expect(source).toContain("sha256sum --check --strict");
    expect(source).toMatch(/TLC_SHA256:\s*[a-f0-9]{64}/u);
  });

  test("requires non-empty safe state summaries before proof success", () => {
    const source = workflow();

    expect(source).toContain('test -n "$core"');
    expect(source).toContain('test -n "$active"');
    expect(source).toContain("coreSafeStateSummary");
    expect(source).toContain("activeSafeStateSummary");
  });

  test("keeps the receipt diagnostic and non-authorizing", () => {
    const source = workflow();

    expect(source).toContain("if: always()");
    expect(source).toContain("authorizesMerge:false");
    expect(source).toContain("authorizesMutation:false");
    expect(source).toContain("retention-days: 14");
  });
});
