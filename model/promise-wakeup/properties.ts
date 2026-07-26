import {
  actions, apply, check, runners, same, stateKey, supervisors, terminalPromises,
  type Action, type Bounds, type Node, type State, type WakeupRecord, type WeakRule,
} from "./domain.ts";

export const invariantNames = [
  "coherent_promise_state", "exact_promise_generation_fences_commands",
  "one_wakeup_per_promise_generation", "duplicate_delivery_at_most_one_effect",
  "terminal_promise_outcomes_exclusive", "consume_exact_consumer_generation",
  "consume_exact_run_generation", "complete_exact_consumer_generation",
  "complete_exact_run_generation", "consume_idempotent",
  "stale_wakeup_cannot_wake_new_consumer", "consumed_marker_survives_restart",
  "terminal_consumer_not_regressed", "project_identity_preserved",
] as const;
export const livenessNames = [
  "expired_pending_promise_reconcilable",
  "current_consumable_wakeup_has_consume_path",
  "satisfied_current_promise_has_consume_or_escalate_path",
  "satisfied_current_promise_has_wakeup",
  "consumed_generation_never_becomes_consumable_after_restart",
] as const;
export type InvariantName = typeof invariantNames[number];
export type LivenessName = typeof livenessNames[number];
export type ActionProvider = (state: State, bounds: Bounds) => Action[];
export interface Counterexample {
  kind: WeakRule; reachable: true; trace: string[]; state: State; weakOutcome: string;
}
export interface Observations {
  sawCoherentPromise: boolean; sawOlderPromiseProbe: boolean; sawDuplicateTransition: boolean;
  sawTerminalPromise: boolean; sawWrongConsumerProbe: boolean; sawStaleRunConsumeProbe: boolean;
  sawWrongCompleteConsumerProbe: boolean; sawStaleRunCompleteProbe: boolean;
  sawConsumedWakeup: boolean; sawStaleWakeup: boolean; sawRestartWithConsumed: boolean;
  sawTerminalConsumer: boolean; sawExpiredPending: boolean; sawConsumableReadyWakeup: boolean;
  sawSatisfied: boolean; sawSatisfiedResolution: boolean; sawWakeupRecord: boolean;
}
export function observations(): Observations {
  return {
    sawCoherentPromise: false, sawOlderPromiseProbe: false, sawDuplicateTransition: false,
    sawTerminalPromise: false, sawWrongConsumerProbe: false, sawStaleRunConsumeProbe: false,
    sawWrongCompleteConsumerProbe: false, sawStaleRunCompleteProbe: false,
    sawConsumedWakeup: false, sawStaleWakeup: false, sawRestartWithConsumed: false,
    sawTerminalConsumer: false, sawExpiredPending: false, sawConsumableReadyWakeup: false,
    sawSatisfied: false, sawSatisfiedResolution: false, sawWakeupRecord: false,
  };
}

export function checkState(state: State, seen: Observations): void {
  if (state.promiseStatus === "none") {
    check(state.promiseGeneration === 0 && state.promiseDeadline === null && state.promiseResultRef === null, "none promise is incoherent", state);
  }
  if (state.promiseStatus === "pending") {
    check(state.promiseGeneration > 0 && state.promiseDeadline !== null && state.promiseResultRef === null, "pending promise is incoherent", state);
  }
  if (terminalPromises.has(state.promiseStatus)) {
    check(state.promiseDeadline === null, "terminal promise retained a deadline", state);
    check((state.promiseStatus === "satisfied") === (state.promiseResultRef !== null), "terminal promise outcome is not exclusive", state);
    seen.sawTerminalPromise = true;
  }
  seen.sawCoherentPromise = true;
  const generations = new Set<number>();
  for (const wakeup of state.wakeups) {
    seen.sawWakeupRecord = true;
    check(wakeup.project === state.project, "wakeup project identity changed", state);
    check(!generations.has(wakeup.promiseGeneration), "more than one wakeup exists for a promise generation", state);
    generations.add(wakeup.promiseGeneration);
    if (wakeup.status === "ready") {
      check(wakeup.consumedByRunGeneration === null && wakeup.consumedByRunner === null, "ready wakeup carries a consumed marker", state);
      if (wakeup.promiseGeneration !== state.promiseGeneration || wakeup.consumerGeneration !== state.consumerGeneration) seen.sawStaleWakeup = true;
    }
    if (wakeup.status === "consumed") {
      check(wakeup.consumedByRunGeneration !== null && wakeup.consumedByRunner !== null, "consumed wakeup lacks a durable marker", state);
      seen.sawConsumedWakeup = true;
      if (state.restarted) seen.sawRestartWithConsumed = true;
    }
  }
  if (state.consumerStatus === "terminal") seen.sawTerminalConsumer = true;
}

