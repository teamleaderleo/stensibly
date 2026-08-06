import { describe, expect, test } from "bun:test";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const fingerprint = `sha256:${"b".repeat(64)}`;

function input(): OrchestratorActivityObservationInput {
  return {
    workspace: "default",
    project: "stensibly",
    actorId: "actor_junco",
    sourceClass: "ledger_event",
    sourceId: "event_1150_envelope",
    sourceFingerprint: fingerprint,
    observedAt: "2026-08-06T05:30:00.000Z",
    activityClass: "progress_evidence",
    activityState: "observed",
  };
}

describe("orchestrator activity envelope work bounds", () => {
  test("admits the closed envelope without caller key enumeration", () => {
    let ownKeysCalls = 0;
    const value = new Proxy(input(), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("top-level ownKeys must not be required");
      },
      getOwnPropertyDescriptor(target, key) {
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf() {
        return Object.prototype;
      },
    });

    const observation = compileOrchestratorActivityObservation(value);

    expect(observation.sourceId).toBe("event_1150_envelope");
    expect(observation.activityState).toBe("observed");
    expect(ownKeysCalls).toBe(0);
  });
});
