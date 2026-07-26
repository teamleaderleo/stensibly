import { readFileSync } from "node:fs";

type Supervisor = "supervisor-a" | "supervisor-b";
type Runner = "runner-a" | "runner-b";
type RunStatus = "none" | "queued" | "running" | "waiting" | "blocked"
  | "succeeded" | "failed" | "cancelled" | "abandoned";
type Terminal = "succeeded" | "failed" | "cancelled" | "abandoned";
type ModelFault = "actor_only_authority";

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
  reachable: boolean;
  trace: string[];
  state: ClaimRunState;
}

export interface ClaimRunModelConfig {
  schemaVersion: 1;
  maxDepth: number;
  maxTime: number;
  recoveryHorizonTicks: number;
}

const invariantNames = [
  "coherent_claim",
  "coherent_run",
  "stale_claim_fence_no_effect",
  "stale_run_fence_no_effect",
  "expired_authority_no_effect",
  "duplicate_delivery_at_most_one_effect",
  "terminal_run_no_regression",
  "completion_cancel_exclusive",
  "current_dispatch_authority_exact_claim_generation",
  "missing_expiry_never_grants_authority",
] as const;
const boundedLivenessNames = [
  "expired_claim_reclaimable",
  "expired_run_abandonable",
  "queued_run_reaches_terminal_or_abandoned_within_recovery_horizon",
] as const;
type InvariantName = typeof invariantNames[number];
type BoundedLivenessName = typeof boundedLivenessNames[number];

export interface ModelReport {
  model: "claim-run";
  schemaVersion: 1;
  checker: "stensibly-explicit-state";
  checkerVersion: "2";
  bounds: {
    maxDepth: number;
    maxTime: number;
    recoveryHorizonTicks: number;
    supervisors: 2;
    runners: 2;
    items: 1;
    runs: 1;
  };
  exploration: {
    reachableStates: number;
    exploredTransitions: number;
    maximumDepthReached: number;
  };
  invariants: Record<InvariantName, "passed">;
  boundedLiveness: Record<BoundedLivenessName, "passed">;
  negativeControls: Counterexample[];
}

type Command = "start" | "wait" | "block" | "heartbeat" | "succeed" | "fail" | "cancel";
type Action =
  | { kind: "tick" }
  | { kind: "acquire"; supervisor: Supervisor; runner: Runner }
  | { kind: "renew"; runner: Runner; claimGeneration: number }
  | { kind: "release"; runner: Runner; claimGeneration: number }
  | { kind: "dispatch"; supervisor: Supervisor; runner: Runner; claimGeneration: number }
  | {
      kind: "run";
      runner: Runner;
      claimGeneration: number;
      runGeneration: number;
      leaseGeneration: number;
      command: Command;
    }
  | { kind: "reconcile-claim" }
  | { kind: "abandon-run" };

type Node = {
  state: ClaimRunState;
  parent: string | null;
  action: string | null;
  depth: number;
};

interface Observations {
  sawOlderClaimProbe: boolean;
  sawLiveRunProbe: boolean;
  sawOlderLeaseProbe: boolean;
  sawExpiredClaim: boolean;
  sawExpiredRun: boolean;
  sawDuplicateTransition: boolean;
  sawTerminal: boolean;
  sawSucceeded: boolean;
  sawCancelled: boolean;
  sawStaleAuthorityCandidate: boolean;
  sawMissingLeaseProbe: boolean;
  sawQueuedRun: boolean;
}

class Coverage {
  readonly invariants = new Set<InvariantName>();
  readonly boundedLiveness = new Set<BoundedLivenessName>();

  markInvariant(name: InvariantName): void {
    this.invariants.add(name);
  }

  markLiveness(name: BoundedLivenessName): void {
    this.boundedLiveness.add(name);
  }

