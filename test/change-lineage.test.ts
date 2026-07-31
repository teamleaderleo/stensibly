import { describe, expect, test } from "bun:test";
import {
  CHANGE_LINEAGE_VERSION,
  compileChangeLineage,
  type ChangeLineageChangeInput,
  type ChangeLineageRevision,
} from "../src/change-lineage.ts";

const observedAt = "2026-07-31T14:30:00.000Z";
const firstSha = "a".repeat(40);
const secondSha = "b".repeat(40);
const thirdSha = "c".repeat(40);
const fourthSha = "d".repeat(40);

function revision(
  revisionId: string,
  generation: number,
  overrides: Partial<ChangeLineageRevision> = {},
): ChangeLineageRevision {
  return {
    revisionId,
    generation,
    observedAt: `2026-07-31T14:${String(10 + generation).padStart(2, "0")}:00.000Z`,
    operation: generation === 1 ? "create" : "amend",
    predecessors: generation === 1
      ? []
      : [{ changeId: "change-a", revisionId: firstSha }],
    stackParent: null,
    sourceReferences: [`github:observation:${revisionId}`],
    recoveryReference: `git:${revisionId}`,
    ...overrides,
  };
}

function change(
  changeId: string,
  currentRevisionId: string,
  revisions: ChangeLineageRevision[],
  overrides: Partial<ChangeLineageChangeInput> = {},
): ChangeLineageChangeInput {
  return {
    changeId,
    provider: "github",
    providerChangeId: `pull:${changeId}`,
    targetRef: "main",
    lifecycle: "open",
    currentRevisionId,
    supersededBy: null,
    semanticDependencies: [],
    revisions,
    requiredChecks: ["test"],
    checks: [{ name: "test", revisionId: currentRevisionId, conclusion: "success" }],
    reviewedRevisionId: currentRevisionId,
    reviewDisposition: "approved",
    unresolvedThreads: 0,
    ...overrides,
  };
}

function compile(changes: unknown[]) {
  return compileChangeLineage({
    repository: "TeamLeaderLeo/Stensibly",
    observedAt,
    changes,
  });
}

