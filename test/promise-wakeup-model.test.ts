import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { assertPromiseWakeupModelConfig, checkPromiseWakeupModel } from "../model/promise-wakeup/check.ts";
import { apply, initial, stateKey, type Action, type State } from "../model/promise-wakeup/domain.ts";

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
  "complete_exact_consumer_generation",
  "complete_exact_run_generation",
  "consume_exact_consumer_generation",
  "consume_exact_run_generation",
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
  "current_consumable_wakeup_has_consume_path",
  "current_ready_wakeup_has_consume_or_escalate_path",
  "expired_pending_promise_reconcilable",
  "satisfied_current_promise_has_wakeup",
] as const;

describe("bounded promise/wakeup lifecycle", () => {
  test("checks the exact finite state space and weak-rule controls", () => {
    const report = checkPromiseWakeupModel();
    expect(report.checkerVersion).toBe("2");
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
    expect(identity?.state.promiseGeneration).toBe(2);
    expect(identity?.state.promiseStatus).toBe("pending");
    expect(identity?.state.consumerGeneration).toBe(1);
    const identityWakeup = identity?.state.wakeups[0];
    expect(identityWakeup).toBeDefined();
    expect(identityWakeup?.promiseGeneration).toBe(1);
    expect(identityWakeup?.status).toBe("ready");
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

  test("makes every claimed transition guard mutation-sensitive", () => {
    const created = transition(initial, { kind: "create", supervisor: "supervisor-a" });
    const expired = transition(transition(created, { kind: "tick" }), { kind: "tick" });
    const satisfied = transition(created, {
      kind: "promise", supervisor: "supervisor-a", command: "satisfy", expectedGeneration: 1,
    });
    const consumed = transition(satisfied, {
      kind: "consume", runner: "runner-a", expectedPromiseGeneration: 1,
      expectedConsumerGeneration: 1, expectedRunGeneration: 0,
    });
    const completed = transition(consumed, {
      kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 1,
      expectedRunGeneration: 1,
    });
    const superseded = transition(satisfied, {
      kind: "supersede", supervisor: "supervisor-a", expectedGeneration: 1,
    });
    const advanced = transition(satisfied, {
      kind: "advance-consumer", runner: "runner-a", expectedConsumerGeneration: 1,
    });
    const readyAtRunOne = transition(
      transition(advanced, { kind: "supersede", supervisor: "supervisor-a", expectedGeneration: 1 }),
      { kind: "promise", supervisor: "supervisor-a", command: "satisfy", expectedGeneration: 2 },
    );
    const activeAtRunTwo = transition(readyAtRunOne, {
      kind: "consume", runner: "runner-a", expectedPromiseGeneration: 2,
      expectedConsumerGeneration: 2, expectedRunGeneration: 1,
    });
    const terminalWithReady = transition(
      transition(
        transition(consumed, { kind: "supersede", supervisor: "supervisor-a", expectedGeneration: 1 }),
        { kind: "promise", supervisor: "supervisor-a", command: "satisfy", expectedGeneration: 2 },
      ),
      { kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 1, expectedRunGeneration: 1 },
    );

    const matrix: Array<{ label: string; state: State; action: Action; changes: boolean }> = [
      { label: "valid satisfy", state: created, action: { kind: "promise", supervisor: "supervisor-a", command: "satisfy", expectedGeneration: 1 }, changes: true },
      { label: "valid expired reconcile", state: expired, action: { kind: "reconcile", expectedGeneration: 1 }, changes: true },
      { label: "valid consume", state: readyAtRunOne, action: { kind: "consume", runner: "runner-a", expectedPromiseGeneration: 2, expectedConsumerGeneration: 2, expectedRunGeneration: 1 }, changes: true },
      { label: "valid completion", state: activeAtRunTwo, action: { kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 2, expectedRunGeneration: 2 }, changes: true },
      { label: "duplicate create", state: created, action: { kind: "create", supervisor: "supervisor-b" }, changes: false },
      { label: "stale supersede generation", state: created, action: { kind: "supersede", supervisor: "supervisor-a", expectedGeneration: 0 }, changes: false },
      { label: "stale terminal command generation", state: created, action: { kind: "promise", supervisor: "supervisor-a", command: "satisfy", expectedGeneration: 0 }, changes: false },
      { label: "late terminal command", state: satisfied, action: { kind: "promise", supervisor: "supervisor-b", command: "miss", expectedGeneration: 1 }, changes: false },
      { label: "premature reconciliation", state: created, action: { kind: "reconcile", expectedGeneration: 1 }, changes: false },
      { label: "stale reconciliation generation", state: expired, action: { kind: "reconcile", expectedGeneration: 0 }, changes: false },
      { label: "stale promise generation consume", state: superseded, action: { kind: "consume", runner: "runner-a", expectedPromiseGeneration: 1, expectedConsumerGeneration: 1, expectedRunGeneration: 0 }, changes: false },
      { label: "stale consumer generation consume", state: advanced, action: { kind: "consume", runner: "runner-a", expectedPromiseGeneration: 1, expectedConsumerGeneration: 1, expectedRunGeneration: 1 }, changes: false },
      { label: "stale run generation consume", state: readyAtRunOne, action: { kind: "consume", runner: "runner-a", expectedPromiseGeneration: 2, expectedConsumerGeneration: 2, expectedRunGeneration: 0 }, changes: false },
      { label: "duplicate consumed wakeup", state: consumed, action: { kind: "consume", runner: "runner-b", expectedPromiseGeneration: 1, expectedConsumerGeneration: 1, expectedRunGeneration: 1 }, changes: false },
      { label: "terminal consumer consume", state: terminalWithReady, action: { kind: "consume", runner: "runner-b", expectedPromiseGeneration: 2, expectedConsumerGeneration: 1, expectedRunGeneration: 1 }, changes: false },
      { label: "completion requires active consumer", state: satisfied, action: { kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 1, expectedRunGeneration: 0 }, changes: false },
      { label: "stale consumer generation completion", state: activeAtRunTwo, action: { kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 1, expectedRunGeneration: 2 }, changes: false },
      { label: "stale run generation completion", state: activeAtRunTwo, action: { kind: "complete-consumer", runner: "runner-a", expectedConsumerGeneration: 2, expectedRunGeneration: 1 }, changes: false },
      { label: "terminal consumer advance", state: completed, action: { kind: "advance-consumer", runner: "runner-b", expectedConsumerGeneration: 1 }, changes: false },
      { label: "stale consumer generation advance", state: satisfied, action: { kind: "advance-consumer", runner: "runner-a", expectedConsumerGeneration: 0 }, changes: false },
      { label: "duplicate restart", state: transition(initial, { kind: "restart" }), action: { kind: "restart" }, changes: false },
    ];

    for (const entry of matrix) {
      const changed = stateKey(apply(entry.state, entry.action)) !== stateKey(entry.state);
      if (changed !== entry.changes) {
        throw new Error(`Guard mutation matrix mismatch: ${entry.label}`);
      }
    }
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

function transition(state: State, action: Action): State {
  const next = apply(state, action);
  if (stateKey(next) === stateKey(state)) {
    throw new Error(`Expected ${action.kind} to change state`);
  }
  return next;
}