export function probeFences(state: State, seen: Observations): void {
  if (state.promiseGeneration > 0) {
    const older = state.promiseGeneration - 1;
    for (const supervisor of supervisors) for (const command of ["satisfy", "miss", "cancel"] as const) {
      same(state, apply(state, { kind: "promise", supervisor, command, expectedGeneration: older }), `older promise ${command}`);
    }
    same(state, apply(state, { kind: "reconcile", expectedGeneration: older }), "older promise reconcile");
    seen.sawOlderPromiseProbe = true;
  }
  for (const wakeup of state.wakeups.filter((entry) => entry.status === "ready")) {
    if (
      wakeup.promiseGeneration === state.promiseGeneration
      && wakeup.consumerGeneration !== state.consumerGeneration
    ) {
      for (const runner of runners) {
        same(state, apply(state, { kind: "consume", runner, expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration }), "stale consumer generation consume");
      }
      seen.sawWrongConsumerProbe = true;
    }
    if (
      wakeup.promiseGeneration === state.promiseGeneration
      && wakeup.consumerGeneration === state.consumerGeneration
      && state.consumerRunGeneration > 0
    ) {
      for (const runner of runners) {
        same(state, apply(state, { kind: "consume", runner, expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration - 1 }), "stale run generation consume");
      }
      seen.sawStaleRunConsumeProbe = true;
    }
    if (wakeup.promiseGeneration !== state.promiseGeneration || wakeup.consumerGeneration !== state.consumerGeneration) {
      for (const runner of runners) {
        same(state, apply(state, { kind: "consume", runner, expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration }), "stale wakeup consume");
      }
      seen.sawStaleWakeup = true;
    }
  }
  if (state.consumerStatus === "active") {
    const wrongConsumer = state.consumerGeneration === 1 ? 2 : 1;
    const staleRun = state.consumerRunGeneration - 1;
    for (const runner of runners) {
      same(state, apply(state, { kind: "complete-consumer", runner, expectedConsumerGeneration: wrongConsumer, expectedRunGeneration: state.consumerRunGeneration }), "wrong consumer generation completion");
      same(state, apply(state, { kind: "complete-consumer", runner, expectedConsumerGeneration: state.consumerGeneration, expectedRunGeneration: staleRun }), "stale run generation completion");
    }
    seen.sawWrongCompleteConsumerProbe = true;
    seen.sawStaleRunCompleteProbe = true;
  }
  for (const wakeup of state.wakeups.filter((entry) => entry.status === "consumed")) {
    same(state, apply(state, { kind: "consume", runner: wakeup.consumedByRunner ?? runners[0]!, expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration, expectedRunGeneration: wakeup.consumedByRunGeneration ?? state.consumerRunGeneration }), "consumed wakeup replay");
  }
}

export function probeTerminal(state: State, seen: Observations): void {
  if (state.consumerStatus !== "terminal") return;
  for (const runner of runners) {
    same(state, apply(state, { kind: "advance-consumer", runner, expectedConsumerGeneration: state.consumerGeneration }), "terminal consumer advance");
    same(state, apply(state, { kind: "consume", runner, expectedPromiseGeneration: state.promiseGeneration, expectedConsumerGeneration: state.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration }), "terminal consumer consume");
  }
  seen.sawTerminalConsumer = true;
}

