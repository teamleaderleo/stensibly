import { describe, expect, test } from "bun:test";
import {
  PR_STACK_AUTOPILOT_VERSION,
  compilePrStackProjection,
  type PrStackCandidate,
} from "../src/pr-stack-autopilot.ts";

const mainSha = "a".repeat(40);
const firstHead = "b".repeat(40);
const secondHead = "c".repeat(40);
const thirdHead = "d".repeat(40);
const sharedBlob = "f".repeat(40);
const mergedCommit = "9".repeat(40);
const observedAt = "2026-07-31T00:30:00.000Z";

function candidate(
  number: number,
  overrides: Partial<PrStackCandidate> = {},
): PrStackCandidate {
  const headSha = number === 10
    ? firstHead
    : number === 11
    ? secondHead
    : thirdHead;
  return {
    number,
    url: `https://github.com/teamleaderleo/stensibly/pull/${number}`,
    lifecycle: "open",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    supersededBy: null,
    baseRef: "main",
    baseSha: mainSha,
    mergeBaseSha: mainSha,
    aheadBy: 1,
    behindBy: 0,
    headRef: `agent/pr-${number}`,
    headSha,
    draft: false,
    mergeability: "mergeable",
    dependencies: [],
    changedPaths: [`src/pr-${number}.ts`],
    addedBlobShas: [],
    outcomeClaim: `issue:${number}`,
    requiredChecks: ["runtime-parity", "test"],
    checks: [
      { name: "test", headSha, conclusion: "success" },
      { name: "runtime-parity", headSha, conclusion: "success" },
    ],
    reviewedHeadSha: headSha,
    reviewDisposition: "approved",
    unresolvedThreads: 0,
    ...overrides,
  };
}

function projection(
  candidates: PrStackCandidate[],
  overrides: Record<string, unknown> = {},
) {
  return compilePrStackProjection({
    repository: "TeamLeaderLeo/Stensibly",
    mainSha: mainSha.toUpperCase(),
    observedAt,
    candidates,
    ...overrides,
  });
}

function evaluation(
  result: ReturnType<typeof projection>,
  number: number,
) {
  const value = result.evaluations.find((entry) => entry.number === number);
  if (!value) throw new Error(`Missing evaluation for PR ${number}`);
  return value;
}

function mergedCandidate(number: number): PrStackCandidate {
  return candidate(number, {
    lifecycle: "merged",
    closedAt: "2026-07-31T00:20:00.000Z",
    mergedAt: "2026-07-31T00:19:59.000Z",
    mergeCommitSha: mergedCommit,
  });
}

function closedCandidate(number: number): PrStackCandidate {
  return candidate(number, {
    lifecycle: "closed",
    closedAt: "2026-07-31T00:20:00.000Z",
  });
}

