import { describe, expect, test } from "bun:test";
import {
  compileProjectDeltaBrief,
  renderProjectDeltaBriefMarkdown,
  type ProjectDeltaAuthorityObservation,
  type ProjectDeltaCategory,
  type ProjectDeltaDecisionObservation,
  type ProjectDeltaObservation,
  type ProjectDeltaProviderEffectObservation,
  type ProjectDeltaSourceObservation,
  type ProjectDeltaWorkObservation,
} from "../src/project-delta-brief.ts";

const project = "alpha";
const categoryNames: ProjectDeltaCategory[] = [
  "completed",
  "failed",
  "newlyBlocked",
  "unblocked",
  "decisionsAdded",
  "decisionsResolved",
  "authorityChanged",
  "superseded",
  "ambiguous",
  "recovered",
  "sourceFreshness",
];

describe("project return-to-work delta brief", () => {
  test("identical checkpoints produce no material delta", () => {
    const observations: ProjectDeltaObservation[] = [
      work(1, "active"),
      decision(2, "open"),
    ];

    const result = compile(observations, 2, 2);

    for (const category of categoryNames) {
      expect(result[category]).toEqual([]);
      expect(result.omittedCounts[category]).toBe(0);
    }
    expect(result.nextAction).toBeNull();
    expect(result.authorizesMutation).toBe(false);
    expect(result.authorizesAuthority).toBe(false);
    expect(renderProjectDeltaBriefMarkdown(result)).toContain(
      "No material changes were accepted between these checkpoints.",
    );
  });

  test("sorts accepted sequence and suppresses repeated semantic observations", () => {
    const observations: ProjectDeltaObservation[] = [
      work(3, "blocked"),
      work(1, "active"),
      work(2, "blocked"),
    ];
    const originalOrder = observations.map((entry) => entry.observationId);

    const result = compile(observations, 1, 3);

    expect(observations.map((entry) => entry.observationId)).toEqual(originalOrder);
    expect(result.newlyBlocked).toHaveLength(1);
    expect(result.newlyBlocked[0]).toMatchObject({
      observationId: "obs:2",
      sequence: 2,
      fromState: "active",
      toState: "blocked",
    });
    expect(result.nextAction).toMatchObject({
      kind: "unblock_work",
      subjectId: "work:primary",
      sourceReferences: ["source:3"],
    });
  });

  test("preserves completion followed by supersession", () => {
    const result = compile([
      work(1, "active"),
      work(2, "completed"),
      work(3, "superseded"),
    ], 1, 3);

    expect(result.completed.map((change) => change.sequence)).toEqual([2]);
    expect(result.superseded.map((change) => change.sequence)).toEqual([3]);
    expect(result.completed[0]?.toState).toBe("completed");
    expect(result.superseded[0]?.fromState).toBe("completed");
  });

  test("preserves a blocker and its later clearing transition", () => {
    const result = compile([
      work(1, "active"),
      work(2, "blocked"),
      work(3, "active"),
    ], 1, 3);

    expect(result.newlyBlocked.map((change) => change.sequence)).toEqual([2]);
    expect(result.unblocked.map((change) => change.sequence)).toEqual([3]);
    expect(result.nextAction).toBeNull();
  });

  test("records authority expiry and exact generation replacement", () => {
    const result = compile([
      authority(1, "live", 1, "actor:old"),
      authority(2, "expired", 1, "actor:old"),
      authority(3, "live", 2, "actor:new"),
    ], 1, 3);

    expect(result.authorityChanged).toHaveLength(2);
    expect(result.authorityChanged[0]).toMatchObject({
      fromState: "live",
      toState: "expired",
      fromGeneration: 1,
      toGeneration: 1,
      fromHolderId: "actor:old",
      toHolderId: "actor:old",
    });
    expect(result.authorityChanged[1]).toMatchObject({
      fromState: "expired",
      toState: "live",
      fromGeneration: 1,
      toGeneration: 2,
      fromHolderId: "actor:old",
      toHolderId: "actor:new",
    });
    expect(result.nextAction).toBeNull();
  });

  test("keeps ambiguous effects and reconciliation as separate changes", () => {
    const result = compile([
      providerEffect(1, "succeeded"),
      providerEffect(2, "pending_reconciliation"),
      providerEffect(3, "reconciled"),
    ], 1, 3);

    expect(result.ambiguous.map((change) => change.sequence)).toEqual([2]);
    expect(result.recovered.map((change) => change.sequence)).toEqual([3]);
    expect(result.nextAction).toBeNull();
  });

  test("reports stale source evidence and later recovery", () => {
    const result = compile([
      source(1, "current"),
      source(2, "stale"),
      source(3, "current"),
    ], 1, 3);

    expect(result.sourceFreshness.map((change) => change.sequence)).toEqual([2, 3]);
    expect(result.recovered.map((change) => change.sequence)).toEqual([3]);
  });

  test("selects unresolved decisions before other advisory actions", () => {
    const result = compile([
      work(1, "blocked", "work:blocked", "Blocked delivery"),
      providerEffect(2, "pending_reconciliation"),
      decision(3, "open", "decision:launch", "Choose launch window"),
    ], 0, 3);

    expect(result.nextAction).toMatchObject({
      kind: "review_decision",
      subjectId: "decision:launch",
      title: "Choose launch window",
    });
  });

  test("bounds categories, preserves caller order, and freezes output", () => {
    const observations: ProjectDeltaObservation[] = [
      work(1, "active", "work:1", "First"),
      work(2, "active", "work:2", "Second"),
      work(3, "active", "work:3", "Third"),
      work(4, "completed", "work:1", "First"),
      work(5, "completed", "work:2", "Second"),
      work(6, "completed", "work:3", "Third"),
    ];
    const callerOrder = observations.map((entry) => entry.observationId);

    const result = compile(observations, 3, 6, 2);
    const reversed = compile([...observations].reverse(), 3, 6, 2);

    expect(result.completed.map((change) => change.sequence)).toEqual([4, 5]);
    expect(result.omittedCounts.completed).toBe(1);
    expect(result.briefFingerprint).toBe(reversed.briefFingerprint);
    expect(observations.map((entry) => entry.observationId)).toEqual(callerOrder);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.completed)).toBe(true);
    expect(Object.isFrozen(result.completed[0])).toBe(true);
    expect(Object.isFrozen(result.omittedCounts)).toBe(true);
  });

  test("renders bounded Markdown with mention and link syntax escaped", () => {
    const result = compile([
      decision(1, "open", "decision:copy", "Review @team [launch]"),
    ], 0, 1);

    const markdown = renderProjectDeltaBriefMarkdown(result);

    expect(markdown).toContain("## Next operator action");
    expect(markdown).toContain("Review \\@team \\[launch\\]");
    expect(markdown).toContain("`source:1`");
    expect(markdown).toContain("grants no mutation or authority");
  });

  test("rejects incomplete sequences, foreign projects, kind drift, and retained credentials", () => {
    expect(() => compile([
      work(1, "active"),
      work(3, "blocked"),
    ], 0, 2)).toThrow("sequences must be complete and unique");

    expect(() => compile([
      { ...work(1, "active"), project: "beta" },
    ], 0, 1)).toThrow("must belong to the requested project");

    expect(() => compile([
      work(1, "active"),
      decision(2, "open", "work:primary"),
    ], 1, 2)).toThrow("subject kind changed");

    expect(() => compile([
      work(1, "active", "work:primary", "stn.svc_123456789012"),
    ], 0, 1)).toThrow("Project delta brief contains credential-shaped text");
  });

  test("rejects accessor-bearing observations without invoking getters", () => {
    let getterCalls = 0;
    const hostile = work(1, "active") as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "title", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hidden";
      },
    });

    expect(() => compile([
      hostile as unknown as ProjectDeltaObservation,
    ], 0, 1)).toThrow("fields must be enumerable data properties");
    expect(getterCalls).toBe(0);
  });
});