  finish(observations: Observations): {
    invariants: Record<InvariantName, "passed">;
    boundedLiveness: Record<BoundedLivenessName, "passed">;
  } {
    if (observations.sawOlderClaimProbe) {
      this.markInvariant("stale_claim_fence_no_effect");
    }
    if (observations.sawLiveRunProbe && observations.sawOlderLeaseProbe) {
      this.markInvariant("stale_run_fence_no_effect");
    }
    if (observations.sawExpiredClaim && observations.sawExpiredRun) {
      this.markInvariant("expired_authority_no_effect");
    }
    if (observations.sawDuplicateTransition) {
      this.markInvariant("duplicate_delivery_at_most_one_effect");
    }
    if (observations.sawTerminal) {
      this.markInvariant("terminal_run_no_regression");
    }
    if (observations.sawSucceeded && observations.sawCancelled) {
      this.markInvariant("completion_cancel_exclusive");
    }
    if (observations.sawStaleAuthorityCandidate) {
      this.markInvariant("current_dispatch_authority_exact_claim_generation");
    }
    if (observations.sawMissingLeaseProbe) {
      this.markInvariant("missing_expiry_never_grants_authority");
    }
    if (observations.sawQueuedRun) {
      this.markLiveness(
        "queued_run_reaches_terminal_or_abandoned_within_recovery_horizon",
      );
    }

    requireCoverage(invariantNames, this.invariants, "invariant");
    requireCoverage(boundedLivenessNames, this.boundedLiveness, "bounded liveness");
    return {
      invariants: report(invariantNames, this.invariants),
      boundedLiveness: report(boundedLivenessNames, this.boundedLiveness),
    };
  }
}

const supervisors: Supervisor[] = ["supervisor-a", "supervisor-b"];
const runners: Runner[] = ["runner-a", "runner-b"];
const live = new Set<RunStatus>(["queued", "running", "waiting", "blocked"]);
const terminal = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
]);
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
let cachedConfig: ClaimRunModelConfig | undefined;

export function checkModel(
  options: Partial<Omit<ClaimRunModelConfig, "schemaVersion">> = {},
): ModelReport {
  return runModel(options, null);
}

export function checkModelWithFaultForTest(
  fault: ModelFault,
  options: Partial<Omit<ClaimRunModelConfig, "schemaVersion">> = {},
): ModelReport {
  return runModel(options, fault);
}

function runModel(
  options: Partial<Omit<ClaimRunModelConfig, "schemaVersion">>,
  fault: ModelFault | null,
): ModelReport {
  const needsDefaults = options.maxDepth === undefined
    || options.maxTime === undefined
    || options.recoveryHorizonTicks === undefined;
  const defaults = needsDefaults ? defaultConfig() : undefined;
  const maxDepth = bounded(
    options.maxDepth ?? defaults!.maxDepth,
    "maxDepth",
    1,
    20,
  );
  const maxTime = bounded(
    options.maxTime ?? defaults!.maxTime,
    "maxTime",
    1,
    20,
  );
  const recoveryHorizonTicks = bounded(
    options.recoveryHorizonTicks ?? defaults!.recoveryHorizonTicks,
    "recoveryHorizonTicks",
    1,
    20,
  );

  const coverage = new Coverage();
  const observations: Observations = {
    sawOlderClaimProbe: false,
    sawLiveRunProbe: false,
    sawOlderLeaseProbe: false,
    sawExpiredClaim: false,
    sawExpiredRun: false,
    sawDuplicateTransition: false,
    sawTerminal: false,
    sawSucceeded: false,
    sawCancelled: false,
    sawStaleAuthorityCandidate: false,
    sawMissingLeaseProbe: false,
    sawQueuedRun: false,
  };
  const first = key(initial);
  const nodes = new Map<string, Node>([[
    first,
    { state: initial, parent: null, action: null, depth: 0 },
  ]]);
  const queue = [first];
  let exploredTransitions = 0;
  let maximumDepthReached = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentKey = queue[cursor]!;
    const node = nodes.get(currentKey)!;
    maximumDepthReached = Math.max(maximumDepthReached, node.depth);
    checkState(node.state, coverage, observations, fault);
    staleAndExpiredAttemptsAreNoOps(node.state, observations);
    terminalAttemptsPreserveOutcome(node.state, maxTime, observations);
    if (node.depth >= maxDepth) continue;

    for (const action of actions(node.state, maxTime)) {
      const next = apply(node.state, action);
      if (next === node.state) continue;
      exploredTransitions += 1;
      if (action.kind !== "tick") {
        observations.sawDuplicateTransition = true;
        same(next, apply(next, action), `duplicate ${label(action)}`);
      }
      const nextKey = key(next);
      if (nodes.has(nextKey)) continue;
      nodes.set(nextKey, {
        state: next,
        parent: currentKey,
        action: label(action),
        depth: node.depth + 1,
      });
      queue.push(nextKey);
    }
  }

  const states = [...nodes.values()].map((entry) => entry.state);
  boundedRecovery(
    states,
    maxTime,
    recoveryHorizonTicks,
    coverage,
    observations,
  );
  const propertyReports = coverage.finish(observations);
  return {
    model: "claim-run",
    schemaVersion: 1,
    checker: "stensibly-explicit-state",
    checkerVersion: "2",
    bounds: {
      maxDepth,
      maxTime,
      recoveryHorizonTicks,
      supervisors: 2,
      runners: 2,
      items: 1,
      runs: 1,
    },
    exploration: {
      reachableStates: nodes.size,
      exploredTransitions,
      maximumDepthReached,
    },
    invariants: propertyReports.invariants,
    boundedLiveness: propertyReports.boundedLiveness,
    negativeControls: negativeControls(nodes),
  };
}

