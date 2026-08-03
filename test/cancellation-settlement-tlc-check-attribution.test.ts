import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath =
  ".github/workflows/junco-1009-tlc-proof-v3.yml";

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

describe("cancellation settlement TLC receipt check attribution", () => {
  test("separates active-safe invariant evidence from retry witness reachability", () => {
    const source = workflow();

    expect(source).toContain(
      'cancelledWaiterHasRetryCapacity:($activeStatus == "passed")',
    );
    expect(source).toContain(
      'cancelledRetryWitnessReached:($cancelledRetryStatus == "passed")',
    );
    expect(source).toContain(
      'activeRejoinReachesTerminal:($activeRejoinStatus == "passed")',
    );
    expect(source).not.toContain(
      'cancelledWaiterHasRetryCapacity:($cancelledRetryStatus == "passed")',
    );
  });

  test("retains the exact invariant and witness obligations behind those checks", () => {
    const source = workflow();

    expect(source).toContain("CancellationSettlementActive.cfg");
    expect(source).toContain("CancelledWaiterHasRetryCapacity");
    expect(source).toContain("CancellationSettlementCancelledRetry.cfg");
    expect(source).toContain("CancelledRetryWitnessAbsent");
    expect(source).toContain("CancellationSettlementActiveRejoin.cfg");
    expect(source).toContain("ActiveRejoinWitnessAbsent");
  });
});
