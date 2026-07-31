import { describe, expect, test } from "bun:test";
import {
  COORDINATION_GRAPH_MAX_NODES,
  canonicalizeCoordinationGraph,
  compareCoordinationGraphs,
  coordinationNodeInputFingerprint,
  evaluateCoordinationGraph,
  type CoordinationDeclaredState,
  type CoordinationGraph,
  type CoordinationGraphNode,
  type CoordinationReceiptStatus,
} from "../src/coordination-graph.ts";

const evaluatedAt = "2026-07-30T00:00:00.000Z";
const graphPolicyVersion = "compiler-v1";

function hash(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function node(
  id: string,
  overrides: Partial<CoordinationGraphNode> = {},
): CoordinationGraphNode {
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
    owner: null,
    declaredState: "pending",
    receipt: null,
    ...overrides,
  };
}

function disposedNode(
  id: string,
  declaredState: CoordinationDeclaredState,
  status: CoordinationReceiptStatus,
): CoordinationGraphNode {
  const base = node(id, { declaredState });
  return {
    ...base,
    receipt: {
      inputFingerprint: coordinationNodeInputFingerprint(
        base,
        [],
        graphPolicyVersion,
      ),
      outputFingerprint: hash(id.length + 2),
      status,
      observedAt: "2026-07-29T23:00:00.000Z",
      expiresAt: null,
    },
  };
}

function graph(
  nodes: CoordinationGraphNode[],
  overrides: Partial<CoordinationGraph> = {},
): CoordinationGraph {
  return {
    schemaVersion: 1,
    workspace: "main",
    project: "fieldwork",
    policyVersion: graphPolicyVersion,
    nodes,
    edges: [],
    ...overrides,
  };
}

describe("coordination graph validation", () => {
  test("enforces graph bounds and unique generation-specific identities", () => {
    const excessive = Array.from(
      { length: COORDINATION_GRAPH_MAX_NODES + 1 },
      (_, index) => node(`node-${index + 1}`),
    );
    expect(() => canonicalizeCoordinationGraph(graph(excessive)))
      .toThrow(`at most ${COORDINATION_GRAPH_MAX_NODES} entries`);
    expect(() => canonicalizeCoordinationGraph(graph([node("same"), node("same")])))
      .toThrow("Duplicate coordination node same@1");
  });

  test("rejects loose, impossible, and future receipt timestamps", () => {
    const loose = node("loose", {
      declaredState: "accepted",
      receipt: {
        inputFingerprint: hash(1),
        outputFingerprint: hash(2),
        status: "accepted",
        observedAt: "July 29, 2026 23:00 UTC",
        expiresAt: null,
      },
    });
    expect(() => canonicalizeCoordinationGraph(graph([loose])))
      .toThrow("canonical UTC timestamp");

    const impossible = node("impossible", {
      declaredState: "accepted",
      receipt: {
        inputFingerprint: hash(1),
        outputFingerprint: hash(2),
        status: "accepted",
        observedAt: "2026-02-30T23:00:00Z",
        expiresAt: null,
      },
    });
    expect(() => canonicalizeCoordinationGraph(graph([impossible])))
      .toThrow("canonical UTC timestamp");

    const futureBase = node("future", { declaredState: "accepted" });
    const future = {
      ...futureBase,
      receipt: {
        inputFingerprint: coordinationNodeInputFingerprint(
          futureBase,
          [],
          graphPolicyVersion,
        ),
        outputFingerprint: hash(3),
        status: "accepted" as const,
        observedAt: "2026-07-30T00:00:01.000Z",
        expiresAt: null,
      },
    };
    expect(evaluateCoordinationGraph(graph([future]), { evaluatedAt }).nodes[0])
      .toMatchObject({
        state: "stale",
        reasons: ["receipt observation occurs after the immutable evaluation time"],
      });
  });

  test("detects graph policy, node policy, authority, owner, and environment changes", () => {
    const previous = graph([node("action")]);
    for (const candidate of [
      graph([node("action")], { policyVersion: "compiler-v2" }),
      graph([node("action", { policyVersion: "policy-v2" })]),
      graph([node("action", { authorityGeneration: 2 })]),
      graph([node("action", { owner: "actor:lumen" })]),
      graph([node("action", { environmentFingerprint: hash(14) })]),
    ]) {
      expect(compareCoordinationGraphs(previous, candidate).changedNodeKeys)
        .toEqual(["action@1"]);
    }
  });

  test("rejects undeclared fields and accessor-backed authority data", () => {
    expect(() => canonicalizeCoordinationGraph({
      ...graph([node("source")]),
      unknown: true,
    })).toThrow("Coordination graph contains unknown field unknown");

    expect(() => canonicalizeCoordinationGraph(graph([{
      ...node("source"),
      unknown: true,
    } as CoordinationGraphNode]))).toThrow(
      "Coordination node contains unknown field unknown",
    );

    const receiptNode = disposedNode("receipt", "accepted", "accepted");
    receiptNode.receipt = {
      ...receiptNode.receipt!,
      unknown: true,
    } as CoordinationGraphNode["receipt"];
    expect(() => canonicalizeCoordinationGraph(graph([receiptNode])))
      .toThrow("Coordination receipt contains unknown field unknown");

    let getterCalls = 0;
    const hostile = { ...node("hostile") } as Record<string, unknown>;
    Object.defineProperty(hostile, "owner", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "actor:hostile";
      },
    });
    expect(() => canonicalizeCoordinationGraph(graph([
      hostile as unknown as CoordinationGraphNode,
    ]))).toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);
  });

  test("rejects sparse and decorated graph arrays", () => {
    const sparse = graph([node("source")]);
    sparse.nodes.length = 2;
    expect(() => canonicalizeCoordinationGraph(sparse)).toThrow("must be dense");

    const decorated = graph([node("source")]);
    Object.assign(decorated.nodes, { extra: true });
    expect(() => canonicalizeCoordinationGraph(decorated))
      .toThrow("contains unknown field extra");
  });

  test("represents exact failed and ambiguous evidence without granting readiness", () => {
    const failed = disposedNode("failed", "failed", "failed");
    const ambiguous = disposedNode("ambiguous", "ambiguous", "ambiguous");
    const result = evaluateCoordinationGraph(graph([failed, ambiguous]), { evaluatedAt });

    expect(result.nodes.map(({ key, state }) => [key, state])).toEqual([
      ["ambiguous@1", "ambiguous"],
      ["failed@1", "failed"],
    ]);
  });

  test("rejects state and receipt disposition disagreement", () => {
    const mismatched = disposedNode("mismatch", "accepted", "failed");
    expect(evaluateCoordinationGraph(graph([mismatched]), { evaluatedAt }).nodes[0])
      .toMatchObject({ state: "stale" });
  });
});