function actions(state: ClaimRunState, maxTime: number): Action[] {
  const output: Action[] = state.time < maxTime ? [{ kind: "tick" }] : [];
  for (const supervisor of supervisors) {
    for (const runner of runners) {
      output.push({ kind: "acquire", supervisor, runner });
      output.push({
        kind: "dispatch",
        supervisor,
        runner,
        claimGeneration: state.claimGeneration,
      });
    }
  }
  for (const runner of runners) {
    output.push({
      kind: "renew",
      runner,
      claimGeneration: state.claimGeneration,
    });
    output.push({
      kind: "release",
      runner,
      claimGeneration: state.claimGeneration,
    });
    for (
      const command of [
        "start",
        "wait",
        "block",
        "heartbeat",
        "succeed",
        "fail",
        "cancel",
      ] as const
    ) {
      output.push(runAction(state, runner, command));
    }
  }
  output.push({ kind: "reconcile-claim" }, { kind: "abandon-run" });
  return output;
}

function apply(state: ClaimRunState, action: Action): ClaimRunState {
  if (action.kind === "tick") return { ...state, time: state.time + 1 };
  if (action.kind === "reconcile-claim") {
    if (
      state.claimHolder === null
      || state.claimExpiresAt === null
      || state.claimExpiresAt > state.time
    ) {
      return state;
    }
    return clearClaim(
      state,
      state.itemStatus === "active" ? "ready" : state.itemStatus,
    );
  }
  if (action.kind === "abandon-run") {
    if (
      !live.has(state.runStatus)
      || state.runLeaseExpiresAt === null
      || state.runLeaseExpiresAt > state.time
    ) {
      return state;
    }
    return {
      ...state,
      runStatus: "abandoned",
      runLeaseOwner: null,
      runLeaseExpiresAt: null,
    };
  }
  if (action.kind === "acquire") {
    if (["succeeded", "cancelled"].includes(state.itemStatus)) return state;
    if (
      state.claimHolder !== null
      && state.claimExpiresAt !== null
      && state.claimExpiresAt > state.time
    ) {
      return state;
    }
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
    return clearClaim(
      state,
      state.itemStatus === "active" ? "ready" : state.itemStatus,
    );
  }
  if (action.kind === "dispatch") {
    if (
      !currentClaim(state, action.runner, action.claimGeneration)
      || state.runStatus !== "none"
    ) {
      return state;
    }
    return {
      ...state,
      runStatus: "queued",
      runActor: action.runner,
      runClaimGeneration: state.claimGeneration,
      runGeneration: state.runGeneration + 1,
      runLeaseGeneration: state.runLeaseGeneration + 1,
      runLeaseOwner: action.runner,
      runLeaseExpiresAt: state.time + 3,
    };
  }

  if (!currentRun(state, action)) return state;
  if (action.command === "heartbeat") {
    return {
      ...state,
      runLeaseGeneration: state.runLeaseGeneration + 1,
      runLeaseExpiresAt: state.time + 3,
    };
  }
  if (action.command === "start") {
    return state.runStatus === "queued"
      ? { ...state, runStatus: "running" }
      : state;
  }
  if (action.command === "wait") {
    return state.runStatus === "running" || state.runStatus === "blocked"
      ? { ...state, runStatus: "waiting" }
      : state;
  }
  if (action.command === "block") {
    return state.runStatus === "running" || state.runStatus === "waiting"
      ? { ...state, runStatus: "blocked" }
      : state;
  }
  const status: Terminal = action.command === "succeed"
    ? "succeeded"
    : action.command === "cancel"
    ? "cancelled"
    : "failed";
  const itemStatus = status === "succeeded"
    ? "succeeded"
    : status === "cancelled"
    ? "cancelled"
    : "ready";
  return {
    ...clearClaim(state, itemStatus),
    runStatus: status,
    runLeaseOwner: null,
    runLeaseExpiresAt: null,
  };
}

