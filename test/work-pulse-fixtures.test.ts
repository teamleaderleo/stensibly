import { describe, expect, test } from "bun:test";
import { parseWorkPulseFixture, parseWorkPulseFixtureTasks, workPulseFixture, workPulseFixtureTasks } from "../site/labs/work-pulse-fixtures.js";

function cloneFixture(): any { return JSON.parse(JSON.stringify(workPulseFixture)); }
function cloneTasks(): any { return JSON.parse(JSON.stringify(workPulseFixtureTasks)); }

describe("Work Pulse frontend fixtures", () => {
  test("publishes literal work, relation, attention, polar, and timeline evidence", () => {
    expect(workPulseFixture.attempts).toHaveLength(8);
    expect(workPulseFixture.views.map((view) => view.id)).toEqual(["list", "lanes", "attention", "polar", "timeline"]);
    expect(workPulseFixture.attempts.find((attempt) => attempt.id === "mist-ci-receipt"))
      .toMatchObject({ state: "queued", queuePosition: "unknown", candidate: "97d3499" });
    expect(workPulseFixture.attempts.find((attempt) => attempt.id === "ember-runtime")?.attentionReasons)
      .toEqual(["lease_expired", "heartbeat_missed", "stalled", "stale_receipt"]);
    expect(workPulseFixture.attempts.find((attempt) => attempt.id === "moss-dependency")?.polar)
      .toMatchObject({ blockedFanOut: 3, freshnessRing: "current" });
    expect(workPulseFixture.relations.map((relation) => relation.kind)).toContain("supersedes");
    expect(workPulseFixture.attention[0]).toMatchObject({ reason: "human_decision", attemptId: "violet-review" });
    expect(workPulseFixture.events.some((event) => event.kind === "reconciliation")).toBe(true);
    expect(Object.isFrozen(workPulseFixture)).toBe(true);
    expect(Object.isFrozen(workPulseFixture.attempts[0]?.polar)).toBe(true);
  });

  test("uses callsign as attribution while preserving separate run and authority identity", () => {
    const sable = workPulseFixture.attempts.filter((attempt) => attempt.callsign === "Sable");
    expect(sable).toHaveLength(2);
    expect(new Set(sable.map((attempt) => attempt.runId)).size).toBe(2);
    expect(new Set(sable.map((attempt) => attempt.authorityGeneration)).size).toBe(2);
  });

  test("covers concrete operator tasks without fake progress or thought telemetry", () => {
    expect(workPulseFixtureTasks).toHaveLength(10);
    expect(workPulseFixtureTasks.map((task) => task.id)).toEqual([
      "active-attempts", "external-wait", "human-decision", "fan-out", "stale-receipt", "reconciliation", "supersession", "shared-gate", "receipt-history", "same-callsign",
    ]);
    const serialized = JSON.stringify(workPulseFixture);
    expect(serialized).not.toContain("percentComplete");
    expect(serialized).not.toContain("eta");
    expect(serialized).not.toContain("thought");
    expect(serialized).not.toContain("tokensPerSecond");
  });

  test("rejects unknown attempts, self relations, and mismatched polar identity", () => {
    const unknown = cloneFixture();
    unknown.relations[0].to = "missing-attempt";
    expect(() => parseWorkPulseFixture(unknown)).toThrow("Unknown attempt");
    const self = cloneFixture();
    self.relations[0].to = self.relations[0].from;
    expect(() => parseWorkPulseFixture(self)).toThrow("Self relation");
    const mismatched = cloneFixture();
    mismatched.attempts[0].polar.blockedFanOut = 99;
    expect(() => parseWorkPulseFixture(mismatched)).toThrow("Polar identity must match");
  });

  test("rejects queue claims on nonqueued attempts and malformed revisions", () => {
    const queue = cloneFixture();
    queue.attempts[0].queuePosition = 4;
    expect(() => parseWorkPulseFixture(queue)).toThrow("Only queued or external-wait attempts");
    const revision = cloneFixture();
    revision.attempts[0].candidate = "main";
    expect(() => parseWorkPulseFixture(revision)).toThrow("Candidate is invalid");
  });

  test("rejects unknown fields, accessors, symbols, decorated arrays, and duplicate ids", () => {
    const unknown = cloneFixture();
    unknown.attempts[0].thoughts = "secret";
    expect(() => parseWorkPulseFixture(unknown)).toThrow("unknown field thoughts");

    const accessor = cloneFixture();
    let reads = 0;
    Object.defineProperty(accessor, "attempts", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => parseWorkPulseFixture(accessor)).toThrow();
    expect(reads).toBe(0);

    const symbolic = cloneFixture();
    symbolic[Symbol("presence")] = true;
    expect(() => parseWorkPulseFixture(symbolic)).toThrow("symbol field");

    const decorated = cloneFixture();
    decorated.attempts.progress = 73;
    expect(() => parseWorkPulseFixture(decorated)).toThrow("unknown field progress");

    const sparse = cloneFixture();
    sparse.attempts = [];
    sparse.attempts.length = 1;
    expect(() => parseWorkPulseFixture(sparse)).toThrow("dense");

    const accessorArray = cloneFixture();
    const firstAttempt = accessorArray.attempts[0];
    let entryReads = 0;
    Object.defineProperty(accessorArray.attempts, "0", {
      enumerable: true,
      configurable: true,
      get() {
        entryReads += 1;
        return firstAttempt;
      },
    });
    expect(() => parseWorkPulseFixture(accessorArray)).toThrow("enumerable data property");
    expect(entryReads).toBe(0);

    const symbolicArray = cloneFixture();
    symbolicArray.attempts[Symbol("presence")] = true;
    expect(() => parseWorkPulseFixture(symbolicArray)).toThrow("symbol field");

    const duplicate = cloneFixture();
    duplicate.attempts[1].id = duplicate.attempts[0].id;
    expect(() => parseWorkPulseFixture(duplicate)).toThrow("Duplicate attempt ids");
  });

  test("rejects duplicated relations, late events, and attention drift", () => {
    const duplicateRelation = cloneFixture();
    duplicateRelation.relations.push({
      ...duplicateRelation.relations[0],
      id: "rel-duplicate",
    });
    expect(() => parseWorkPulseFixture(duplicateRelation)).toThrow("Duplicate semantic relations");

    const lateEvent = cloneFixture();
    lateEvent.events[0].at = "2026-07-31T10:31:00.000Z";
    expect(() => parseWorkPulseFixture(lateEvent)).toThrow("follows fixture observation");

    const attentionDrift = cloneFixture();
    attentionDrift.attention[0].reason = "failed";
    expect(() => parseWorkPulseFixture(attentionDrift)).toThrow("absent from attempt");
  });

  test("requires the complete five-view task vocabulary", () => {
    const tasks = cloneTasks();
    tasks[0].start = "radar-only";
    expect(() => parseWorkPulseFixtureTasks(tasks)).toThrow("Task start is unsupported");
    const duplicate = cloneTasks();
    duplicate[1].id = duplicate[0].id;
    expect(() => parseWorkPulseFixtureTasks(duplicate)).toThrow("Duplicate task ids");
  });
});
