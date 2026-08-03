import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath =
  ".github/workflows/junco-1009-tlc-proof-v3.yml";

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

describe("cancellation settlement TLC proof receipt contract", () => {
  test("does not hard-code proof obligations as successful", () => {
    const source = workflow();

    expect(source).not.toContain(
      "cancelledWaiterHasRetryCapacity:true",
    );
    expect(source).not.toContain(
      "activeRejoinReachesTerminal:true",
    );

    for (const obligation of [
      "cancelledWaiterHasRetryCapacity",
      "activeRejoinReachesTerminal",
    ]) {
      expect(source).toContain(`steps.proof.outputs.${obligation}`);
      expect(source).toMatch(
        new RegExp(
          `${obligation}[^\\n]*(?:passed|failed|not_run)`,
          "u",
        ),
      );
    }
  });

  test("keeps failure count numeric and distinguishes not-run stages", () => {
    const source = workflow();

    expect(source).not.toContain("--arg failed");
    expect(source).toContain("--argjson failed");
    expect(source).toContain("not_run");

    for (const stage of ["install", "parse", "proof"]) {
      expect(source).toContain(`steps.${stage}.outputs.status`);
    }
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
});
