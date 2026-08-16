import { expect, test } from "bun:test";
import {
  admitOrchestratorActivityObservation,
  orchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation-admission.ts";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.ts";

function observation() {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_admission",
    sourceClass: "ledger_event",
    sourceId: "event_admission_1",
    sourceFingerprint: `sha256:${"d".repeat(64)}`,
    observedAt: "2026-08-16T06:20:00.000Z",
    activityClass: "progress_evidence",
    activityState: "in_progress",
  });
}

test("canonical orchestrator activity re-admission preserves null optionals exactly", () => {
  const canonical = observation();
  const admitted = admitOrchestratorActivityObservation(JSON.parse(JSON.stringify(canonical)));

  expect(admitted).toEqual(canonical);
  expect(admitted.workItemId).toBeNull();
  expect(admitted.provider).toBeNull();
  expect(Object.isFrozen(admitted)).toBe(true);
});

test("canonical orchestrator activity converts back to producer-input omission", () => {
  const canonical = observation();
  const input = orchestratorActivityObservationInput(canonical);

  expect(input).toMatchObject({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_admission",
    relatedEvidenceIds: [],
    attentionLevel: "none",
  });
  expect(Object.hasOwn(input, "workItemId")).toBe(false);
  expect(Object.hasOwn(input, "provider")).toBe(false);
  expect(compileOrchestratorActivityObservation(input)).toEqual(canonical);
});

test("canonical orchestrator activity rejects changed or decorated durable bytes", () => {
  const canonical = observation();
  const changed = JSON.parse(JSON.stringify(canonical));
  changed.activityState = "succeeded";
  expect(() => admitOrchestratorActivityObservation(changed)).toThrow(
    /canonical observation is inconsistent|activity/i,
  );

  const decorated = JSON.parse(JSON.stringify(canonical));
  decorated.rawPrompt = "must never survive durable admission";
  expect(() => admitOrchestratorActivityObservation(decorated)).toThrow("fields are invalid");
});
