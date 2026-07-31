import { describe, expect, test } from "bun:test";
import {
  compileWorkStackProjection,
  WORK_STACK_LIMITS,
  type WorkStackProjectionInput,
  type WorkStackRecordInput,
} from "../src/work-stack-projection.ts";
import {
  assertCanonicalJsonByteBudget,
  canonicalJsonUtf8Length,
  compareCodeUnits,
} from "../src/work-stack-projection-validation.ts";

const observedAt = "2026-08-01T00:00:00.000Z";
const createdAt = "2026-07-01T00:00:00.000Z";

function record(
  sequence: number,
  overrides: Partial<WorkStackRecordInput> = {},
): WorkStackRecordInput {
  return {
    id: `item-${sequence}`,
    project: "scrapbook",
    kind: "task",
    title: `Item ${sequence}`,
    state: "ready",
    priority: sequence % 101,
    summary: `Summary ${sequence}`,
    nextAction: `Read item ${sequence}`,
    owner: null,
    createdAt,
    updatedAt: new Date(Date.parse(createdAt) + sequence * 1_000).toISOString(),
    actionableAt: null,
    latestEvidenceAt: null,
    attentionReason: null,
    reviewState: "none",
    blockedFanOut: 0,
    links: [{
      kind: "github_issue",
      identity: `issue:${sequence}`,
      href: `https://github.com/acme/repository/issues/${sequence}`,
      label: `Issue ${sequence}`,
    }],
    ...overrides,
  };
}

function input(
  records: WorkStackRecordInput[],
  overrides: Partial<WorkStackProjectionInput> = {},
): WorkStackProjectionInput {
  return {
    version: 1,
    project: "scrapbook",
    observedAt,
    selectedId: null,
    limits: { hot: 20, review: 50, warm: 50, index: 500 },
    records,
    ...overrides,
  };
}

