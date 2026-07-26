export type Supervisor = "supervisor-a" | "supervisor-b";
export type Runner = "runner-a" | "runner-b";
export type PromiseStatus = "none" | "pending" | "satisfied" | "missed" | "cancelled";
export type ConsumerStatus = "waiting" | "active" | "terminal";
export type WakeupStatus = "ready" | "consumed" | "escalated";
export type PromiseCommand = "satisfy" | "miss" | "cancel";
export type WeakRule = "identity_only_generation" | "consume_without_marker" | "terminal_race_without_fence";

export interface WakeupRecord {
  project: "alpha";
  promiseGeneration: number;
  consumerGeneration: number;
  resultRef: string;
  status: WakeupStatus;
  consumedByRunGeneration: number | null;
  consumedByRunner: Runner | null;
}
export interface State {
  project: "alpha";
  time: number;
  restarted: boolean;
  promiseGeneration: number;
  promiseStatus: PromiseStatus;
  promiseDeadline: number | null;
  promiseResultRef: string | null;
  consumerGeneration: number;
  consumerRunGeneration: number;
  consumerStatus: ConsumerStatus;
  wakeups: WakeupRecord[];
}
export interface Bounds {
  maxDepth: number;
  maxTime: number;
  maxPromiseGeneration: number;
  maxConsumerGeneration: number;
  recoveryHorizonTicks: number;
}
export type Action =
  | { kind: "tick" } | { kind: "restart" }
  | { kind: "create"; supervisor: Supervisor }
  | { kind: "supersede"; supervisor: Supervisor; expectedGeneration: number }
  | { kind: "promise"; supervisor: Supervisor; command: PromiseCommand; expectedGeneration: number }
  | { kind: "reconcile"; expectedGeneration: number }
  | { kind: "advance-consumer"; runner: Runner; expectedConsumerGeneration: number }
  | { kind: "complete-consumer"; runner: Runner; expectedConsumerGeneration: number; expectedRunGeneration: number }
  | { kind: "consume"; runner: Runner; expectedPromiseGeneration: number; expectedConsumerGeneration: number; expectedRunGeneration: number }
  | { kind: "escalate"; expectedPromiseGeneration: number; expectedConsumerGeneration: number };
export type Node = { state: State; parent: string | null; action: string | null; depth: number };

export const supervisors: readonly Supervisor[] = ["supervisor-a", "supervisor-b"];
export const runners: readonly Runner[] = ["runner-a", "runner-b"];
export const terminalPromises = new Set<PromiseStatus>(["satisfied", "missed", "cancelled"]);
export const initial: State = {
  project: "alpha", time: 0, restarted: false,
  promiseGeneration: 0, promiseStatus: "none", promiseDeadline: null, promiseResultRef: null,
  consumerGeneration: 1, consumerRunGeneration: 0, consumerStatus: "waiting", wakeups: [],
};

export function actions(state: State, bounds: Bounds): Action[] {
  const out: Action[] = state.time < bounds.maxTime ? [{ kind: "tick" }] : [];
  if (!state.restarted) out.push({ kind: "restart" });
  for (const supervisor of supervisors) {
    out.push({ kind: "create", supervisor });
    if (state.promiseGeneration < bounds.maxPromiseGeneration) {
      out.push({ kind: "supersede", supervisor, expectedGeneration: state.promiseGeneration });
    }
    for (const command of ["satisfy", "miss", "cancel"] as const) {
      out.push({ kind: "promise", supervisor, command, expectedGeneration: state.promiseGeneration });
    }
  }
  out.push({ kind: "reconcile", expectedGeneration: state.promiseGeneration });
  for (const runner of runners) {
    if (state.consumerGeneration < bounds.maxConsumerGeneration) {
      out.push({ kind: "advance-consumer", runner, expectedConsumerGeneration: state.consumerGeneration });
    }
    out.push({ kind: "complete-consumer", runner, expectedConsumerGeneration: state.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration });
    out.push({ kind: "consume", runner, expectedPromiseGeneration: state.promiseGeneration, expectedConsumerGeneration: state.consumerGeneration, expectedRunGeneration: state.consumerRunGeneration });
  }
  for (const wakeup of state.wakeups.filter((entry) => entry.status === "ready")) {
    out.push({ kind: "escalate", expectedPromiseGeneration: wakeup.promiseGeneration, expectedConsumerGeneration: wakeup.consumerGeneration });
  }
  return out;
}

