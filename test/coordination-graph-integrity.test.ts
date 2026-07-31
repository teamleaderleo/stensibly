import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalizeCoordinationGraph,
  coordinationNodeInputFingerprint,
  evaluateCoordinationGraph,
  evaluateCoordinationGraphChange,
  renderCoordinationQueueMarkdown,
  type CoordinationFingerprintDependency,
  type CoordinationGraph,
  type CoordinationGraphEdge,
  type CoordinationGraphNode,
} from "../src/coordination-graph.ts";

const evaluatedAt = "2026-07-30T00:00:00.000Z";
const graphPolicyVersion = "compiler-v1";

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function baseNode(
  id: string,
  overrides: Partial<CoordinationGraphNode> = {},
): CoordinationGraphNode {
  return {
    id,
    generation: 1,
    kind: "evidence",
    workspace: "main",
    project: "fieldwork",
    definitionFingerprint: hash(`definition:${id}`),
    environmentFingerprint: hash("environment:default"),
    policyVersion: "policy-v1",
    authorityGeneration: 1,
    owner: "actor:nacre",
    declaredState: "pending",
    receipt: null,
    ...overrides,
  };
}

function acceptedNode(
  node: CoordinationGraphNode,
  dependencies: CoordinationFingerprintDependency[],
  outputFingerprint: string,
): CoordinationGraphNode {
  const accepted = { ...node, declaredState: "accepted" as const, receipt: null };
  return {
    ...accepted,
    receipt: {
      inputFingerprint: coordinationNodeInputFingerprint(
        accepted,
        dependencies,
        graphPolicyVersion,
      ),
      outputFingerprint,
      status: "accepted",
      observedAt: "2026-07-29T23:00:00.000Z",
      expiresAt: null,
    },
  };
}

function edge(
  type: "produces" | "requires",
  from: string,
  to: string,
  competitionId?: string,
): CoordinationGraphEdge {
  return {
    layer: "readiness",
    type,
    from: { id: from, generation: 1 },
    to: { id: to, generation: 1 },
    ...(competitionId ? { competitionId } : {}),
  };
}

function selectedGraph(
  candidateA: CoordinationGraphNode,
  candidateB: CoordinationGraphNode,
  decision: CoordinationGraphNode,
  projection: CoordinationGraphNode,
): CoordinationGraph {
  return {
    schemaVersion: 1,
    workspace: "main",
    project: "fieldwork",
    policyVersion: graphPolicyVersion,
    nodes: [candidateA, candidateB, decision, projection],
    edges: [
      edge("produces", "candidate-a", "decision", "candidate-set-1"),
      edge("produces", "candidate-b", "decision", "candidate-set-1"),
      edge("requires", "decision", "projection"),
    ],
  };
}

function fixture(): CoordinationGraph {
  const candidateA = acceptedNode(
    baseNode("candidate-a"),
    [],
    hash("output:candidate-a"),
  );
  const candidateB = acceptedNode(
    baseNode("candidate-b"),
    [],
    hash("output:candidate-b"),
  );
  const decision = acceptedNode(
    baseNode("decision", {
      kind: "decision",
      selectedProducer: { id: "candidate-a", generation: 1 },
    }),
    [{
      key: "candidate-a@1",
      type: "produces",
      outputFingerprint: candidateA.receipt!.outputFingerprint,
      competitionId: "candidate-set-1",
    }],
    hash("output:decision"),
  );
  const projection = acceptedNode(
    baseNode("projection", { kind: "projection" }),
    [{
      key: "decision@1",
      type: "requires",
      outputFingerprint: decision.receipt!.outputFingerprint,
    }],
    hash("output:projection"),
  );
  return selectedGraph(candidateA, candidateB, decision, projection);
}

