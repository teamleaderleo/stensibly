import { describe, expect, test } from "bun:test";
import { checkModel } from "../model/claim-run/check.js";

describe("bounded claim/run lifecycle model", () => {
  test("checks fences, terminal races, recovery, and #250 negative controls", () => {
    const report = checkModel({ maxDepth: 8, maxTime: 4 });

    expect(report.exploration.reachableStates).toBeGreaterThan(1_000);
    expect(report.exploration.exploredTransitions).toBeGreaterThan(
      report.exploration.reachableStates,
    );
    expect(
      Object.values(report.invariants).every((value) => value === "passed"),
    ).toBe(true);
    expect(
      Object.values(report.boundedLiveness).every((value) => value === "passed"),
    ).toBe(true);
    expect(report.negativeControls.map((entry) => entry.kind)).toEqual([
      "stale_same_actor_generation",
      "missing_run_lease",
    ]);
    expect(report.negativeControls[0]?.trace).toEqual([
      "acquire:supervisor-a:runner-a",
      "dispatch:supervisor-a:runner-a:cg1",
      "release:runner-a:g1",
      "acquire:supervisor-a:runner-a",
    ]);
  });
});