describe("PR stack autopilot lifecycle compiler", () => {
  test("represents an empty queue with strict versioned identity", () => {
    const result = projection([]);

    expect(result.version).toBe(PR_STACK_AUTOPILOT_VERSION);
    expect(result.version).toBe(2);
    expect(result.repository).toBe("teamleaderleo/stensibly");
    expect(result.mainSha).toBe(mainSha);
    expect(result.observedAt).toBe(observedAt);
    expect(result.candidates).toEqual([]);
    expect(result.evaluations).toEqual([]);
    expect(result.projectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);

    for (const invalid of [
      "2026-07-31",
      "2026-07-31T08:30:00+08:00",
      "2026-02-31T00:30:00Z",
    ]) {
      expect(() => projection([], { observedAt: invalid })).toThrow("timestamp");
    }
  });

  test("identifies one open exact reviewed green candidate as advisory-ready", () => {
    const result = projection([candidate(10, {
      url: "https://github.com/TeamLeaderLeo/Stensibly/pull/10",
    })]);
    const current = evaluation(result, 10);

    expect(current).toMatchObject({
      state: "ready_to_integrate",
      recommendation: "merge",
      reasons: ["ready"],
      authorizesMutation: false,
    });
    expect(result.candidates[0]!.url).toBe(
      "https://github.com/teamleaderleo/stensibly/pull/10",
    );
    expect(Object.isFrozen(result.candidates[0])).toBe(true);
    expect(Object.isFrozen(current)).toBe(true);
  });

  test("a superseded prototype cannot block its successor", () => {
    const predecessor = closedCandidate(10);
    predecessor.supersededBy = 11;
    predecessor.changedPaths = ["site/labs/prototype/app.js"];
    predecessor.addedBlobShas = [sharedBlob];
    predecessor.outcomeClaim = "issue:608";

    const successor = candidate(11, {
      changedPaths: ["site/labs/prototype/app.js"],
      addedBlobShas: [sharedBlob],
      outcomeClaim: "issue:608",
    });
    const result = projection([predecessor, successor]);

    expect(evaluation(result, 10)).toMatchObject({
      state: "superseded_candidate",
      recommendation: "archive",
      reasons: ["candidate_superseded"],
      authorizesMutation: false,
    });
    expect(evaluation(result, 11)).toMatchObject({
      state: "ready_to_integrate",
      recommendation: "merge",
      reasons: ["ready"],
    });
    expect(evaluation(result, 11).overlaps).toHaveLength(1);
  });

  test("a merged dependency leaves the open successor ready for restack", () => {
    const dependency = mergedCandidate(10);
    dependency.changedPaths = ["src/shared.ts"];
    dependency.addedBlobShas = [sharedBlob];
    dependency.outcomeClaim = "issue:641";

    const stacked = candidate(11, {
      baseRef: dependency.headRef,
      baseSha: dependency.headSha,
      mergeBaseSha: dependency.headSha,
      dependencies: [dependency.number],
      changedPaths: ["src/shared.ts"],
      addedBlobShas: [sharedBlob],
      outcomeClaim: "issue:641",
    });
    const result = projection([dependency, stacked]);

    expect(evaluation(result, 10)).toMatchObject({
      state: "inactive_merged",
      recommendation: "archive",
      reasons: ["candidate_merged"],
    });
    expect(evaluation(result, 11)).toMatchObject({
      state: "stale_base",
      recommendation: "restack",
      reasons: ["dependency_merged"],
    });
    expect(evaluation(result, 11).reasons).not.toContain("dependency_open");
  });

  test("admits terminal zero-ahead ancestry and rejects active zero-ahead candidates", () => {
    const terminal = mergedCandidate(10);
    terminal.mergeBaseSha = terminal.headSha;
    terminal.aheadBy = 0;
    terminal.behindBy = 1;

    const result = projection([terminal]);
    expect(result.candidates[0]).toMatchObject({
      lifecycle: "merged",
      mergeBaseSha: firstHead,
      aheadBy: 0,
      behindBy: 1,
    });
    expect(evaluation(result, 10)).toMatchObject({
      state: "inactive_merged",
      recommendation: "archive",
      reasons: ["candidate_merged"],
      authorizesMutation: false,
    });

    expect(() => projection([candidate(10, {
      mergeBaseSha: firstHead,
      aheadBy: 0,
      behindBy: 1,
    })])).toThrow("Active pull request head must advance beyond its merge base");
  });

  test("a closed reviewed candidate cannot receive merge advice", () => {
    const result = projection([closedCandidate(10)]);

    expect(evaluation(result, 10)).toMatchObject({
      state: "inactive_closed",
      recommendation: "archive",
      reasons: ["candidate_closed"],
      authorizesMutation: false,
    });
  });

  test("unknown mergeability requests provider observation refresh", () => {
    const result = projection([candidate(10, {
      draft: true,
      mergeability: "unknown",
    })]);

    expect(evaluation(result, 10)).toMatchObject({
      state: "observation_refresh_required",
      recommendation: "refresh_observation",
      reasons: ["draft", "mergeability_unknown"],
      authorizesMutation: false,
    });
  });

  test("keeps an active stacked dependency open and suppresses its overlap", () => {
    const dependency = candidate(10, {
      changedPaths: ["src/shared.ts"],
      addedBlobShas: [sharedBlob],
      outcomeClaim: "issue:675",
    });
    const stacked = candidate(11, {
      baseRef: dependency.headRef,
      baseSha: dependency.headSha,
      mergeBaseSha: dependency.headSha,
      dependencies: [dependency.number],
      changedPaths: ["src/shared.ts"],
      addedBlobShas: [sharedBlob],
      outcomeClaim: "issue:675",
    });
    const result = projection([stacked, dependency]);

    expect(evaluation(result, 10).state).toBe("ready_to_integrate");
    expect(evaluation(result, 11)).toMatchObject({
      state: "waiting_for_dependency",
      recommendation: "integrate_dependency_first",
      reasons: ["dependency_open"],
      overlaps: [{
        otherNumber: 10,
        sharedPathCount: 1,
        sharedAddedBlobCount: 1,
        sameOutcomeClaim: true,
      }],
    });
  });

  test("retains independent active overlap and bounds evidence", () => {
    const paths = Array.from(
      { length: 25 },
      (_, index) => `src/shared-${String(index).padStart(2, "0")}.ts`,
    );
    const blobs = Array.from(
      { length: 25 },
      (_, index) => (index + 1).toString(16).padStart(40, "0"),
    );
    const result = projection([
      candidate(10, {
        changedPaths: paths,
        addedBlobShas: blobs,
        outcomeClaim: "issue:675",
      }),
      candidate(11, {
        changedPaths: [...paths].reverse(),
        addedBlobShas: [...blobs].reverse(),
        outcomeClaim: "issue:675",
      }),
    ]);
    const current = evaluation(result, 10);

    expect(current).toMatchObject({
      state: "overlapping_candidate",
      recommendation: "partition",
      reasons: [
        "overlapping_paths",
        "overlapping_added_blob",
        "overlapping_outcome",
      ],
    });
    expect(current.overlaps[0]!.sharedPathCount).toBe(25);
    expect(current.overlaps[0]!.sharedPaths).toEqual(paths.slice(0, 20));
    expect(current.overlaps[0]!.sharedAddedBlobCount).toBe(25);
    expect(current.overlaps[0]!.sharedAddedBlobShas).toEqual(blobs.slice(0, 20));
  });

  test("invalidates review and checks independently against the exact head", () => {
    const changedHead = "e".repeat(40);
    const result = projection([
      candidate(10, {
        headSha: changedHead,
        checks: [
          { name: "runtime-parity", headSha: changedHead, conclusion: "success" },
          { name: "test", headSha: changedHead, conclusion: "success" },
        ],
      }),
      candidate(11, {
        checks: [
          { name: "runtime-parity", headSha: secondHead, conclusion: "success" },
          { name: "test", headSha: firstHead, conclusion: "success" },
        ],
      }),
    ]);

    expect(evaluation(result, 10)).toMatchObject({
      state: "head_changed_after_review",
      recommendation: "review",
      reasons: ["review_stale"],
    });
    expect(evaluation(result, 11)).toMatchObject({
      state: "waiting_for_checks",
      recommendation: "continue",
      reasons: ["required_check_stale"],
    });
  });

  test("separates missing, pending, failed, and unresolved review gates", () => {
    const result = projection([
      candidate(10, {
        checks: [{ name: "test", headSha: firstHead, conclusion: "success" }],
      }),
      candidate(11, {
        checks: [
          { name: "runtime-parity", headSha: secondHead, conclusion: "success" },
          { name: "test", headSha: secondHead, conclusion: "pending" },
        ],
      }),
      candidate(12, {
        checks: [
          { name: "runtime-parity", headSha: thirdHead, conclusion: "success" },
          { name: "test", headSha: thirdHead, conclusion: "failure" },
        ],
      }),
      candidate(13, {
        number: 13,
        url: "https://github.com/teamleaderleo/stensibly/pull/13",
        headRef: "agent/pr-13",
        headSha: "1".repeat(40),
        reviewedHeadSha: "1".repeat(40),
        checks: [
          { name: "runtime-parity", headSha: "1".repeat(40), conclusion: "success" },
          { name: "test", headSha: "1".repeat(40), conclusion: "success" },
        ],
        unresolvedThreads: 2,
      }),
    ]);

    expect(evaluation(result, 10).reasons).toEqual(["required_check_missing"]);
    expect(evaluation(result, 11).reasons).toEqual(["required_check_pending"]);
    expect(evaluation(result, 12)).toMatchObject({
      state: "recovery_required",
      recommendation: "repair",
      reasons: ["required_check_failed"],
    });
    expect(evaluation(result, 13)).toMatchObject({
      state: "waiting_for_review",
      recommendation: "review",
      reasons: ["review_threads_unresolved"],
    });
  });

  test("admits historical terminal bases without presenting them as current", () => {
    const historicalBase = "1".repeat(40);
    const historicalMergeBase = "2".repeat(40);
    const historical = closedCandidate(10);
    historical.baseSha = historicalBase;
    historical.mergeBaseSha = historicalMergeBase;
    historical.behindBy = 5;

    const result = projection([historical]);
    expect(result.candidates[0]!.baseSha).toBe(historicalBase);
    expect(evaluation(result, 10).state).toBe("inactive_closed");
  });

  test("preserves inactive stacked history while enforcing active dependency heads", () => {
    const dependency = candidate(10);
    const historicalBase = "1".repeat(40);
    const historical = closedCandidate(11);
    historical.baseRef = dependency.headRef;
    historical.baseSha = historicalBase;
    historical.mergeBaseSha = historicalBase;
    historical.dependencies = [dependency.number];

    const result = projection([dependency, historical]);
    expect(result.candidates.find((entry) => entry.number === 11)?.baseSha).toBe(
      historicalBase,
    );
    expect(evaluation(result, 11)).toMatchObject({
      state: "inactive_closed",
      recommendation: "archive",
      reasons: ["candidate_closed"],
      authorizesMutation: false,
    });

    expect(() => projection([
      dependency,
      candidate(11, {
        baseRef: dependency.headRef,
        baseSha: historicalBase,
        mergeBaseSha: historicalBase,
        dependencies: [dependency.number],
      }),
    ])).toThrow("stacked base SHA does not match dependency 10");
  });

  test("rejects inconsistent lifecycle identities and future terminal facts", () => {
    expect(() => projection([candidate(10, {
      lifecycle: "open",
      closedAt: "2026-07-31T00:20:00.000Z",
    })])).toThrow("Open pull request");
    expect(() => projection([candidate(10, {
      lifecycle: "closed",
      closedAt: null,
    })])).toThrow("Closed pull request");
    expect(() => projection([candidate(10, {
      lifecycle: "merged",
      closedAt: "2026-07-31T00:20:00.000Z",
      mergedAt: null,
      mergeCommitSha: null,
    })])).toThrow("Merged pull request");
    expect(() => projection([candidate(10, {
      lifecycle: "merged",
      closedAt: "2026-07-31T00:20:00.000Z",
      mergedAt: "2026-07-31T00:21:00.000Z",
      mergeCommitSha: mergedCommit,
    })])).toThrow("merge time cannot follow");
    expect(() => projection([candidate(10, {
      lifecycle: "closed",
      closedAt: "2026-07-31T00:31:00.000Z",
    })])).toThrow("follows the stack observation");
  });

  test("rejects missing superseders and supersession cycles", () => {
    expect(() => projection([candidate(10, { supersededBy: 99 })]))
      .toThrow("missing superseder 99");
    expect(() => projection([
      candidate(10, { supersededBy: 11 }),
      candidate(11, { supersededBy: 10 }),
    ])).toThrow("supersession cycle");
  });

  test("rejects missing dependencies, mismatched stacked bases, and cycles", () => {
    expect(() => projection([candidate(10, { dependencies: [99] })]))
      .toThrow("depends on missing pull request 99");
    expect(() => projection([
      candidate(10),
      candidate(11, {
        baseRef: "agent/unrelated",
        dependencies: [10],
      }),
    ])).toThrow("base ref must match main or an explicit dependency head");

    const left = candidate(10, {
      baseRef: "agent/pr-11",
      baseSha: secondHead,
      mergeBaseSha: secondHead,
      dependencies: [11],
    });
    const right = candidate(11, {
      baseRef: "agent/pr-10",
      baseSha: firstHead,
      mergeBaseSha: firstHead,
      dependencies: [10],
    });
    expect(() => projection([left, right])).toThrow("dependency cycle");
  });

  test("rejects accessor, symbol, hidden, sparse, and custom-array input", () => {
    const raw = candidate(10) as unknown as Record<PropertyKey, unknown>;
    let reads = 0;
    Object.defineProperty(raw, "lifecycle", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return "open";
      },
    });
    expect(() => projection([raw as unknown as PrStackCandidate])).toThrow();
    expect(reads).toBe(0);

    const symbolCandidate = candidate(10) as unknown as Record<PropertyKey, unknown>;
    symbolCandidate[Symbol("decoration")] = true;
    expect(() => projection([symbolCandidate as unknown as PrStackCandidate])).toThrow();

    const hiddenCandidate = candidate(10) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hiddenCandidate, "hidden", {
      enumerable: false,
      value: true,
    });
    expect(() => projection([hiddenCandidate as unknown as PrStackCandidate])).toThrow();

    const sparse: PrStackCandidate[] = [];
    sparse.length = 1;
    expect(() => projection(sparse)).toThrow("dense");

    const customArray = [candidate(10)];
    Object.setPrototypeOf(customArray, Object.create(Array.prototype));
    expect(() => projection(customArray)).toThrow("between 0 and 100 entries");
  });

  test("fingerprints canonical order and deeply freezes output", () => {
    const first = projection([candidate(11), candidate(10)]);
    const second = projection([candidate(10), candidate(11)]);

    expect(first.projectionFingerprint).toBe(second.projectionFingerprint);
    expect(first.candidates.map((entry) => entry.number)).toEqual([10, 11]);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    expect(Object.isFrozen(first.candidates[0]!.checks)).toBe(true);
    expect(Object.isFrozen(first.evaluations[0]!.reasons)).toBe(true);
    expect(() => first.candidates.push(candidate(12))).toThrow();
  });
});
