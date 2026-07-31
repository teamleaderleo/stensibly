import { describe, expect, test } from "bun:test";
import {
  compareCoordinationGraphs,
  coordinationNodeInputFingerprint,
  evaluateCoordinationGraphChange,
  type CoordinationGraph,
  type CoordinationGraphNode,
} from "../src/coordination-graph.ts";

const evaluatedAt = "2026-07-30T00:00:00.000Z";
const graphPolicyVersion = "compiler-v1";

function hash(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function pending(id: string, overrides: Partial<CoordinationGraphNode> = {}): CoordinationGraphNode {
  return {
    id,
    generation: 1,
    kind: "evidence",
    workspace: "main",
    project: "fieldwork",
    definitionFingerprint: hash(id.length),
    environmentFingerprint: hash(id.length + 1),
    policyVersion: "policy-v1",
    authorityGeneration: 1,
    owner: "actor:juniper",
    declaredState: "pending",
    receipt: null,
    ...overrides,
  };
}

function accepted(
  base: CoordinationGraphNode,
  outputFingerprint: string,
): CoordinationGraphNode {
  const candidate = { ...base, declaredState: "accepted" as const, receipt: null };
  return {
    ...candidate,
    receipt: {
      inputFingerprint: coordinationNodeInputFingerprint(
        candidate,
        [],
        graphPolicyVersion,
      ),
      outputFingerprint,
      status: "accepted",
      observedAt: "2026-07-29T23:00:00.000Z",
      expiresAt: null,
    },
  };
}

function graph(nodes: CoordinationGraphNode[]): CoordinationGraph {
  return {
    schemaVersion: 1,
    workspace: "main",
    project: "fieldwork",
    policyVersion: graphPolicyVersion,
    nodes,
    edges: [],
  };
}

describe("coordination graph reevaluation", () => {
  test("accepts a fresh exact receipt even when the candidate node changed", () => {
    const previousNode = pending("source");
    const candidateNode = accepted(previousNode, hash(9));
    const comparison = compareCoordinationGraphs(graph([previousNode]), graph([candidateNode]));
    expect(comparison.changedNodeKeys).toEqual(["source@1"]);

    const result = evaluateCoordinationGraphChange(
      graph([previousNode]),
      graph([candidateNode]),
      evaluatedAt,
    );
    expect(result.nodes[0]).toMatchObject({
      key: "source@1",
      state: "accepted",
      affected: true,
      outputFingerprint: hash(9),
      reasons: ["fresh accepted receipt proves the reevaluated complete inputs"],
    });
  });

  test("keeps an exact receipt accepted after an input change when the receipt binds the new input", () => {
    const previous = accepted(pending("source"), hash(8));
    const changedBase = pending("source", {
      definitionFingerprint: hash(12),
      owner: "actor:lumen",
    });
    const candidate = accepted(changedBase, hash(8));

    const result = evaluateCoordinationGraphChange(
      graph([previous]),
      graph([candidate]),
      evaluatedAt,
    );
    expect(result.nodes[0]).toMatchObject({
      state: "accepted",
      affected: true,
      outputFingerprint: hash(8),
    });
  });

  test("includes owner identity in the complete input fingerprint", () => {
    const first = pending("source", { owner: "actor:juniper" });
    const second = pending("source", { owner: "actor:lumen" });
    expect(coordinationNodeInputFingerprint(first, [], graphPolicyVersion))
      .not.toBe(coordinationNodeInputFingerprint(second, [], graphPolicyVersion));
  });

  test("includes graph policy identity in the complete input fingerprint", () => {
    const source = pending("source");
    expect(coordinationNodeInputFingerprint(source, [], "compiler-v1"))
      .not.toBe(coordinationNodeInputFingerprint(source, [], "compiler-v2"));
  });

  test("still marks an affected node stale when it reuses the old receipt", () => {
    const previous = accepted(pending("source"), hash(8));
    const candidate = {
      ...previous,
      definitionFingerprint: hash(12),
    };
    const result = evaluateCoordinationGraphChange(
      graph([previous]),
      graph([candidate]),
      evaluatedAt,
    );
    expect(result.nodes[0]).toMatchObject({
      state: "stale",
      affected: true,
      outputFingerprint: null,
    });
  });
});