export function checkLiveness(states: State[], bounds: Bounds, seen: Observations): void {
  for (const state of states) {
    if (state.promiseStatus === "pending" && state.promiseDeadline !== null && state.promiseDeadline <= state.time) {
      check(apply(state, { kind: "reconcile", expectedGeneration: state.promiseGeneration }).promiseStatus === "missed", "expired pending promise is not reconcilable", state);
      seen.sawExpiredPending = true;
    }
    if (state.promiseStatus === "satisfied") {
      const wakeup = state.wakeups.find((entry) => entry.promiseGeneration === state.promiseGeneration);
      check(wakeup !== undefined, "satisfied current promise has no wakeup", state);
      seen.sawSatisfied = true;
      check(hasWakeupPath(state, wakeup, bounds, new Set(["consumed", "escalated"])), "satisfied current promise has no bounded consume or escalate path", state);
      seen.sawSatisfiedResolution = true;
    }
    for (const wakeup of state.wakeups.filter((entry) =>
      entry.status === "ready"
      && entry.promiseGeneration === state.promiseGeneration
      && entry.consumerGeneration === state.consumerGeneration
      && state.promiseStatus === "satisfied"
      && state.consumerStatus !== "terminal"
    )) {
      check(hasWakeupPath(state, wakeup, bounds, new Set(["consumed"])), "current consumable wakeup has no bounded consume path", state);
      seen.sawConsumableReadyWakeup = true;
    }
    if (state.restarted) for (const wakeup of state.wakeups.filter((entry) => entry.status === "consumed")) {
      same(state, apply(state, { kind: "consume", runner: wakeup.consumedByRunner ?? runners[0]!, expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration, expectedRunGeneration: wakeup.consumedByRunGeneration ?? state.consumerRunGeneration }), "consumed wakeup after restart");
      seen.sawRestartWithConsumed = true;
    }
  }
}

export function hasWakeupPath(
  start: State,
  target: WakeupRecord,
  bounds: Bounds,
  acceptedStatuses: ReadonlySet<WakeupRecord["status"]>,
  actionProvider: ActionProvider = actions,
): boolean {
  const queue: Array<{ state: State; depth: number }> = [{ state: start, depth: 0 }];
  const visited = new Set<string>([stateKey(start)]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]!;
    if (wakeupReached(node.state, target, acceptedStatuses)) return true;
    if (node.depth >= bounds.recoveryHorizonTicks) continue;
    for (const action of actionProvider(node.state, bounds)) {
      const next = apply(node.state, action);
      if (next === node.state) continue;
      const key = stateKey(next);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ state: next, depth: node.depth + 1 });
    }
  }
  return false;
}

function wakeupReached(
  state: State,
  target: WakeupRecord,
  acceptedStatuses: ReadonlySet<WakeupRecord["status"]>,
): boolean {
  return state.wakeups.some((entry) =>
    entry.promiseGeneration === target.promiseGeneration
    && entry.consumerGeneration === target.consumerGeneration
    && acceptedStatuses.has(entry.status)
  );
}

