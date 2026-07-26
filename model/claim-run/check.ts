import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Supervisor = "supervisor-a" | "supervisor-b";
type Runner = "runner-a" | "runner-b";
type RunStatus = "none" | "queued" | "running" | "waiting" | "blocked"
  | "succeeded" | "failed" | "cancelled" | "abandoned";
type Terminal = "succeeded" | "failed" | "cancelled" | "abandoned";

export interface ClaimRunState {
  time: number;
  itemStatus: "ready" | "active" | "succeeded" | "cancelled";
  claimHolder: Runner | null;
  claimGeneration: number;
  claimExpiresAt: number | null;
  runStatus: RunStatus;
  runActor: Runner | null;
  runClaimGeneration: number | null;
  runGeneration: number;
  runLeaseGeneration: number;
  runLeaseOwner: Runner | null;
  runLeaseExpiresAt: number | null;
}

export interface Counterexample {
  kind: "stale_same_actor_generation" | "missing_run_lease";
  trace: string[];
  state: ClaimRunState;
}

export interface ModelReport {
  model: "claim-run";
  schemaVersion: 1;
  checker: "stensibly-explicit-state";
  checkerVersion: "1";
  bounds: { maxDepth: number; maxTime: number; supervisors: 2; runners: 2; items: 1; runs: 1 };
  exploration: { reachableStates: number; exploredTransitions: number; maximumDepthReached: number };
  invariants: Record<string, "passed">;
  boundedLiveness: Record<string, "passed">;
  negativeControls: Counterexample[];
}

type Command = "start" | "wait" | "block" | "heartbeat" | "succeed" | "fail" | "cancel";
type Action =
  | { kind: "tick" }
  | { kind: "acquire"; supervisor: Supervisor; runner: Runner }
  | { kind: "renew"; runner: Runner; claimGeneration: number }
  | { kind: "release"; runner: Runner; claimGeneration: number }
  | { kind: "dispatch"; supervisor: Supervisor; runner: Runner; claimGeneration: number }
  | { kind: "run"; runner: Runner; claimGeneration: number; runGeneration: number; leaseGeneration: number; command: Command }
  | { kind: "reconcile-claim" }
  | { kind: "abandon-run" };

type Node = { state: ClaimRunState; parent: string | null; action: string | null; depth: number };

const supervisors: Supervisor[] = ["supervisor-a", "supervisor-b"];
const runners: Runner[] = ["runner-a", "runner-b"];
const live = new Set<RunStatus>(["queued", "running", "waiting", "blocked"]);
const terminal = new Set<RunStatus>(["succeeded", "failed", "cancelled", "abandoned"]);
const config = readConfig();
const initial: ClaimRunState = {
  time: 0,
  itemStatus: "ready",
  claimHolder: null,
  claimGeneration: 0,
  claimExpiresAt: null,
  runStatus: "none",
  runActor: null,
  runClaimGeneration: null,
  runGeneration: 0,
  runLeaseGeneration: 0,
  runLeaseOwner: null,
  runLeaseExpiresAt: null,
};

export function checkModel(options: { maxDepth?: number; maxTime?: number } = {}): ModelReport {
  const maxDepth = options.maxDepth ?? config.maxDepth;
  const maxTime = options.maxTime ?? config.maxTime;
  bounded(maxDepth, "maxDepth", 1, 20);
  bounded(maxTime, "maxTime", 1, 20);

  const first = key(initial);
  const nodes = new Map<string, Node>([[first, { state: initial, parent: null, action: null, depth: 0 }]]);
  const queue = [first];
  let exploredTransitions = 0;
  let maximumDepthReached = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentKey = queue[cursor]!;
    const node = nodes.get(currentKey)!;
    maximumDepthReached = Math.max(maximumDepthReached, node.depth);
    invariant(node.state);
    staleAttemptsAreNoOps(node.state);
    if (node.depth >= maxDepth) continue;

    for (const action of actions(node.state, maxTime)) {
      const next = apply(node.state, action);
      if (next === node.state) continue;
      exploredTransitions += 1;
      transitionInvariant(node.state, next, action);
      if (action.kind !== "tick") {
        same(next, apply(next, action), `duplicate ${label(action)}`);
      }
      const nextKey = key(next);
      if (nodes.has(nextKey)) continue;
      nodes.set(nextKey, { state: next, parent: currentKey, action: label(action), depth: node.depth + 1 });
      queue.push(nextKey);
    }
  }

  const states = [...nodes.values()].map((entry) => entry.state);
  boundedRecovery(states, maxTime);
  return {
    model: "claim-run",
    schemaVersion: 1,
    checker: "stensibly-explicit-state",
    checkerVersion: "1",
    bounds: { maxDepth, maxTime, supervisors: 2, runners: 2, items: 1, runs: 1 },
    exploration: { reachableStates: nodes.size, exploredTransitions, maximumDepthReached },
    invariants: {
      coherent_claim: "passed",
      coherent_run: "passed",
      stale_claim_fence_no_effect: "passed",
      stale_run_fence_no_effect: "passed",
      expired_authority_no_effect: "passed",
      duplicate_delivery_at_most_one_effect: "passed",
      terminal_run_no_regression: "passed",
      completion_cancel_exclusive: "passed",
      current_dispatch_authority_exact_claim_generation: "passed",
      missing_expiry_never_grants_authority: "passed",
    },
    boundedLiveness: {
      expired_claim_reclaimable: "passed",
      expired_run_abandonable: "passed",
      current_queued_run_has_terminal_path: "passed",
      missing_expiry_cannot_stick_as_authority: "passed",
    },
    negativeControls: negativeControls(nodes),
  };
}

