import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.js";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.js";
import { admitDurableProjectActivityOrchestratorV1 } from "../src/project-activity-durable-orchestrator.js";

describe("durable project activity adapter inspection", () => {
  test("reads the caller array length only through its own descriptor", () => {
    const canonical = compileOrchestratorActivityObservation({
      workspace: "default",
      project: "stensibly",
      actorId: "agent_keel",
      sourceClass: "ledger_event",
      sourceId: "evt_descriptor_length",
      sourceFingerprint: `sha256:${"e".repeat(64)}`,
      observedAt: "2026-08-16T09:00:00.000Z",
      activityClass: "progress_evidence",
      activityState: "observed",
    });
    let getCalls = 0;
    const observations = new Proxy([
      { appendOrder: 1, observationJson: stableJson(canonical) },
    ], {
      get(_target, property) {
        getCalls += 1;
        throw new Error(`caller get must stay untouched: ${String(property)}`);
      },
    });

    const admitted = admitDurableProjectActivityOrchestratorV1({
      observations,
      truncated: false,
    });
    expect(admitted.orchestrator).toEqual([canonical]);
    expect(getCalls).toBe(0);
  });
});