function clearClaim(
  state: ClaimRunState,
  itemStatus: ClaimRunState["itemStatus"],
): ClaimRunState {
  return {
    ...state,
    itemStatus,
    claimHolder: null,
    claimGeneration: state.claimGeneration + 1,
    claimExpiresAt: null,
  };
}

function currentClaim(
  state: ClaimRunState,
  runner: Runner,
  generation: number,
): boolean {
  return state.claimHolder === runner
    && state.claimGeneration === generation
    && state.claimExpiresAt !== null
    && state.claimExpiresAt > state.time;
}

function currentRun(
  state: ClaimRunState,
  action: Extract<Action, { kind: "run" }>,
): boolean {
  return live.has(state.runStatus)
    && currentClaim(state, action.runner, action.claimGeneration)
    && state.runActor === action.runner
    && state.runLeaseOwner === action.runner
    && state.runGeneration === action.runGeneration
    && state.runLeaseGeneration === action.leaseGeneration
    && state.runLeaseExpiresAt !== null
    && state.runLeaseExpiresAt > state.time;
}

function weakAuthority(state: ClaimRunState): boolean {
  return state.itemStatus === "active"
    && state.claimHolder !== null
    && live.has(state.runStatus)
    && state.runActor === state.claimHolder;
}

function authorityGranted(
  state: ClaimRunState,
  fault: ModelFault | null,
): boolean {
  if (!weakAuthority(state)) return false;
  if (fault === "actor_only_authority") return true;
  return state.claimExpiresAt !== null
    && state.claimExpiresAt > state.time
    && state.runClaimGeneration === state.claimGeneration
    && state.runLeaseOwner === state.claimHolder
    && state.runLeaseExpiresAt !== null
    && state.runLeaseExpiresAt > state.time;
}