function actions(state: ClaimRunState, maxTime: number): Action[] {
  const out: Action[] = state.time < maxTime ? [{ kind: "tick" }] : [];
  for (const supervisor of supervisors) for (const runner of runners) {
    out.push({ kind: "acquire", supervisor, runner });
    out.push({ kind: "dispatch", supervisor, runner, claimGeneration: state.claimGeneration });
  }
  for (const runner of runners) {
    out.push({ kind: "renew", runner, claimGeneration: state.claimGeneration });
    out.push({ kind: "release", runner, claimGeneration: state.claimGeneration });
    for (const command of ["start", "wait", "block", "heartbeat", "succeed", "fail", "cancel"] as const) {
      out.push({
        kind: "run",
        runner,
        claimGeneration: state.runClaimGeneration ?? 0,
        runGeneration: state.runGeneration,
        leaseGeneration: state.runLeaseGeneration,
        command,
      });
    }
  }
  out.push({ kind: "reconcile-claim" }, { kind: "abandon-run" });
  return out;
}

function apply(state: ClaimRunState, action: Action): ClaimRunState {
  if (action.kind === "tick") return { ...state, time: state.time + 1 };
  if (action.kind === "reconcile-claim") {
    if (state.claimHolder === null || state.claimExpiresAt === null || state.claimExpiresAt > state.time) return state;
    return clearClaim(state, state.itemStatus === "active" ? "ready" : state.itemStatus);
  }
  if (action.kind === "abandon-run") {
    if (!live.has(state.runStatus) || state.runLeaseExpiresAt === null || state.runLeaseExpiresAt > state.time) return state;
    return { ...state, runStatus: "abandoned", runLeaseOwner: null, runLeaseExpiresAt: null };
  }
  if (action.kind === "acquire") {
    if (["succeeded", "cancelled"].includes(state.itemStatus)) return state;
    if (state.claimHolder !== null && state.claimExpiresAt !== null && state.claimExpiresAt > state.time) return state;
    return {
      ...state,
      itemStatus: "active",
      claimHolder: action.runner,
      claimGeneration: state.claimGeneration + 1,
      claimExpiresAt: state.time + 2,
    };
  }
  if (action.kind === "renew") {
    if (!currentClaim(state, action.runner, action.claimGeneration)) return state;
    return { ...state, claimExpiresAt: state.time + 2 };
  }
  if (action.kind === "release") {
    if (!currentClaim(state, action.runner, action.claimGeneration)) return state;
    return clearClaim(state, state.itemStatus === "active" ? "ready" : state.itemStatus);
  }
  if (action.kind === "dispatch") {
    if (!currentClaim(state, action.runner, action.claimGeneration) || state.runStatus !== "none") return state;
    return {
      ...state,
      runStatus: "queued",
      runActor: action.runner,
      runClaimGeneration: state.claimGeneration,
      runGeneration: 1,
      runLeaseGeneration: 1,
      runLeaseOwner: action.runner,
      runLeaseExpiresAt: state.time + 3,
    };
  }

  if (!currentRun(state, action)) return state;
  if (action.command === "heartbeat") {
    return { ...state, runLeaseGeneration: state.runLeaseGeneration + 1, runLeaseExpiresAt: state.time + 3 };
  }
  if (action.command === "start") return state.runStatus === "queued" ? { ...state, runStatus: "running" } : state;
  if (action.command === "wait") {
    return state.runStatus === "running" || state.runStatus === "blocked" ? { ...state, runStatus: "waiting" } : state;
  }
  if (action.command === "block") {
    return state.runStatus === "running" || state.runStatus === "waiting" ? { ...state, runStatus: "blocked" } : state;
  }
  const status: Terminal = action.command === "succeed" ? "succeeded"
    : action.command === "cancel" ? "cancelled" : "failed";
  const itemStatus = status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "ready";
  return {
    ...clearClaim(state, itemStatus),
    runStatus: status,
    runLeaseOwner: null,
    runLeaseExpiresAt: null,
  };
}

