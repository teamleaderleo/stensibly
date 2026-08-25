import { describe, expect, test } from "bun:test";
import {
  CODEX_ROOT_ROUTING_V1,
  codexRootRoutingCandidateById,
  codexRootRoutingCandidates,
  type CodexRootRoutingCandidate,
} from "../src/codex-root-routing.js";

describe("Codex root routing candidates", () => {
  test("exposes exactly three routing candidates", () => {
    const candidates = codexRootRoutingCandidates();

    expect(candidates).toHaveLength(3);
    expect(candidates.map((entry) => entry.id)).toEqual([
      "architecture_integration",
      "bounded_hot_path",
      "settled_implementation",
    ]);

    expect(candidates[0] as CodexRootRoutingCandidate).toMatchObject({
      id: "architecture_integration",
      model: "gpt-5.6-sol",
      effort: "high",
      workloadClass: "architecture_integration",
      tradeoff: "reasoned_integration",
    });
    expect(candidates[1] as CodexRootRoutingCandidate).toMatchObject({
      id: "bounded_hot_path",
      model: "gpt-5.3-codex-spark",
      effort: "medium",
      workloadClass: "bounded_hot_path",
      tradeoff: "latency",
    });
    expect(candidates[2] as CodexRootRoutingCandidate).toMatchObject({
      id: "settled_implementation",
      model: "gpt-5.6-luna",
      effort: "max",
      workloadClass: "settled_implementation",
      tradeoff: "high_certainty_settlement",
    });

    expect(CODEX_ROOT_ROUTING_V1).toBe(1);
  });

  test("freezes candidates and lookup results", () => {
    const candidates = codexRootRoutingCandidates();
    expect(Object.isFrozen(candidates)).toBe(true);

    for (const candidate of candidates) {
      expect(Object.isFrozen(candidate)).toBe(true);
    }

    const bounded = codexRootRoutingCandidateById("bounded_hot_path");
    expect(Object.isFrozen(bounded)).toBe(true);
    expect(() => {
      (bounded as { id: string }).id = "mutated";
    }).toThrow();
  });

  test("validates exact candidate lookup by id", () => {
    const architecture = codexRootRoutingCandidateById("architecture_integration");
    const settlement = codexRootRoutingCandidateById("settled_implementation");

    expect(architecture.workloadClass).toBe("architecture_integration");
    expect(settlement.workloadClass).toBe("settled_implementation");
    expect(architecture.model).toBe("gpt-5.6-sol");
    expect(settlement.model).toBe("gpt-5.6-luna");

    expect(() => codexRootRoutingCandidateById("not-a-candidate")).toThrow("Unknown Codex root routing candidate id: not-a-candidate; expected one of architecture_integration, bounded_hot_path, settled_implementation");
  });
});
