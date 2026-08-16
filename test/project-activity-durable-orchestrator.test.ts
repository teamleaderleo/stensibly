import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.js";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
} from "../src/orchestrator-activity-observation.js";
import {
  admitDurableProjectActivityOrchestratorV1,
} from "../src/project-activity-durable-orchestrator.js";
import { compileProjectActivityV1 } from "../src/project-activity.js";

function observation(overrides: Record<string, unknown> = {}): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "agent_keel",
    sourceClass: "ledger_event",
    sourceId: "evt_activity_1",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-08-16T09:00:00.000Z",
    activityClass: "progress_evidence",
    activityState: "observed",
    workItemId: "issue:1586",
    relatedEvidenceIds: ["evt_activity_1"],
    ...overrides,
  });
}

function envelope(
  observations: readonly OrchestratorActivityObservation[],
  truncated = false,
) {
  return {
    observations: observations.map((entry, index) => ({
      appendOrder: index + 1,
      observationJson: stableJson(entry),
    })),
    truncated,
  };
}

function requiredRow<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected row ${index}`);
  return row;
}

describe("durable project activity orchestrator adapter", () => {
  test("admits durable rows and feeds the existing project activity compiler", () => {
    const first = observation();
    const second = observation({
      sourceId: "evt_activity_2",
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      observedAt: "2026-08-16T09:05:00.000Z",
      activityClass: "handoff",
      workItemId: "issue:1586",
      relatedEvidenceIds: ["evt_activity_2"],
    });
    const admitted = admitDurableProjectActivityOrchestratorV1(
      envelope([first, second]),
    );
    expect(admitted.orchestratorTruncated).toBe(false);
    expect(admitted.orchestrator).toEqual([first, second]);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.orchestrator)).toBe(true);

    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf: "2026-08-16T09:10:00.000Z",
      correspondence: [],
      orchestrator: admitted.orchestrator,
      correspondenceTruncated: false,
      orchestratorTruncated: admitted.orchestratorTruncated,
    });
    expect(projection.completeness).toEqual({
      correspondenceTruncated: false,
      orchestratorTruncated: false,
      omittedEntryCount: 0,
    });
    expect(projection.entries.map((entry) => ({
      sourceClass: entry.sourceClass,
      sourceId: entry.sourceId,
      activityClass: entry.activityClass,
      activityState: entry.activityState,
    }))).toEqual([
      {
        sourceClass: "orchestrator_activity",
        sourceId: second.observationId,
        activityClass: "handoff",
        activityState: "observed",
      },
      {
        sourceClass: "orchestrator_activity",
        sourceId: first.observationId,
        activityClass: "progress_evidence",
        activityState: "observed",
      },
    ]);
  });

  test("preserves durable truncation as project activity completeness evidence", () => {
    const admitted = admitDurableProjectActivityOrchestratorV1(
      envelope([observation()], true),
    );
    expect(admitted.orchestratorTruncated).toBe(true);
    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf: "2026-08-16T09:10:00.000Z",
      correspondence: [],
      orchestrator: admitted.orchestrator,
      correspondenceTruncated: false,
      orchestratorTruncated: admitted.orchestratorTruncated,
    });
    expect(projection.completeness.orchestratorTruncated).toBe(true);
  });

  test("requires strictly increasing durable append order without requiring contiguity", () => {
    const first = observation();
    const second = observation({
      sourceId: "evt_activity_2",
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      observedAt: "2026-08-16T09:05:00.000Z",
      relatedEvidenceIds: ["evt_activity_2"],
    });
    const valid = envelope([first, second]);
    requiredRow(valid.observations, 0).appendOrder = 4;
    requiredRow(valid.observations, 1).appendOrder = 9;
    expect(admitDurableProjectActivityOrchestratorV1(valid).orchestrator).toHaveLength(2);

    const reversed = envelope([first, second]);
    requiredRow(reversed.observations, 0).appendOrder = 9;
    requiredRow(reversed.observations, 1).appendOrder = 4;
    expect(() => admitDurableProjectActivityOrchestratorV1(reversed))
      .toThrow("append order must be strictly increasing");

    const duplicate = envelope([first, second]);
    requiredRow(duplicate.observations, 0).appendOrder = 4;
    requiredRow(duplicate.observations, 1).appendOrder = 4;
    expect(() => admitDurableProjectActivityOrchestratorV1(duplicate))
      .toThrow("append order must be strictly increasing");
  });

  test("rejects malformed, noncanonical, and tampered observation bytes", () => {
    const canonical = observation();
    const malformed = envelope([canonical]);
    requiredRow(malformed.observations, 0).observationJson = "{";
    expect(() => admitDurableProjectActivityOrchestratorV1(malformed))
      .toThrow("observation JSON is invalid");

    const noncanonical = envelope([canonical]);
    requiredRow(noncanonical.observations, 0).observationJson = JSON.stringify(
      JSON.parse(stableJson(canonical)),
      null,
      2,
    );
    expect(() => admitDurableProjectActivityOrchestratorV1(noncanonical))
      .toThrow("observation JSON is not canonical");

    const tamperedRecord = JSON.parse(stableJson(canonical));
    tamperedRecord.activityState = "failed";
    const tampered = envelope([canonical]);
    requiredRow(tampered.observations, 0).observationJson = stableJson(tamperedRecord);
    expect(() => admitDurableProjectActivityOrchestratorV1(tampered))
      .toThrow(/canonical observation is inconsistent|observation JSON/);
  });

  test("rejects project-scope drift when the admitted rows enter project activity", () => {
    const foreign = observation({ project: "elsewhere" });
    const admitted = admitDurableProjectActivityOrchestratorV1(envelope([foreign]));
    expect(() => compileProjectActivityV1({
      project: "stensibly",
      asOf: "2026-08-16T09:10:00.000Z",
      correspondence: [],
      orchestrator: admitted.orchestrator,
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    })).toThrow("Project activity observation escaped project scope");
  });

  test("prelimits the observation array without caller key enumeration", () => {
    let ownKeysCalls = 0;
    const oversized = new Proxy(new Array(257), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must stay untouched");
      },
    });
    expect(() => admitDurableProjectActivityOrchestratorV1({
      observations: oversized,
      truncated: true,
    })).toThrow("exceeded its bound");
    expect(ownKeysCalls).toBe(0);
  });

  test("reads only fixed envelope and row data properties", () => {
    let envelopeDecorationReads = 0;
    let rowDecorationReads = 0;
    const canonical = observation();
    const row = {
      appendOrder: 1,
      observationJson: stableJson(canonical),
      get decoration() {
        rowDecorationReads += 1;
        throw new Error("row decoration must stay untouched");
      },
    };
    const input = {
      observations: [row],
      truncated: false,
      get decoration() {
        envelopeDecorationReads += 1;
        throw new Error("envelope decoration must stay untouched");
      },
    };
    expect(admitDurableProjectActivityOrchestratorV1(input).orchestrator).toEqual([
      canonical,
    ]);
    expect(envelopeDecorationReads).toBe(0);
    expect(rowDecorationReads).toBe(0);
  });

  test("rejects accessor-backed required fields without executing them", () => {
    let getterCalls = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "observations", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    Object.defineProperty(input, "truncated", {
      enumerable: true,
      value: false,
    });
    expect(() => admitDurableProjectActivityOrchestratorV1(input))
      .toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);
  });
});