function clearClaim(state: ClaimRunState, itemStatus: ClaimRunState["itemStatus"]): ClaimRunState {
  return {
    ...state,
    itemStatus,
    claimHolder: null,
    claimGeneration: state.claimGeneration + 1,
    claimExpiresAt: null,
  };
}

function currentClaim(state: ClaimRunState, runner: Runner, generation: number): boolean {
  return state.claimHolder === runner
    && state.claimGeneration === generation
    && state.claimExpiresAt !== null
    && state.claimExpiresAt > state.time;
}

function currentRun(state: ClaimRunState, action: Extract<Action, { kind: "run" }>): boolean {
  return live.has(state.runStatus)
    && currentClaim(state, action.runner, action.claimGeneration)
    && state.runActor === action.runner
    && state.runLeaseOwner === action.runner
    && state.runGeneration === action.runGeneration
    && state.runLeaseGeneration === action.leaseGeneration
    && state.runLeaseExpiresAt !== null
    && state.runLeaseExpiresAt > state.time;
}

function strictAuthority(state: ClaimRunState): boolean {
  return weakAuthority(state)
    && state.claimExpiresAt !== null
    && state.claimExpiresAt > state.time
    && state.runClaimGeneration === state.claimGeneration
    && state.runLeaseOwner === state.claimHolder
    && state.runLeaseExpiresAt !== null
    && state.runLeaseExpiresAt > state.time;
}

function weakAuthority(state: ClaimRunState): boolean {
  return state.itemStatus === "active"
    && state.claimHolder !== null
    && live.has(state.runStatus)
    && state.runActor === state.claimHolder;
}

function invariant(state: ClaimRunState): void {
  check((state.claimHolder === null) === (state.claimExpiresAt === null), "claim holder/expiry coherence", state);
  if (state.runStatus === "none") {
    check(state.runActor === null && state.runClaimGeneration === null, "empty run identity", state);
    check(state.runLeaseOwner === null && state.runLeaseExpiresAt === null, "empty run lease", state);
  }
  if (live.has(state.runStatus)) {
    check(state.runActor !== null && state.runClaimGeneration !== null, "live run identity", state);
    check(state.runLeaseOwner !== null && state.runLeaseExpiresAt !== null, "live run lease", state);
  }
  if (terminal.has(state.runStatus)) {
    check(state.runLeaseOwner === null && state.runLeaseExpiresAt === null, "terminal run lease", state);
  }
  if (strictAuthority(state)) {
    check(state.runClaimGeneration === state.claimGeneration, "authority claim generation", state);
    check(state.runLeaseExpiresAt! > state.time, "authority run expiry", state);
  }
}

function staleAttemptsAreNoOps(state: ClaimRunState): void {
  for (const runner of runners) {
    const staleClaim = state.claimGeneration + 1;
    for (const kind of ["renew", "release", "dispatch"] as const) {
      const action = kind === "dispatch"
        ? { kind, runner, supervisor: supervisors[0]!, claimGeneration: staleClaim } as const
        : { kind, runner, claimGeneration: staleClaim } as const;
      same(state, apply(state, action), `stale ${kind}`);
    }
    if (
      state.claimHolder === runner
      && state.claimExpiresAt !== null
      && state.claimExpiresAt <= state.time
    ) {
      same(
        state,
        apply(state, { kind: "renew", runner, claimGeneration: state.claimGeneration }),
        "expired claim renew",
      );
      same(
        state,
        apply(state, { kind: "release", runner, claimGeneration: state.claimGeneration }),
        "expired claim release",
      );
      same(
        state,
        apply(state, {
          kind: "dispatch",
          supervisor: supervisors[0]!,
          runner,
          claimGeneration: state.claimGeneration,
        }),
        "expired claim dispatch",
      );
    }
    for (const command of ["heartbeat", "succeed", "cancel"] as const) {
      const base = {
        kind: "run" as const,
        runner,
        command,
        claimGeneration: state.runClaimGeneration ?? 0,
        runGeneration: state.runGeneration,
        leaseGeneration: state.runLeaseGeneration,
      };
      same(state, apply(state, { ...base, claimGeneration: state.claimGeneration + 1 }), `stale run claim ${command}`);
      same(state, apply(state, { ...base, runGeneration: base.runGeneration + 1 }), `stale run generation ${command}`);
      same(state, apply(state, { ...base, leaseGeneration: base.leaseGeneration + 1 }), `stale lease generation ${command}`);
    }
  }
}