describe("coordination graph integrity repair", () => {
  test("keeps the selected chain reusable when an accepted losing candidate changes", () => {
    const previous = fixture();
    const candidateB = acceptedNode(
      baseNode("candidate-b", { definitionFingerprint: hash("definition:candidate-b-v2") }),
      [],
      hash("output:candidate-b-v2"),
    );
    const candidate = selectedGraph(
      previous.nodes.find(({ id }) => id === "candidate-a")!,
      candidateB,
      previous.nodes.find(({ id }) => id === "decision")!,
      previous.nodes.find(({ id }) => id === "projection")!,
    );

    const result = evaluateCoordinationGraphChange(previous, candidate, evaluatedAt);
    expect(result.nodes.find(({ key }) => key === "decision@1")).toMatchObject({
      state: "accepted",
      affected: true,
    });
    expect(result.nodes.find(({ key }) => key === "projection@1")).toMatchObject({
      state: "accepted",
      affected: true,
    });
  });

  test("stales the selected chain when the winner output or selection identity changes", () => {
    const previous = fixture();
    const changedA = acceptedNode(
      baseNode("candidate-a", { definitionFingerprint: hash("definition:candidate-a-v2") }),
      [],
      hash("output:candidate-a-v2"),
    );
    const selectedChange = evaluateCoordinationGraphChange(
      previous,
      selectedGraph(
        changedA,
        previous.nodes.find(({ id }) => id === "candidate-b")!,
        previous.nodes.find(({ id }) => id === "decision")!,
        previous.nodes.find(({ id }) => id === "projection")!,
      ),
      evaluatedAt,
    );
    expect(selectedChange.nodes.find(({ key }) => key === "decision@1")?.state).toBe("stale");
    expect(selectedChange.nodes.find(({ key }) => key === "projection@1")?.state).toBe("blocked");

    const changedSelection = {
      ...previous.nodes.find(({ id }) => id === "decision")!,
      selectedProducer: { id: "candidate-b", generation: 1 },
    };
    const selectionChange = evaluateCoordinationGraphChange(
      previous,
      selectedGraph(
        previous.nodes.find(({ id }) => id === "candidate-a")!,
        previous.nodes.find(({ id }) => id === "candidate-b")!,
        changedSelection,
        previous.nodes.find(({ id }) => id === "projection")!,
      ),
      evaluatedAt,
    );
    expect(selectionChange.nodes.find(({ key }) => key === "decision@1")?.state).toBe("stale");
    expect(selectionChange.nodes.find(({ key }) => key === "projection@1")?.state).toBe("blocked");
  });

  test("keeps unresolved competitions blocked and rejects an out-of-group selection", () => {
    const input = fixture();
    const unresolvedDecision = {
      ...input.nodes.find(({ id }) => id === "decision")!,
      selectedProducer: null,
      receipt: null,
      declaredState: "pending" as const,
    };
    const unresolved = selectedGraph(
      input.nodes.find(({ id }) => id === "candidate-a")!,
      input.nodes.find(({ id }) => id === "candidate-b")!,
      unresolvedDecision,
      input.nodes.find(({ id }) => id === "projection")!,
    );
    expect(evaluateCoordinationGraph(unresolved, { evaluatedAt }).nodes.find(
      ({ key }) => key === "decision@1",
    )).toMatchObject({
      state: "blocked",
      reasons: ["competition candidate-set-1 requires an explicit selected producer"],
    });

    const invalidDecision = {
      ...unresolvedDecision,
      selectedProducer: { id: "projection", generation: 1 },
    };
    expect(() => canonicalizeCoordinationGraph(selectedGraph(
      input.nodes.find(({ id }) => id === "candidate-a")!,
      input.nodes.find(({ id }) => id === "candidate-b")!,
      invalidDecision,
      input.nodes.find(({ id }) => id === "projection")!,
    ))).toThrow("is outside competition for decision@1");
  });

  test("requires explicit evaluation time", () => {
    const input = fixture();
    expect(() => evaluateCoordinationGraph(input, {} as never))
      .toThrow("Coordination evaluation time must be a canonical UTC timestamp");
    expect(() => evaluateCoordinationGraphChange(input, input, undefined as never))
      .toThrow("Coordination evaluation time must be a canonical UTC timestamp");
  });

  test("deeply freezes issued evaluations and rejects forged rendering inputs", () => {
    const input = fixture();
    const result = evaluateCoordinationGraph(input, { evaluatedAt });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodes)).toBe(true);
    expect(Object.isFrozen(result.nodes[0])).toBe(true);
    expect(Object.isFrozen(result.nodes[0]!.reasons)).toBe(true);
    expect(renderCoordinationQueueMarkdown(input, result)).toContain(
      "## ACCEPTED · decision@1",
    );
    expect(renderCoordinationQueueMarkdown(input, { evaluatedAt })).toContain(
      "## ACCEPTED · decision@1",
    );

    const forged = structuredClone(result);
    forged.nodes[0]!.state = "failed";
    forged.nodes[0]!.reasons = ["github_pat_secret-shaped-value"];
    expect(() => renderCoordinationQueueMarkdown(input, forged))
      .toThrow("Coordination evaluation options contains unknown field schemaVersion");

    let getterCalls = 0;
    const hostile: string[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "candidate-a@1";
      },
    });
    hostile.length = 1;
    expect(() => renderCoordinationQueueMarkdown(input, {
      evaluatedAt,
      changedNodeKeys: hostile,
    })).toThrow("must contain enumerable data entries");
    expect(getterCalls).toBe(0);
  });

  test("admits exact new identities and rejects padded aliases", () => {
    const input = fixture();
    const canonical = canonicalizeCoordinationGraph(input);
    expect(canonical.nodes.find(({ id }) => id === "decision")?.selectedProducer)
      .toEqual({ id: "candidate-a", generation: 1 });
    expect(evaluateCoordinationGraph(input, {
      evaluatedAt,
      changedNodeKeys: ["decision@1"],
    }).changedNodeKeys).toEqual(["decision@1"]);

    const paddedSelection = structuredClone(input);
    paddedSelection.nodes.find(({ id }) => id === "decision")!.selectedProducer = {
      id: " candidate-a ",
      generation: 1,
    };
    expect(() => canonicalizeCoordinationGraph(paddedSelection))
      .toThrow("Coordination selected producer ID is invalid");
    expect(() => evaluateCoordinationGraph(input, {
      evaluatedAt,
      changedNodeKeys: [" decision@1 "],
    })).toThrow("Coordination node key is invalid");
  });

});