export function apply(state: State, action: Action): State {
  if (action.kind === "tick") return { ...state, time: state.time + 1 };
  if (action.kind === "restart") return state.restarted ? state : { ...state, restarted: true };
  if (action.kind === "create") {
    if (state.promiseStatus !== "none") return state;
    return { ...state, promiseGeneration: 1, promiseStatus: "pending", promiseDeadline: state.time + 2, promiseResultRef: null };
  }
  if (action.kind === "supersede") {
    if (state.promiseStatus === "none" || state.promiseGeneration !== action.expectedGeneration) return state;
    return { ...state, promiseGeneration: state.promiseGeneration + 1, promiseStatus: "pending", promiseDeadline: state.time + 2, promiseResultRef: null };
  }
  if (action.kind === "promise") {
    if (!currentPending(state, action.expectedGeneration)) return state;
    if (action.command === "satisfy") return satisfy(state);
    return { ...state, promiseStatus: action.command === "miss" ? "missed" : "cancelled", promiseDeadline: null, promiseResultRef: null };
  }
  if (action.kind === "reconcile") {
    if (!currentPending(state, action.expectedGeneration) || state.promiseDeadline! > state.time) return state;
    return { ...state, promiseStatus: "missed", promiseDeadline: null, promiseResultRef: null };
  }
  if (action.kind === "advance-consumer") {
    if (state.consumerStatus === "terminal" || state.consumerGeneration !== action.expectedConsumerGeneration) return state;
    return { ...state, consumerGeneration: state.consumerGeneration + 1, consumerRunGeneration: state.consumerRunGeneration + 1, consumerStatus: "waiting" };
  }
  if (action.kind === "complete-consumer") {
    if (state.consumerStatus !== "active" || state.consumerGeneration !== action.expectedConsumerGeneration || state.consumerRunGeneration !== action.expectedRunGeneration) return state;
    return { ...state, consumerStatus: "terminal" };
  }
  const index = state.wakeups.findIndex((wakeup) =>
    wakeup.promiseGeneration === action.expectedPromiseGeneration
    && wakeup.consumerGeneration === action.expectedConsumerGeneration
    && wakeup.status === "ready"
  );
  if (index < 0) return state;
  if (action.kind === "escalate") return patchWakeup(state, index, { status: "escalated" });
  if (state.promiseGeneration !== action.expectedPromiseGeneration || state.promiseStatus !== "satisfied"
    || state.consumerGeneration !== action.expectedConsumerGeneration || state.consumerRunGeneration !== action.expectedRunGeneration
    || state.consumerStatus === "terminal") return state;
  const nextRun = state.consumerRunGeneration + 1;
  return patchWakeup({ ...state, consumerRunGeneration: nextRun, consumerStatus: "active" }, index, {
    status: "consumed", consumedByRunGeneration: nextRun, consumedByRunner: action.runner,
  });
}

function satisfy(state: State): State {
  const resultRef = `result-${state.promiseGeneration}`;
  const exists = state.wakeups.some((wakeup) => wakeup.promiseGeneration === state.promiseGeneration);
  const wakeups = exists ? state.wakeups : [...state.wakeups, {
    project: state.project, promiseGeneration: state.promiseGeneration,
    consumerGeneration: state.consumerGeneration, resultRef, status: "ready" as const,
    consumedByRunGeneration: null, consumedByRunner: null,
  }].sort((a, b) => a.promiseGeneration - b.promiseGeneration);
  return { ...state, promiseStatus: "satisfied", promiseDeadline: null, promiseResultRef: resultRef, wakeups };
}
function currentPending(state: State, generation: number): boolean {
  return state.promiseStatus === "pending" && state.promiseGeneration === generation && state.promiseDeadline !== null;
}
function patchWakeup(state: State, index: number, patch: Partial<WakeupRecord>): State {
  if (!state.wakeups[index]) return state;
  return { ...state, wakeups: state.wakeups.map((wakeup, position) => position === index ? { ...wakeup, ...patch } : wakeup) };
}

export function actionLabel(action: Action): string {
  if (action.kind === "promise") return `${action.command}:${action.supervisor}:p${action.expectedGeneration}`;
  if (action.kind === "supersede") return `supersede:${action.supervisor}:p${action.expectedGeneration}`;
  if (action.kind === "reconcile") return `reconcile:p${action.expectedGeneration}`;
  if (action.kind === "consume") return `consume:${action.runner}:p${action.expectedPromiseGeneration}:c${action.expectedConsumerGeneration}:r${action.expectedRunGeneration}`;
  if (action.kind === "advance-consumer") return `advance-consumer:${action.runner}:c${action.expectedConsumerGeneration}`;
  if (action.kind === "complete-consumer") return `complete-consumer:${action.runner}:c${action.expectedConsumerGeneration}:r${action.expectedRunGeneration}`;
  if (action.kind === "escalate") return `escalate:p${action.expectedPromiseGeneration}:c${action.expectedConsumerGeneration}`;
  if (action.kind === "create") return `create:${action.supervisor}`;
  return action.kind;
}
export function stateKey(state: State): string {
  return JSON.stringify({ ...state, wakeups: [...state.wakeups].sort((a, b) => a.promiseGeneration - b.promiseGeneration) });
}
export function same(before: State, after: State, context: string): void {
  if (stateKey(before) !== stateKey(after)) throw new Error(`${context} changed state\n${stateKey(before)}\n${stateKey(after)}`);
}
export function check(condition: unknown, message: string, state: State): asserts condition {
  if (!condition) throw new Error(`${message}\n${stateKey(state)}`);
}