export function finish(seen: Observations): { invariants: Record<InvariantName, "passed">; boundedLiveness: Record<LivenessName, "passed"> } {
  const i = new Set<InvariantName>(); const l = new Set<LivenessName>();
  if (seen.sawCoherentPromise) i.add("coherent_promise_state");
  if (seen.sawOlderPromiseProbe) i.add("exact_promise_generation_fences_commands");
  if (seen.sawDuplicateTransition) i.add("duplicate_delivery_at_most_one_effect");
  if (seen.sawTerminalPromise) i.add("terminal_promise_outcomes_exclusive");
  if (seen.sawWrongConsumerProbe) i.add("consume_exact_consumer_generation");
  if (seen.sawStaleRunConsumeProbe) i.add("consume_exact_run_generation");
  if (seen.sawWrongCompleteConsumerProbe) i.add("complete_exact_consumer_generation");
  if (seen.sawStaleRunCompleteProbe) i.add("complete_exact_run_generation");
  if (seen.sawConsumedWakeup) i.add("consume_idempotent");
  if (seen.sawStaleWakeup) i.add("stale_wakeup_cannot_wake_new_consumer");
  if (seen.sawRestartWithConsumed) i.add("consumed_marker_survives_restart");
  if (seen.sawTerminalConsumer) i.add("terminal_consumer_not_regressed");
  if (seen.sawWakeupRecord) {
    i.add("one_wakeup_per_promise_generation");
    i.add("project_identity_preserved");
  }
  if (seen.sawExpiredPending) l.add("expired_pending_promise_reconcilable");
  if (seen.sawConsumableReadyWakeup) l.add("current_consumable_wakeup_has_consume_path");
  if (seen.sawSatisfiedResolution) l.add("satisfied_current_promise_has_consume_or_escalate_path");
  if (seen.sawSatisfied) l.add("satisfied_current_promise_has_wakeup");
  if (seen.sawRestartWithConsumed) l.add("consumed_generation_never_becomes_consumable_after_restart");
  requireCoverage(invariantNames, i, "invariant"); requireCoverage(livenessNames, l, "bounded liveness");
  return { invariants: report(invariantNames, i), boundedLiveness: report(livenessNames, l) };
}

export function negativeControls(nodes: Map<string, Node>): Counterexample[] {
  let identity: Counterexample | null = null, duplicate: Counterexample | null = null, race: Counterexample | null = null;
  for (const [key, node] of nodes) {
    const state = node.state;
    const ready = state.wakeups.find((wakeup) => wakeup.status === "ready");
    const stale = state.wakeups.find((wakeup) => wakeup.status === "ready" && wakeup.consumerGeneration === state.consumerGeneration && wakeup.promiseGeneration !== state.promiseGeneration);
    if (!identity && stale) identity = { kind: "identity_only_generation", reachable: true, trace: trace(nodes, key), state, weakOutcome: `identity-only authority would consume wakeup generation ${stale.promiseGeneration} as current generation ${state.promiseGeneration}` };
    if (!duplicate && ready) duplicate = { kind: "consume_without_marker", reachable: true, trace: trace(nodes, key), state, weakOutcome: `duplicate consume delivery would emit two effects for promise generation ${ready.promiseGeneration}` };
    if (!race && state.promiseStatus === "pending" && state.promiseDeadline !== null && state.promiseDeadline <= state.time) race = { kind: "terminal_race_without_fence", reachable: true, trace: trace(nodes, key), state, weakOutcome: "unfenced deadline reconciliation and late satisfaction can commit conflicting terminal outcomes" };
    if (identity && duplicate && race) break;
  }
  if (!identity || !duplicate || !race) throw new Error("Expected weak-rule counterexamples were not reachable");
  return [identity, duplicate, race];
}
function trace(nodes: Map<string, Node>, key: string): string[] {
  const out: string[] = []; let cursor: string | null = key;
  while (cursor !== null) { const node = nodes.get(cursor); if (!node) throw new Error("Counterexample trace node is missing"); if (node.action) out.push(node.action); cursor = node.parent; }
  return out.reverse();
}
function requireCoverage<T extends string>(expected: readonly T[], actual: Set<T>, kind: string): void {
  const missing = expected.filter((name) => !actual.has(name)); if (missing.length) throw new Error(`Missing ${kind} coverage: ${missing.join(", ")}`);
}
function report<T extends string>(expected: readonly T[], actual: Set<T>): Record<T, "passed"> {
  return Object.fromEntries(expected.filter((name) => actual.has(name)).map((name) => [name, "passed"])) as Record<T, "passed">;
}
export function durableEqual(before: State, after: State): void {
  same({ ...before, restarted: false }, { ...after, restarted: false }, "restart durability");
}