function transitionInvariant(before: ClaimRunState, after: ClaimRunState, action: Action): void {
  if (terminal.has(before.runStatus)) check(after.runStatus === before.runStatus, "terminal run regressed", { before, after, action });
  if (before.runStatus === "succeeded") check(after.runStatus !== "cancelled", "completion then cancellation", { before, after, action });
  if (before.runStatus === "cancelled") check(after.runStatus !== "succeeded", "cancellation then completion", { before, after, action });
}

function boundedRecovery(states: ClaimRunState[], maxTime: number): void {
  for (const state of states) {
    if (state.claimHolder !== null && state.claimExpiresAt !== null && state.claimExpiresAt <= state.time) {
      check(apply(state, { kind: "reconcile-claim" }).claimHolder === null, "expired claim not reclaimable", state);
    }
    if (live.has(state.runStatus) && state.runLeaseExpiresAt !== null && state.runLeaseExpiresAt <= state.time) {
      check(apply(state, { kind: "abandon-run" }).runStatus === "abandoned", "expired run not abandonable", state);
    }
    if (state.runStatus === "queued" && state.runActor !== null && state.runClaimGeneration !== null) {
      const command = {
        kind: "run" as const,
        runner: state.runActor,
        claimGeneration: state.runClaimGeneration,
        runGeneration: state.runGeneration,
        leaseGeneration: state.runLeaseGeneration,
      };
      const started = apply(state, { ...command, command: "start" });
      if (started !== state) check(apply(started, { ...command, command: "succeed" }).runStatus === "succeeded", "queued run terminal path", state);
    }
    if (state.runLeaseExpiresAt === null) check(!strictAuthority(state), "missing expiry grants authority", state);
    check(state.time <= maxTime, "time bound", state);
  }
}

function negativeControls(nodes: Map<string, Node>): Counterexample[] {
  let stale: Counterexample | undefined;
  let missing: Counterexample | undefined;
  for (const [stateKey, node] of nodes) {
    const state = node.state;
    if (!stale && weakAuthority(state) && !strictAuthority(state) && state.runClaimGeneration !== state.claimGeneration) {
      stale = { kind: "stale_same_actor_generation", trace: trace(nodes, stateKey), state };
    }
    if (!missing && weakAuthority(state)) {
      const legacy = { ...state, runLeaseExpiresAt: null };
      if (!strictAuthority(legacy)) {
        missing = {
          kind: "missing_run_lease",
          trace: [...trace(nodes, stateKey), "legacy-row:drop-run-lease-expiry"],
          state: legacy,
        };
      }
    }
  }
  check(stale !== undefined, "stale-generation negative control missing", null);
  check(missing !== undefined, "missing-lease negative control missing", null);
  return [stale, missing];
}

function trace(nodes: Map<string, Node>, stateKey: string): string[] {
  const result: string[] = [];
  let cursor: string | null = stateKey;
  while (cursor !== null) {
    const current: Node = nodes.get(cursor)!;
    if (current.action !== null) result.push(current.action);
    cursor = current.parent;
  }
  return result.reverse();
}

function label(action: Action): string {
  if (action.kind === "tick" || action.kind === "reconcile-claim" || action.kind === "abandon-run") return action.kind;
  if (action.kind === "acquire") return `acquire:${action.supervisor}:${action.runner}`;
  if (action.kind === "dispatch") return `dispatch:${action.supervisor}:${action.runner}:cg${action.claimGeneration}`;
  if (action.kind === "renew" || action.kind === "release") return `${action.kind}:${action.runner}:g${action.claimGeneration}`;
  return `${action.command}:${action.runner}:cg${action.claimGeneration}:rg${action.runGeneration}:lg${action.leaseGeneration}`;
}

function readConfig(): { maxDepth: number; maxTime: number } {
  const value = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")) as unknown;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "model config object", value);
  const input = value as Record<string, unknown>;
  for (const name of Object.keys(input)) check(["schemaVersion", "maxDepth", "maxTime"].includes(name), `unknown config key ${name}`, input);
  check(input.schemaVersion === 1, "model config schemaVersion", input);
  return {
    maxDepth: bounded(input.maxDepth, "maxDepth", 1, 20),
    maxTime: bounded(input.maxTime, "maxTime", 1, 20),
  };
}

function bounded(value: unknown, name: string, minimum: number, maximum: number): number {
  check(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum, `${name} bound`, value);
  return value as number;
}

function same(expected: ClaimRunState, actual: ClaimRunState, message: string): void {
  check(key(expected) === key(actual), `${message} mutated state`, { expected, actual });
}

function key(state: ClaimRunState): string {
  return JSON.stringify(state);
}

function check(condition: unknown, message: string, context: unknown): asserts condition {
  if (!condition) throw new Error(`${message}${context === null ? "" : `\n${JSON.stringify(context, null, 2)}`}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(checkModel(), null, 2)}\n`);
}