describe("change lineage compiler", () => {
  test("represents an empty provider-neutral lineage deterministically", () => {
    const result = compile([]);

    expect(result.version).toBe(CHANGE_LINEAGE_VERSION);
    expect(result.repository).toBe("teamleaderleo/stensibly");
    expect(result.changes).toEqual([]);
    expect(result.rewriteEdges).toEqual([]);
    expect(result.stackEdges).toEqual([]);
    expect(result.evaluations).toEqual([]);
    expect(result.projectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.authorizesMutation).toBe(false);
    expect(result.authorizesIntegration).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("keeps stable change identity while exact review and checks expire on amend", () => {
    const original = revision(firstSha, 1);
    const amended = revision(secondSha, 2, {
      predecessors: [{ changeId: "change-a", revisionId: firstSha }],
    });
    const result = compile([change("change-a", secondSha, [original, amended], {
      reviewedRevisionId: firstSha,
      checks: [{ name: "test", revisionId: firstSha, conclusion: "success" }],
    })]);
    const current = result.evaluations[0]!;

    expect(result.changes[0]!.stableIdentityFingerprint)
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.rewriteEdges).toEqual([{
      from: { changeId: "change-a", revisionId: firstSha },
      to: { changeId: "change-a", revisionId: secondSha },
      operation: "amend",
    }]);
    expect(current).toMatchObject({
      changeId: "change-a",
      currentRevisionId: secondSha,
      state: "waiting_for_review",
      reasons: ["review_stale", "required_check_stale"],
      reviewFresh: false,
      checksFresh: false,
      authorizesMutation: false,
      authorizesIntegration: false,
    });
  });

  test("marks an exact reviewed green current revision advisory-ready", () => {
    const result = compile([change(
      "change-a",
      firstSha,
      [revision(firstSha, 1)],
    )]);

    expect(result.evaluations[0]).toMatchObject({
      state: "ready",
      reasons: ["ready"],
      reviewFresh: true,
      checksFresh: true,
      authorizesMutation: false,
      authorizesIntegration: false,
    });
  });

  test("scopes provider change identity by target ref and preserves exact check names", () => {
    const main = change("gerrit-main", firstSha, [revision(firstSha, 1)], {
      provider: "gerrit",
      providerChangeId: "I0123456789abcdef",
      targetRef: "main",
      requiredChecks: ["CI / test"],
      checks: [{ name: "CI / test", revisionId: firstSha, conclusion: "success" }],
    });
    const release = change("gerrit-release", secondSha, [revision(secondSha, 1)], {
      provider: "gerrit",
      providerChangeId: "I0123456789abcdef",
      targetRef: "release/1.x",
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
      lifecycle: "merged",
    });

    const result = compile([release, main]);
    const fingerprints = result.changes.map((entry) => entry.stableIdentityFingerprint);
    expect(new Set(fingerprints).size).toBe(2);
    expect(result.changes.find((entry) => entry.changeId === "gerrit-main")?.requiredChecks)
      .toEqual(["CI / test"]);
    expect(result.evaluations.find((entry) => entry.changeId === "gerrit-main")?.state)
      .toBe("ready");
  });

  test("preserves split and squash lineage across durable changes", () => {
    const source = change("source", firstSha, [revision(firstSha, 1)], {
      lifecycle: "merged",
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
    });
    const leftRevision = revision(secondSha, 1, {
      operation: "split",
      predecessors: [{ changeId: "source", revisionId: firstSha }],
    });
    const rightRevision = revision(thirdSha, 1, {
      operation: "split",
      predecessors: [{ changeId: "source", revisionId: firstSha }],
    });
    const left = change("left", secondSha, [leftRevision], {
      providerChangeId: "pull:101",
      lifecycle: "merged",
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
    });
    const right = change("right", thirdSha, [rightRevision], {
      providerChangeId: "pull:102",
      lifecycle: "merged",
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
    });
    const combinedRevision = revision(fourthSha, 1, {
      operation: "squash",
      predecessors: [
        { changeId: "left", revisionId: secondSha },
        { changeId: "right", revisionId: thirdSha },
      ],
      stackParent: { changeId: "source", revisionId: firstSha },
    });
    const combined = change("combined", fourthSha, [combinedRevision], {
      providerChangeId: "pull:103",
      semanticDependencies: ["right"],
    });

    const result = compile([combined, right, source, left]);
    expect(result.changes.map((entry) => entry.changeId)).toEqual([
      "combined",
      "left",
      "right",
      "source",
    ]);
    expect(result.rewriteEdges).toHaveLength(4);
    expect(result.stackEdges).toEqual([{
      parent: { changeId: "source", revisionId: firstSha },
      child: { changeId: "combined", revisionId: fourthSha },
    }]);
    expect(result.changes[0]!.semanticDependencies).toEqual(["right"]);
  });

  test("requires a split predecessor to produce at least two successors", () => {
    const source = change("source", firstSha, [revision(firstSha, 1)], {
      lifecycle: "merged",
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
    });
    const only = change("only", secondSha, [revision(secondSha, 1, {
      operation: "split",
      predecessors: [{ changeId: "source", revisionId: firstSha }],
    })], { providerChangeId: "pull:only" });

    expect(() => compile([source, only])).toThrow("at least two split successors");
  });

  test("rejects rewrite, stack, dependency, and supersession cycles", () => {
    const left = change("left", firstSha, [revision(firstSha, 1, {
      operation: "rebase",
      predecessors: [{ changeId: "right", revisionId: secondSha }],
    })], { providerChangeId: "pull:left" });
    const right = change("right", secondSha, [revision(secondSha, 1, {
      operation: "rebase",
      predecessors: [{ changeId: "left", revisionId: firstSha }],
    })], { providerChangeId: "pull:right" });
    expect(() => compile([left, right])).toThrow("revision lineage cycle");

    const stackLeft = change("stack-left", firstSha, [revision(firstSha, 1, {
      stackParent: { changeId: "stack-right", revisionId: secondSha },
    })], { providerChangeId: "pull:stack-left" });
    const stackRight = change("stack-right", secondSha, [revision(secondSha, 1, {
      stackParent: { changeId: "stack-left", revisionId: firstSha },
    })], { providerChangeId: "pull:stack-right" });
    expect(() => compile([stackLeft, stackRight])).toThrow("stack cycle");

    const dependencyLeft = change("dependency-left", firstSha, [revision(firstSha, 1)], {
      providerChangeId: "pull:dependency-left",
      semanticDependencies: ["dependency-right"],
    });
    const dependencyRight = change("dependency-right", secondSha, [revision(secondSha, 1)], {
      providerChangeId: "pull:dependency-right",
      semanticDependencies: ["dependency-left"],
    });
    expect(() => compile([dependencyLeft, dependencyRight]))
      .toThrow("semantic dependency cycle");

    const old = change("old", firstSha, [revision(firstSha, 1)], {
      providerChangeId: "pull:old",
      lifecycle: "superseded",
      supersededBy: "new",
    });
    const newer = change("new", secondSha, [revision(secondSha, 1)], {
      providerChangeId: "pull:new",
      lifecycle: "superseded",
      supersededBy: "old",
    });
    expect(() => compile([old, newer])).toThrow("supersession cycle");
  });

  test("rejects future, missing, and self revision references", () => {
    const first = revision(firstSha, 1);
    const second = revision(secondSha, 2, {
      predecessors: [{ changeId: "change-a", revisionId: "f".repeat(40) }],
    });
    expect(() => compile([change("change-a", secondSha, [first, second])]))
      .toThrow("missing predecessor");

    const self = revision(firstSha, 1, {
      operation: "rebase",
      predecessors: [{ changeId: "change-a", revisionId: firstSha }],
    });
    expect(() => compile([change("change-a", firstSha, [self])]))
      .toThrow("itself as predecessor");

    const laterParent = change("parent", firstSha, [revision(firstSha, 1, {
      observedAt: "2026-07-31T14:13:00.000Z",
    })], { providerChangeId: "pull:parent" });
    const earlierChild = change("child", secondSha, [revision(secondSha, 1, {
      observedAt: "2026-07-31T14:12:00.000Z",
      operation: "rebase",
      predecessors: [{ changeId: "parent", revisionId: firstSha }],
    })], { providerChangeId: "pull:child" });
    expect(() => compile([laterParent, earlierChild]))
      .toThrow("predecessor follows the child observation");
  });

  test("rejects duplicate provider identity and contradictory current lifecycle", () => {
    const first = change("first", firstSha, [revision(firstSha, 1)], {
      providerChangeId: "pull:77",
    });
    const second = change("second", secondSha, [revision(secondSha, 1)], {
      providerChangeId: "pull:77",
    });
    expect(() => compile([first, second])).toThrow("duplicate provider change");

    expect(() => compile([change("change-a", firstSha, [revision(firstSha, 1)], {
      lifecycle: "superseded",
      supersededBy: null,
    })])).toThrow("requires exactly one superseding change");
  });

  test("rejects secret-shaped, padded, Unicode-normalized, and loose-time identity", () => {
    expect(() => compile([change("secret://change", firstSha, [revision(firstSha, 1)])]))
      .toThrow("secret-shaped");
    expect(() => compile([change(" change-a", firstSha, [revision(firstSha, 1)])]))
      .toThrow("exact printable ASCII");
    expect(() => compile([change("change a", firstSha, [revision(firstSha, 1)])]))
      .toThrow("without whitespace");
    expect(() => compile([change("ｃｈａｎｇｅ", firstSha, [revision(firstSha, 1)])]))
      .toThrow("exact printable ASCII");
    expect(() => compileChangeLineage({
      repository: "teamleaderleo/stensibly",
      observedAt: "2026-07-31",
      changes: [],
    })).toThrow("ISO UTC timestamp");
  });

  test("requires monotonic revision observations and credential-safe recovery evidence", () => {
    const first = revision(firstSha, 1, {
      observedAt: "2026-07-31T14:13:00.000Z",
    });
    const imported = revision(secondSha, 2, {
      observedAt: "2026-07-31T14:12:00.000Z",
      operation: "import",
      predecessors: [],
    });
    expect(() => compile([change("change-a", secondSha, [first, imported])]))
      .toThrow("monotonic by generation");

    expect(() => compile([change("change-a", firstSha, [revision(firstSha, 1, {
      recoveryReference: "secret://recovery",
    })])])).toThrow("recovery reference cannot be secret-shaped");
  });

  test("admits hostile records and arrays without invoking caller code", () => {
    let reads = 0;
    const raw = change("change-a", firstSha, [revision(firstSha, 1)]) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(raw, "providerChangeId", {
      enumerable: true,
      get() {
        reads += 1;
        return "pull:attacker";
      },
    });
    expect(() => compile([raw])).toThrow("enumerable data properties");
    expect(reads).toBe(0);

    const decorated = [change("change-a", firstSha, [revision(firstSha, 1)])] as unknown as Record<PropertyKey, unknown>;
    decorated.extra = true;
    expect(() => compile(decorated as unknown as unknown[])).toThrow("unknown field");

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => compile(sparse)).toThrow("dense");
  });

  test("canonicalizes order and deeply freezes every projection layer", () => {
    const first = change("a", firstSha, [revision(firstSha, 1)], {
      providerChangeId: "pull:a",
    });
    const second = change("b", secondSha, [revision(secondSha, 1)], {
      providerChangeId: "pull:b",
    });
    const left = compile([second, first]);
    const right = compile([first, second]);

    expect(left.projectionFingerprint).toBe(right.projectionFingerprint);
    expect(left.changes.map((entry) => entry.changeId)).toEqual(["a", "b"]);
    expect(Object.isFrozen(left.changes)).toBe(true);
    expect(Object.isFrozen(left.changes[0]!.revisions)).toBe(true);
    expect(Object.isFrozen(left.evaluations[0]!.reasons)).toBe(true);
    expect(() => left.changes.push(left.changes[0]!)).toThrow();
  });
});