function checkState(
  state: ClaimRunState,
  coverage: Coverage,
  observations: Observations,
  fault: ModelFault | null,
): void {
  check(
    (state.claimHolder === null) === (state.claimExpiresAt === null),
    "claim holder/expiry coherence",
    state,
  );
  coverage.markInvariant("coherent_claim");

  if (state.runStatus === "none") {
    check(
      state.runActor === null && state.runClaimGeneration === null,
      "empty run identity",
      state,
    );
    check(
      state.runLeaseOwner === null && state.runLeaseExpiresAt === null,
      "empty run lease",
      state,
    );
  }
  if (live.has(state.runStatus)) {
    check(
      state.runActor !== null && state.runClaimGeneration !== null,
      "live run identity",
      state,
    );
    check(
      state.runLeaseOwner !== null && state.runLeaseExpiresAt !== null,
      "live run lease",
      state,
    );
  }
  if (terminal.has(state.runStatus)) {
    check(
      state.runLeaseOwner === null && state.runLeaseExpiresAt === null,
      "terminal run lease",
      state,
    );
  }
  coverage.markInvariant("coherent_run");

  if (
    weakAuthority(state)
    && state.runClaimGeneration !== state.claimGeneration
  ) {
    check(
      !authorityGranted(state, fault),
      "authority accepted a stale claim generation",
      state,
    );
    observations.sawStaleAuthorityCandidate = true;
  }

  if (weakAuthority(state)) {
    const legacy = { ...state, runLeaseExpiresAt: null };
    check(
      !authorityGranted(legacy, fault),
      "authority accepted a live run with no lease expiry",
      legacy,
    );
    observations.sawMissingLeaseProbe = true;
  }

  if (authorityGranted(state, fault)) {
    check(
      state.runClaimGeneration === state.claimGeneration,
      "authority claim generation",
      state,
    );
    check(
      state.claimExpiresAt !== null && state.claimExpiresAt > state.time,
      "authority claim expiry",
      state,
    );
    check(
      state.runLeaseOwner === state.claimHolder,
      "authority lease owner",
      state,
    );
    check(
      state.runLeaseExpiresAt !== null
        && state.runLeaseExpiresAt > state.time,
      "authority run expiry",
      state,
    );
  }
}

