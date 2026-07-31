import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalizeCoordinationGraph,
  compareCoordinationGraphs,
  coordinationGraphFingerprint,
  coordinationNodeInputFingerprint,
  coordinationNodeKey,
  evaluateCoordinationGraph,
  evaluateCoordinationGraphChange,
  renderCoordinationQueueMarkdown,
  type CoordinationGraph,
  type CoordinationGraphEdge,
  type CoordinationGraphNode,
  type CoordinationReadinessEdgeType,
} from "../src/coordination-graph.ts";

const evaluatedAt = "2026-07-30T00:00:00.000Z";
const graphPolicyVersion = "compiler-v1";

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function pendingNode(
  id: string,
  overrides: Partial<CoordinationGraphNode> = {},
): CoordinationGraphNode {
  return {
    id,
    generation: 1,
    kind: "action",
    workspace: "main",
    project: "fieldwork",
    definitionFingerprint: hash(`definition:${id}`),
    environmentFingerprint: hash("environment:default"),
    policyVersion: "policy-v1",
    authorityGeneration: 1,
    owner: "actor:juniper",
    declaredState: "pending",
    receipt: null,
    ...overrides,
  };
}

function acceptedNode(
  id: string,
  dependencies: Array<{
    key: string;
    type: CoordinationReadinessEdgeType;
    outputFingerprint: string;
  }> = [],
  overrides: Partial<CoordinationGraphNode> = {},
): CoordinationGraphNode {
  const base = pendingNode(id, {
    kind: "evidence",
    declaredState: "accepted",
    ...overrides,
    receipt: null,
  });
  return {
    ...base,
    receipt: {
      inputFingerprint: coordinationNodeInputFingerprint(
        base,
        dependencies,
        graphPolicyVersion,
      ),
      outputFingerprint: overrides.receipt?.outputFingerprint ?? hash("output:default"),
      status: "accepted",
      observedAt: "2026-07-29T20:00:00.000Z",
      expiresAt: null,
    },
  };
}

