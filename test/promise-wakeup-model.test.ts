import { describe, expect, test } from "bun:test";
import { assertPromiseWakeupModelConfig, checkPromiseWakeupModel } from "../model/promise-wakeup/check.ts";

const options = {
  maxDepth: 8,
  maxTime: 4,
  maxPromiseGeneration: 2,
  maxConsumerGeneration: 2,
  recoveryHorizonTicks: 2,
} as const;

describe("bounded promise/wakeup lifecycle", () => {
  test("checks the exact finite state space and weak-rule controls", () => {
    const report = checkPromiseWakeupModel(options);
    expect(report.exploration).toEqual({
      reachableStates: 1_330,
      exploredTransitions: 5_162,
      maximumDepthReached: 8,
    });
    expect(Object.keys(report.invariants).sort()).toEqual([
      "coherent_promise_state",
      "consume_exact_consumer_generation",
      "consume_idempotent",
      "consumed_marker_survives_restart",
      "duplicate_delivery_at_most_one_effect",
      "exact_promise_generation_fences_commands",
      "one_wakeup_per_promise_generation",
      "project_identity_preserved",
      "stale_wakeup_cannot_wake_new_consumer",
      "terminal_consumer_not_regressed",
      "terminal_promise_outcomes_exclusive",
    ]);
    expect(Object.keys(report.boundedLiveness).sort()).toEqual([
      "consumed_generation_never_becomes_consumable_after_restart",
      "current_ready_wakeup_has_consume_or_escalate_path",
      "expired_pending_promise_reconcilable",
      "satisfied_current_promise_has_wakeup",
    ]);

    const controls = Object.fromEntries(report.negativeControls.map((control) => [control.kind, control]));
    expect(controls.identity_only_generation?.trace).toEqual([
      "create:supervisor-a",
      "satisfy:supervisor-a:p1",
      "supersede:supervisor-a:p1",
    ]);
    expect(controls.identity_only_generation?.state).toMatchObject({
      promiseGeneration: 2,
      promiseStatus: "pending",
      consumerGeneration: 1,
      wakeups: [expect.objectContaining({ promiseGeneration: 1, status: "ready" })],
    });
    expect(controls.consume_without_marker?.trace).toEqual([
      "create:supervisor-a",
      "satisfy:supervisor-a:p1",
    ]);
    expect(controls.terminal_race_without_fence?.trace).toEqual([
      "create:supervisor-a",
      "tick",
      "tick",
    ]);
    expect(report.negativeControls.every((control) => control.reachable)).toBe(true);
  });

  test("rejects malformed configuration and direct bounds", () => {
    expect(() => assertPromiseWakeupModelConfig({ schemaVersion: 2, ...options }))
      .toThrow("schemaVersion must be 1");
    expect(() => assertPromiseWakeupModelConfig({ schemaVersion: 1, ...options, unknown: true }))
      .toThrow("Unknown model config keys");
    expect(() => assertPromiseWakeupModelConfig({ schemaVersion: 1, ...options, maxPromiseGeneration: 0 }))
      .toThrow("maxPromiseGeneration must be an integer between 1 and 4");
    expect(() => checkPromiseWakeupModel({ ...options, maxDepth: 0 }))
      .toThrow("maxDepth must be an integer between 1 and 14");
    expect(() => checkPromiseWakeupModel({ ...options, maxTime: 13 }))
      .toThrow("maxTime must be an integer between 1 and 12");
  });
});