function staleAndExpiredAttemptsAreNoOps(
  state: ClaimRunState,
  observations: Observations,
): void {
  for (const runner of runners) {
    for (const staleClaim of differentGenerations(state.claimGeneration)) {
      for (const kind of ["renew", "release", "dispatch"] as const) {
        const action: Action = kind === "dispatch"
          ? {
              kind,
              runner,
              supervisor: supervisors[0]!,
              claimGeneration: staleClaim,
            }
          : { kind, runner, claimGeneration: staleClaim };
        same(state, apply(state, action), `stale ${kind} g${staleClaim}`);
      }
      if (staleClaim < state.claimGeneration) {
        observations.sawOlderClaimProbe = true;
      }
    }

    if (
      state.claimHolder === runner
      && state.claimExpiresAt !== null
      && state.claimExpiresAt <= state.time
    ) {
      observations.sawExpiredClaim = true;
      same(
        state,
        apply(state, {
          kind: "renew",
          runner,
          claimGeneration: state.claimGeneration,
        }),
        "expired claim renew",
      );
      same(
        state,
        apply(state, {
          kind: "release",
          runner,
          claimGeneration: state.claimGeneration,
        }),
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
  }

  if (live.has(state.runStatus) && state.runActor !== null) {
    observations.sawLiveRunProbe = true;
    const exact = runAction(state, state.runActor, "heartbeat");
    for (const staleClaim of differentGenerations(state.claimGeneration)) {
      same(
        state,
        apply(state, { ...exact, claimGeneration: staleClaim }),
        `stale run claim g${staleClaim}`,
      );
    }
    for (const staleRun of differentGenerations(state.runGeneration)) {
      same(
        state,
        apply(state, { ...exact, runGeneration: staleRun }),
        `stale run generation g${staleRun}`,
      );
    }
    for (
      const staleLease of differentGenerations(state.runLeaseGeneration)
    ) {
      same(
        state,
        apply(state, { ...exact, leaseGeneration: staleLease }),
        `stale lease generation g${staleLease}`,
      );
      if (staleLease < state.runLeaseGeneration) {
        observations.sawOlderLeaseProbe = true;
      }
    }

    if (
      state.runLeaseExpiresAt !== null
      && state.runLeaseExpiresAt <= state.time
    ) {
      observations.sawExpiredRun = true;
      for (
        const command of ["heartbeat", "succeed", "cancel"] as const
      ) {
        same(
          state,
          apply(state, runAction(state, state.runActor, command)),
          `expired run ${command}`,
        );
      }
    }
  }
}

function terminalAttemptsPreserveOutcome(
  state: ClaimRunState,
  maxTime: number,
  observations: Observations,
): void {
  if (!terminal.has(state.runStatus)) return;
  observations.sawTerminal = true;
  if (state.runStatus === "succeeded") observations.sawSucceeded = true;
  if (state.runStatus === "cancelled") observations.sawCancelled = true;

  for (const action of actions(state, maxTime)) {
    const next = apply(state, action);
    check(
      next.runStatus === state.runStatus,
      "terminal run regressed",
      { state, action, next },
    );
  }

  if (
    state.runActor !== null
    && (state.runStatus === "succeeded" || state.runStatus === "cancelled")
  ) {
    const opposite = state.runStatus === "succeeded" ? "cancel" : "succeed";
    same(
      state,
      apply(state, runAction(state, state.runActor, opposite)),
      `${state.runStatus} then ${opposite}`,
    );
  }
}

function boundedRecovery(
  states: ClaimRunState[],
  maxTime: number,
  recoveryHorizonTicks: number,
  coverage: Coverage,
  observations: Observations,
): void {
  for (const state of states) {
    if (
      state.claimHolder !== null
      && state.claimExpiresAt !== null
      && state.claimExpiresAt <= state.time
    ) {
      check(
        apply(state, { kind: "reconcile-claim" }).claimHolder === null,
        "expired claim not reclaimable",
        state,
      );
      coverage.markLiveness("expired_claim_reclaimable");
    }
    if (
      live.has(state.runStatus)
      && state.runLeaseExpiresAt !== null
      && state.runLeaseExpiresAt <= state.time
    ) {
      check(
        apply(state, { kind: "abandon-run" }).runStatus === "abandoned",
        "expired run not abandonable",
        state,
      );
      coverage.markLiveness("expired_run_abandonable");
    }
    if (state.runStatus === "queued") {
      observations.sawQueuedRun = true;
      check(
        canReachTerminalOrAbandoned(
          state,
          recoveryHorizonTicks,
          maxTime + recoveryHorizonTicks,
        ),
        "queued run lacks a bounded terminal or abandonment path",
        { state, recoveryHorizonTicks },
      );
    }
    check(state.time <= maxTime, "time bound", state);
  }
}

function canReachTerminalOrAbandoned(
  initialState: ClaimRunState,
  horizon: number,
  timeCeiling: number,
): boolean {
  const queue = [{ state: initialState, depth: 0 }];
  const seen = new Set([key(initialState)]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]!;
    if (terminal.has(node.state.runStatus)) return true;
    if (node.depth >= horizon) continue;
    for (const action of recoveryActions(node.state, timeCeiling)) {
      const next = apply(node.state, action);
      if (next === node.state) continue;
      const nextKey = key(next);
      if (seen.has(nextKey)) continue;
      seen.add(nextKey);
      queue.push({ state: next, depth: node.depth + 1 });
    }
  }
  return false;
}

function recoveryActions(
  state: ClaimRunState,
  timeCeiling: number,
): Action[] {
  const output: Action[] = [
    { kind: "reconcile-claim" },
    { kind: "abandon-run" },
  ];
  if (state.time < timeCeiling) output.push({ kind: "tick" });
  if (state.runActor !== null) {
    output.push(
      runAction(state, state.runActor, "start"),
      runAction(state, state.runActor, "succeed"),
      runAction(state, state.runActor, "cancel"),
    );
  }
  return output;
}

function negativeControls(nodes: Map<string, Node>): Counterexample[] {
  let stale: Counterexample | undefined;
  let missing: Counterexample | undefined;
  for (const [stateKey, node] of nodes) {
    const state = node.state;
    if (
      !stale
      && weakAuthority(state)
      && state.runClaimGeneration !== state.claimGeneration
    ) {
      stale = {
        kind: "stale_same_actor_generation",
        reachable: true,
        trace: trace(nodes, stateKey),
        state,
      };
    }
    if (!missing && weakAuthority(state)) {
      missing = {
        kind: "missing_run_lease",
        reachable: false,
        trace: [
          ...trace(nodes, stateKey),
          "synthesized-legacy-state:drop-run-lease-expiry",
        ],
        state: { ...state, runLeaseExpiresAt: null },
      };
    }
  }
  check(stale !== undefined, "stale-generation negative control missing", null);
  check(missing !== undefined, "missing-lease negative control missing", null);
  return [stale, missing];
}

function runAction(
  state: ClaimRunState,
  runner: Runner,
  command: Command,
): Extract<Action, { kind: "run" }> {
  return {
    kind: "run",
    runner,
    command,
    claimGeneration: state.runClaimGeneration ?? state.claimGeneration,
    runGeneration: state.runGeneration,
    leaseGeneration: state.runLeaseGeneration,
  };
}

function differentGenerations(current: number): number[] {
  return [...new Set([Math.max(0, current - 1), current + 1])]
    .filter((generation) => generation !== current);
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
  if (
    action.kind === "tick"
    || action.kind === "reconcile-claim"
    || action.kind === "abandon-run"
  ) {
    return action.kind;
  }
  if (action.kind === "acquire") {
    return `acquire:${action.supervisor}:${action.runner}`;
  }
  if (action.kind === "dispatch") {
    return `dispatch:${action.supervisor}:${action.runner}:cg${action.claimGeneration}`;
  }
  if (action.kind === "renew" || action.kind === "release") {
    return `${action.kind}:${action.runner}:g${action.claimGeneration}`;
  }
  return `${action.command}:${action.runner}:cg${action.claimGeneration}:rg${action.runGeneration}:lg${action.leaseGeneration}`;
}

export function parseClaimRunConfig(value: unknown): ClaimRunModelConfig {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "model config object",
    value,
  );
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "maxDepth",
    "maxTime",
    "recoveryHorizonTicks",
  ]);
  for (const name of Object.keys(input)) {
    check(allowed.has(name), `unknown config key ${name}`, input);
  }
  check(input.schemaVersion === 1, "model config schemaVersion", input);
  return {
    schemaVersion: 1,
    maxDepth: bounded(input.maxDepth, "maxDepth", 1, 20),
    maxTime: bounded(input.maxTime, "maxTime", 1, 20),
    recoveryHorizonTicks: bounded(
      input.recoveryHorizonTicks,
      "recoveryHorizonTicks",
      1,
      20,
    ),
  };
}

