import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { assertPromiseWakeupModelConfig, checkPromiseWakeupModel } from "../model/promise-wakeup/check.ts";

const config = assertPromiseWakeupModelConfig(
  JSON.parse(readFileSync(new URL("../model/promise-wakeup/config.json", import.meta.url), "utf8")) as unknown,
);
const options = {
  maxDepth: config.maxDepth,
  maxTime: config.maxTime,
  maxPromiseGeneration: config.maxPromiseGeneration,
  maxConsumerGeneration: config.maxConsumerGeneration,
  recoveryHorizonTicks: config.recoveryHorizonTicks,
} as const;

const expectedInvariants = [
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
] as const;
const expectedLiveness = [
  "consumed_generation_never_becomes_consumable_after_restart",
  "current_ready_wakeup_has_consume_or_escalate_path",
  "expired_pending_promise_reconcilable",
  "satisfied_current_promise_has_wakeup",
] as const;

describe("bounded promise/wakeup lifecycle", () => {
  test("checks the exact finite state space and weak-rule controls", () => {
    const report = checkPromiseWakeupModel();
    expect(report.bounds).toEqual({
      ...options,
      supervisors: 2,
      runners: 2,
      projects: 1,
      producerItems: 1,
      consumerItems: 1,
    });
    expect(report.exploration).toEqual({
      reachableStates: 1_330,
      exploredTransitions: 5_162,
      maximumDepthReached: 8,
    });
    expect(Object.keys(report.invariants).sort()).toEqual([...expectedInvariants].sort());
    expect(Object.values(report.invariants).every((value) => value === "passed")).toBe(true);
    expect(Object.keys(report.boundedLiveness).sort()).toEqual([...expectedLiveness].sort());
    expect(Object.values(report.boundedLiveness).every((value) => value === "passed")).toBe(true);

    const controls = Object.fromEntries(report.negativeControls.map((control) => [control.kind, control]));
    const identity = controls.identity_only_generation;
    expect(identity?.trace).toEqual([
      "create:supervisor-a",
      "satisfy:supervisor-a:p1",
      "supersede:supervisor-a:p1",
    ]);
    expect(identity?.state).toMatchObject({
      promiseGeneration: 2,
      promiseStatus: "pending",
      consumerGeneration: 1,
      wakeups: [expect.objectContaining({ promiseGeneration: 1, status: "ready" })],
    });
    expect(identity?.weakOutcome).toContain("consume wakeup generation 1 as current generation 2");

    const duplicate = controls.consume_without_marker;
    expect(duplicate?.trace).toEqual([
      "create:supervisor-a",
      "satisfy:supervisor-a:p1",
    ]);
    const duplicateWakeup = duplicate?.state.wakeups[0];
    expect(duplicateWakeup).toBeDefined();
    expect(duplicateWakeup?.promiseGeneration).toBe(1);
    expect(duplicateWakeup?.status).toBe("ready");
    expect(duplicateWakeup?.consumedByRunGeneration).toBeNull();
    expect(duplicateWakeup?.consumedByRunner).toBeNull();
    expect(duplicate?.weakOutcome).toContain("emit two effects");

    const race = controls.terminal_race_without_fence;
    expect(race?.trace).toEqual([
      "create:supervisor-a",
      "tick",
      "tick",
    ]);
    expect(race?.state.promiseStatus).toBe("pending");
    expect(race?.state.promiseDeadline).not.toBeNull();
    expect(race!.state.promiseDeadline!).toBeLessThanOrEqual(race!.state.time);
    expect(race?.weakOutcome).toContain("conflicting terminal outcomes");
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