function readiness(
  type: CoordinationReadinessEdgeType,
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

function graph(
  nodes: CoordinationGraphNode[],
  edges: CoordinationGraphEdge[] = [],
  overrides: Partial<CoordinationGraph> = {},
): CoordinationGraph {
  return {
    schemaVersion: 1,
    workspace: "main",
    project: "fieldwork",
    policyVersion: graphPolicyVersion,
    nodes,
    edges,
    ...overrides,
  };
}

describe("coordination graph", () => {
  test("evaluates accepted receipts and newly eligible descendants deterministically", () => {
    const source = acceptedNode("source", [], { kind: "source" });
    const review = pendingNode("review", { kind: "review" });
    const input = graph(
      [review, source],
      [readiness("requires_review", "source", "review")],
    );

    const result = evaluateCoordinationGraph(input, { evaluatedAt });
    expect(result.topologicalOrder).toEqual(["source@1", "review@1"]);
    expect(result.nodes).toEqual([
      expect.objectContaining({
        key: "source@1",
        state: "accepted",
        outputFingerprint: hash("output:default"),
      }),
      expect.objectContaining({
        key: "review@1",
        state: "eligible",
        outputFingerprint: null,
      }),
    ]);
    expect(renderCoordinationQueueMarkdown(input, result)).toContain(
      "## ELIGIBLE · review@1",
    );
  });

  test("reuses a complete matching receipt across a full accepted chain", () => {
    const source = acceptedNode("source", [], {
      kind: "source",
      receipt: { outputFingerprint: hash("output:source") } as any,
    });
    const review = acceptedNode("review", [{
      key: "source@1",
      type: "requires_review",
      outputFingerprint: source.receipt!.outputFingerprint,
    }], {
      kind: "review",
      receipt: { outputFingerprint: hash("output:review") } as any,
    });
    const decision = acceptedNode("decision", [{
      key: "review@1",
      type: "requires_decision",
      outputFingerprint: review.receipt!.outputFingerprint,
    }], {
      kind: "decision",
      receipt: { outputFingerprint: hash("output:decision") } as any,
    });
    const input = graph(
      [decision, review, source],
      [
        readiness("requires_review", "source", "review"),
        readiness("requires_decision", "review", "decision"),
      ],
    );

    const result = evaluateCoordinationGraph(input, { evaluatedAt });
    expect(result.nodes.map(({ state }) => state)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
  });

  test("retains fresh exact proof while recording affected readiness metadata", () => {
    const source = acceptedNode("source", [], {
      kind: "source",
      receipt: { outputFingerprint: hash("output:source") } as any,
    });
    const dependent = pendingNode("dependent");
    const unrelated = acceptedNode("unrelated", [], {
      receipt: { outputFingerprint: hash("output:unrelated") } as any,
    });
    const input = graph(
      [unrelated, dependent, source],
      [readiness("requires", "source", "dependent")],
    );

    const result = evaluateCoordinationGraph(input, {
      changedNodeKeys: ["source@1"],
      evaluatedAt,
    });
    expect(result.affectedNodeKeys).toEqual(["dependent@1", "source@1"]);
    expect(result.nodes.find(({ key }) => key === "source@1")).toMatchObject({
      state: "accepted",
      affected: true,
      outputFingerprint: hash("output:source"),
    });
    expect(result.nodes.find(({ key }) => key === "dependent@1")).toMatchObject({
      state: "eligible",
      affected: true,
    });
    expect(result.nodes.find(({ key }) => key === "unrelated@1")?.state).toBe("accepted");
  });

  test("snapshot comparison invalidates changed readiness inputs but not causal history", () => {
    const source = acceptedNode("source", [], { kind: "source" });
    const dependent = pendingNode("dependent");
    const previous = graph([source, dependent], [
      readiness("requires", "source", "dependent"),
    ]);
    const causalOnly = graph([source, dependent], [
      readiness("requires", "source", "dependent"),
      {
        layer: "causal",
        type: "caused_by",
        from: { id: "dependent", generation: 1 },
        to: { id: "source", generation: 1 },
      },
    ]);
    const changedDefinition = graph([
      { ...source, definitionFingerprint: hash("definition:changed") },
      dependent,
    ], previous.edges);

    expect(compareCoordinationGraphs(previous, causalOnly).changedNodeKeys).toEqual([]);
    expect(compareCoordinationGraphs(previous, changedDefinition).changedNodeKeys)
      .toEqual(["source@1"]);
    expect(evaluateCoordinationGraphChange(previous, changedDefinition, evaluatedAt).affectedNodeKeys)
      .toEqual(["dependent@1", "source@1"]);
  });

  test("rejects missing endpoints, self-dependencies, and readiness cycles", () => {
    const first = pendingNode("first");
    const second = pendingNode("second");
    expect(() => canonicalizeCoordinationGraph(graph([first], [
      readiness("requires", "missing", "first"),
    ]))).toThrow("source missing@1 is missing");
    expect(() => canonicalizeCoordinationGraph(graph([first], [
      readiness("requires", "first", "first"),
    ]))).toThrow("cannot depend on itself");
    expect(() => canonicalizeCoordinationGraph(graph([first, second], [
      readiness("requires", "first", "second"),
      readiness("requires", "second", "first"),
    ]))).toThrow("dependency cycle");
  });

  test("allows causal cycles without turning them into readiness dependencies", () => {
    const first = acceptedNode("first");
    const second = acceptedNode("second");
    const input = graph([second, first], [
      {
        layer: "causal",
        type: "supersedes",
        from: { id: "first", generation: 1 },
        to: { id: "second", generation: 1 },
      },
      {
        layer: "causal",
        type: "recovers",
        from: { id: "second", generation: 1 },
        to: { id: "first", generation: 1 },
      },
    ]);

    expect(evaluateCoordinationGraph(input, { evaluatedAt }).nodes)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "first@1", state: "accepted" }),
        expect.objectContaining({ key: "second@1", state: "accepted" }),
      ]));
  });

  test("rejects duplicate exclusive producers and accepts an explicit competition set", () => {
    const first = acceptedNode("candidate-a");
    const second = acceptedNode("candidate-b");
    const output = pendingNode("output", { kind: "output" });
    expect(() => canonicalizeCoordinationGraph(graph([first, second, output], [
      readiness("produces", "candidate-a", "output"),
      readiness("produces", "candidate-b", "output"),
    ]))).toThrow("competing producers");

    expect(() => canonicalizeCoordinationGraph(graph([first, second, output], [
      readiness("produces", "candidate-a", "output", "candidate-set-1"),
      readiness("produces", "candidate-b", "output", "candidate-set-1"),
    ]))).not.toThrow();
  });

  test("invalidates mismatched, expired, future, and unaccepted receipts", () => {
    const mismatched = acceptedNode("mismatched");
    mismatched.receipt = {
      ...mismatched.receipt!,
      inputFingerprint: hash("input:mismatch"),
    };
    const expired = acceptedNode("expired");
    expired.receipt = {
      ...expired.receipt!,
      expiresAt: "2026-07-29T23:59:59.000Z",
    };
    const future = acceptedNode("future");
    future.receipt = {
      ...future.receipt!,
      observedAt: "2026-07-30T00:00:01.000Z",
    };
    const pendingWithAcceptedReceipt = acceptedNode("pending-receipt", [], {
      declaredState: "pending",
    });

    const result = evaluateCoordinationGraph(
      graph([mismatched, expired, future, pendingWithAcceptedReceipt]),
      { evaluatedAt },
    );
    expect(result.nodes.map(({ key, state }) => [key, state])).toEqual([
      ["expired@1", "stale"],
      ["future@1", "stale"],
      ["mismatched@1", "stale"],
      ["pending-receipt@1", "stale"],
    ]);
  });

  test("canonical output is stable across input ordering", () => {
    const first = acceptedNode("first");
    const second = pendingNode("second");
    const edge = readiness("requires", "first", "second");
    const left = graph([first, second], [edge]);
    const right = graph([second, first], [edge]);

    expect(coordinationGraphFingerprint(left)).toBe(coordinationGraphFingerprint(right));
    expect(evaluateCoordinationGraph(left, { evaluatedAt }))
      .toEqual(evaluateCoordinationGraph(right, { evaluatedAt }));
  });

  test("uses generation-specific identities", () => {
    expect(coordinationNodeKey({ id: "review", generation: 1 })).toBe("review@1");
    expect(coordinationNodeKey({ id: "review", generation: 2 })).toBe("review@2");
    expect(() => canonicalizeCoordinationGraph(graph([
      pendingNode("review"),
      pendingNode("review", { generation: 2 }),
    ]))).not.toThrow();
  });
});