describe("work-stack projection", () => {
  test("keeps active work hot while completed review drains oldest-actionable first", () => {
    const projection = compileWorkStackProjection(input([
      record(0, {
        id: "active-unknown",
        state: "active",
        owner: "Moss",
        latestEvidenceAt: null,
      }),
      record(1, {
        id: "active-new",
        state: "active",
        owner: "Jinx",
        latestEvidenceAt: "2026-07-31T23:55:00.000Z",
      }),
      record(2, {
        id: "decision-new",
        state: "blocked",
        attentionReason: "human_decision",
        actionableAt: "2026-07-22T00:00:00.000Z",
        latestEvidenceAt: "2026-07-22T00:00:00.000Z",
      }),
      record(3, {
        id: "decision-old",
        state: "blocked",
        attentionReason: "human_decision",
        actionableAt: "2026-07-20T00:00:00.000Z",
        latestEvidenceAt: "2026-07-20T00:00:00.000Z",
      }),
      record(4, {
        id: "review-new",
        state: "done",
        reviewState: "actionable",
        actionableAt: "2026-07-15T00:00:00.000Z",
      }),
      record(5, {
        id: "review-old",
        state: "done",
        reviewState: "actionable",
        actionableAt: "2026-07-10T00:00:00.000Z",
      }),
    ]));

    expect(projection.hot.map((entry) => entry.id)).toEqual([
      "decision-old",
      "decision-new",
      "active-unknown",
      "active-new",
    ]);
    expect(projection.reviewQueue.map((entry) => entry.id)).toEqual([
      "review-old",
      "review-new",
    ]);
    expect(projection.policy.reviewOrdering).toBe("oldest_actionable_first");
    expect(projection.policy.pagination).toBe("adapter_owned");
    expect(projection).not.toHaveProperty("continuation");
    expect(projection.authorizesOperation).toBe(false);
    expect(projection.authorizesMutation).toBe(false);
  });

  test("returns fifty summaries and five hundred metadata rows without preloading detail", () => {
    const records = Array.from({ length: 604 }, (_, index) => record(index + 1));
    const projection = compileWorkStackProjection(input(records, { selectedId: "item-600" }));

    expect(projection.counts.available).toBe(604);
    expect(projection.warmSummaries).toHaveLength(50);
    expect(projection.coldIndex).toHaveLength(500);
    expect(projection.truncation.warm).toBe(true);
    expect(projection.truncation.index).toBe(true);
    expect(projection.policy.maxOutputBytes).toBe(WORK_STACK_LIMITS.maxProjectionBytes);
    expect(projection.focusedDetail).toMatchObject({
      id: "item-600",
      summary: "Summary 600",
      nextAction: "Read item 600",
    });
    expect(projection.coldIndex[0]).not.toHaveProperty("summary");
    expect(projection.coldIndex[0]).not.toHaveProperty("nextAction");
    expect(projection.coldIndex[0]).not.toHaveProperty("links");
    expect(projection.coldIndex[0]).toMatchObject({ linkCount: 1, hasSourceLink: true });
  });

  test("explains why every warm summary was selected and preserves direct links", () => {
    const projection = compileWorkStackProjection(input([
      record(1, {
        id: "attention",
        state: "blocked",
        attentionReason: "ambiguous_outcome",
        actionableAt: "2026-07-20T00:00:00.000Z",
      }),
      record(2, {
        id: "review",
        state: "done",
        reviewState: "actionable",
        actionableAt: "2026-07-21T00:00:00.000Z",
      }),
      record(3, { id: "blocked", state: "blocked" }),
      record(4, { id: "ready", state: "ready", priority: 99 }),
      record(5, { id: "finding", kind: "finding", state: "done" }),
    ]));

    expect(projection.warmSummaries.map((entry) => [entry.id, entry.inclusionReason])).toEqual([
      ["attention", "hot_context"],
      ["review", "review_context"],
      ["blocked", "blocked_context"],
      ["ready", "priority_ready"],
      ["finding", "knowledge_context"],
    ]);
    expect(projection.hot[0]?.links[0]).toEqual({
      kind: "github_issue",
      identity: "issue:1",
      href: "https://github.com/acme/repository/issues/1",
      label: "Issue 1",
    });
  });

  test("canonicalizes record and link input order", () => {
    const links = [
      { kind: "receipt" as const, identity: "receipt:1", href: "/receipts/1", label: "Receipt" },
      { kind: "github_issue" as const, identity: "issue:1", href: "https://github.com/acme/repository/issues/1", label: "Issue 1" },
    ];
    const first = compileWorkStackProjection(input([
      record(1, { links }),
      record(2),
    ], { selectedId: "item-2" }));
    const second = compileWorkStackProjection(input([
      record(2),
      record(1, { links: [...links].reverse() }),
    ], { selectedId: "item-2" }));

    expect(second).toEqual(first);
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
    expect(first.snapshotFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.focusedDetail?.links)).toBe(true);
  });

  test("rejects missing attention time, hostile inputs, ambiguous links, and secret shapes", () => {
    expect(() => compileWorkStackProjection(input([
      record(1, { attentionReason: "human_decision", actionableAt: null }),
    ]))).toThrow("Attention records require actionableAt");

    let getterCalls = 0;
    const hostile = record(1);
    Object.defineProperty(hostile, "title", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "Hostile";
      },
    });
    expect(() => compileWorkStackProjection(input([hostile])))
      .toThrow("work-stack record fields must be enumerable data properties");
    expect(getterCalls).toBe(0);

    const decorated = [record(1)] as WorkStackRecordInput[] & { note?: string };
    decorated.note = "decoration";
    expect(() => compileWorkStackProjection(input(decorated)))
      .toThrow("records must contain only dense array entries");

    expect(() => compileWorkStackProjection(input([
      record(1, { links: [
        { kind: "item", identity: "shared:1", href: "/items/1", label: "Item" },
        { kind: "receipt", identity: "shared:1", href: "/receipts/1", label: "Receipt" },
      ] }),
    ]))).toThrow("record link identity must be unique");

    expect(() => compileWorkStackProjection(input([
      record(1, { links: [{ kind: "item", identity: "item:1", href: "//evil.example/path", label: "Bad link" }] }),
    ]))).toThrow("Link href must be credential-free HTTPS or a root-relative path");
    expect(() => compileWorkStackProjection(input([
      record(1, { links: [{ kind: "item", identity: "item:1", href: "https://user:pass@example.com/path", label: "Bad link" }] }),
    ]))).toThrow("Link href must be credential-free HTTPS or a root-relative path");

    const longSecret = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
    expect(() => compileWorkStackProjection(input([
      record(1, { id: longSecret }),
    ]))).toThrow("record id contains credential-shaped text");
    expect(() => compileWorkStackProjection(input([
      record(1, { summary: `namespace:${longSecret}` }),
    ]))).toThrow("record summary contains credential-shaped text");
    expect(() => compileWorkStackProjection(input([
      record(1, { id: "item-sk-research" }),
    ]))).not.toThrow();
  });

  test("uses code-unit ordering and enforces an exact canonical byte ceiling", () => {
    expect(compareCodeUnits("z", "ä")).toBeLessThan(0);
    expect(compareCodeUnits("same", "same")).toBe(0);

    const exact = { text: "context" };
    const exactBytes = canonicalJsonUtf8Length(exact);
    expect(() => assertCanonicalJsonByteBudget(exact, exactBytes, "fixture")).not.toThrow();
    expect(() => assertCanonicalJsonByteBudget(exact, exactBytes - 1, "fixture"))
      .toThrow(`fixture exceeds the ${exactBytes - 1}-byte output limit`);

    const longHrefSuffix = "x".repeat(1_850);
    const oversized = Array.from({ length: 50 }, (_, index) => record(index + 1, {
      state: "blocked",
      attentionReason: "human_decision",
      reviewState: "actionable",
      actionableAt: new Date(Date.parse(createdAt) + (index + 1) * 1_000).toISOString(),
      links: Array.from({ length: 12 }, (_, linkIndex) => ({
        kind: "artifact" as const,
        identity: `artifact:${index}:${linkIndex}`,
        href: `https://example.com/${index}/${linkIndex}/${longHrefSuffix}`,
        label: `Artifact ${index} ${linkIndex}`,
      })),
    }));
    expect(() => compileWorkStackProjection(input(oversized)))
      .toThrow(`work-stack projection exceeds the ${WORK_STACK_LIMITS.maxProjectionBytes}-byte output limit`);
  });
});