function compile(
  observations: ProjectDeltaObservation[],
  fromSequence: number,
  toSequence: number,
  limit = 10,
) {
  return compileProjectDeltaBrief({
    project,
    fromCheckpoint: {
      id: `checkpoint:${fromSequence}`,
      throughSequence: fromSequence,
      observedAt: timestamp(fromSequence),
    },
    toCheckpoint: {
      id: `checkpoint:${toSequence}`,
      throughSequence: toSequence,
      observedAt: timestamp(toSequence),
    },
    observations,
    limit,
  });
}

function common(
  sequence: number,
  subjectId: string,
  title: string,
) {
  return {
    observationId: `obs:${sequence}`,
    sequence,
    project,
    subjectId,
    title,
    summary: null,
    observedAt: timestamp(sequence),
    sourceReferences: [`source:${sequence}`],
  };
}

function work(
  sequence: number,
  state: ProjectDeltaWorkObservation["state"],
  subjectId = "work:primary",
  title = "Primary work",
): ProjectDeltaWorkObservation {
  return {
    ...common(sequence, subjectId, title),
    kind: "work",
    state,
  };
}

function decision(
  sequence: number,
  state: ProjectDeltaDecisionObservation["state"],
  subjectId = "decision:primary",
  title = "Primary decision",
): ProjectDeltaDecisionObservation {
  return {
    ...common(sequence, subjectId, title),
    kind: "decision",
    state,
  };
}

function authority(
  sequence: number,
  state: ProjectDeltaAuthorityObservation["state"],
  generation: number,
  holderId: string | null,
): ProjectDeltaAuthorityObservation {
  return {
    ...common(sequence, "authority:primary", "Primary authority"),
    kind: "authority",
    state,
    generation,
    holderId,
  };
}

function providerEffect(
  sequence: number,
  state: ProjectDeltaProviderEffectObservation["state"],
): ProjectDeltaProviderEffectObservation {
  return {
    ...common(sequence, "effect:primary", "Primary provider effect"),
    kind: "provider_effect",
    state,
  };
}

function source(
  sequence: number,
  state: ProjectDeltaSourceObservation["state"],
): ProjectDeltaSourceObservation {
  return {
    ...common(sequence, "source:primary", "Primary source"),
    kind: "source",
    state,
  };
}

function timestamp(minute: number): string {
  return new Date(Date.UTC(2026, 7, 6, 0, minute, 0)).toISOString();
}