function defaultConfig(): ClaimRunModelConfig {
  cachedConfig ??= parseClaimRunConfig(
    JSON.parse(
      readFileSync(new URL("./config.json", import.meta.url), "utf8"),
    ) as unknown,
  );
  return cachedConfig;
}

function bounded(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  check(
    Number.isSafeInteger(value)
      && (value as number) >= minimum
      && (value as number) <= maximum,
    `${name} bound`,
    value,
  );
  return value as number;
}

function report<const Name extends string>(
  expected: readonly Name[],
  observed: ReadonlySet<Name>,
): Record<Name, "passed"> {
  return Object.fromEntries(
    expected.map((name) => [name, observed.has(name) ? "passed" : undefined]),
  ) as Record<Name, "passed">;
}

function requireCoverage<const Name extends string>(
  expected: readonly Name[],
  observed: ReadonlySet<Name>,
  labelValue: string,
): void {
  for (const name of expected) {
    check(
      observed.has(name),
      `${labelValue} property was not exercised: ${name}`,
      { observed: [...observed] },
    );
  }
}

function same(
  expected: ClaimRunState,
  actual: ClaimRunState,
  message: string,
): void {
  check(
    key(expected) === key(actual),
    `${message} mutated state`,
    { expected, actual },
  );
}

function key(state: ClaimRunState): string {
  return JSON.stringify(state);
}

function check(
  condition: unknown,
  message: string,
  context: unknown,
): asserts condition {
  if (!condition) {
    throw new Error(
      `${message}${context === null ? "" : `\n${JSON.stringify(context, null, 2)}`}`,
    );
  }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(checkModel(), null, 2)}\n`);
}
