import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actions, actionLabel, apply, initial, runners, same, stateKey, supervisors,
  type Bounds, type Node,
} from "./domain.ts";
import {
  checkLiveness, checkState, durableEqual, finish, negativeControls, observations,
  probeFences, probeTerminal, type Counterexample, type InvariantName, type LivenessName,
} from "./properties.ts";

export interface PromiseWakeupModelConfig extends Bounds { schemaVersion: 1 }
export interface PromiseWakeupModelReport {
  model: "promise-wakeup"; schemaVersion: 1; checker: "stensibly-explicit-state"; checkerVersion: "2";
  bounds: Bounds & { supervisors: number; runners: number; projects: number; producerItems: 1; consumerItems: 1 };
  exploration: { reachableStates: number; exploredTransitions: number; maximumDepthReached: number };
  invariants: Record<InvariantName, "passed">;
  boundedLiveness: Record<LivenessName, "passed">;
  negativeControls: Counterexample[];
}
let cachedConfig: PromiseWakeupModelConfig | undefined;

export function checkPromiseWakeupModel(options: Partial<Bounds> = {}): PromiseWakeupModelReport {
  const defaults = needsDefaults(options) ? defaultConfig() : undefined;
  const bounds: Bounds = {
    maxDepth: bounded(options.maxDepth ?? defaults!.maxDepth, "maxDepth", 1, 14),
    maxTime: bounded(options.maxTime ?? defaults!.maxTime, "maxTime", 1, 12),
    maxPromiseGeneration: bounded(options.maxPromiseGeneration ?? defaults!.maxPromiseGeneration, "maxPromiseGeneration", 1, 4),
    maxConsumerGeneration: bounded(options.maxConsumerGeneration ?? defaults!.maxConsumerGeneration, "maxConsumerGeneration", 1, 4),
    recoveryHorizonTicks: bounded(options.recoveryHorizonTicks ?? defaults!.recoveryHorizonTicks, "recoveryHorizonTicks", 1, 8),
  };
  const seen = observations();
  const first = stateKey(initial);
  const nodes = new Map<string, Node>([[first, { state: initial, parent: null, action: null, depth: 0 }]]);
  const queue = [first]; let exploredTransitions = 0, maximumDepthReached = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentKey = queue[cursor]!; const node = nodes.get(currentKey)!;
    maximumDepthReached = Math.max(maximumDepthReached, node.depth);
    checkState(node.state, seen); probeFences(node.state, seen); probeTerminal(node.state, seen);
    if (node.depth >= bounds.maxDepth) continue;
    for (const action of actions(node.state, bounds)) {
      const next = apply(node.state, action); if (next === node.state) continue;
      exploredTransitions += 1;
      if (action.kind !== "tick" && action.kind !== "restart") { seen.sawDuplicateTransition = true; same(next, apply(next, action), `duplicate ${actionLabel(action)}`); }
      if (action.kind === "restart") durableEqual(node.state, next);
      const nextKey = stateKey(next); if (nodes.has(nextKey)) continue;
      nodes.set(nextKey, { state: next, parent: currentKey, action: actionLabel(action), depth: node.depth + 1 }); queue.push(nextKey);
    }
  }
  checkLiveness([...nodes.values()].map((entry) => entry.state), bounds, seen);
  const properties = finish(seen);
  return {
    model: "promise-wakeup", schemaVersion: 1, checker: "stensibly-explicit-state", checkerVersion: "2",
    bounds: {
      ...bounds,
      supervisors: supervisors.length,
      runners: runners.length,
      projects: new Set([initial.project]).size,
      producerItems: 1,
      consumerItems: 1,
    },
    exploration: { reachableStates: nodes.size, exploredTransitions, maximumDepthReached },
    invariants: properties.invariants, boundedLiveness: properties.boundedLiveness,
    negativeControls: negativeControls(nodes),
  };
}

function needsDefaults(options: Partial<Bounds>): boolean {
  return options.maxDepth === undefined || options.maxTime === undefined || options.maxPromiseGeneration === undefined
    || options.maxConsumerGeneration === undefined || options.recoveryHorizonTicks === undefined;
}
function bounded(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function defaultConfig(): PromiseWakeupModelConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = assertPromiseWakeupModelConfig(JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")) as unknown);
  return cachedConfig;
}
export function assertPromiseWakeupModelConfig(input: unknown): PromiseWakeupModelConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Model config must be an object");
  const value = input as Record<string, unknown>;
  const expected = ["schemaVersion", "maxDepth", "maxTime", "maxPromiseGeneration", "maxConsumerGeneration", "recoveryHorizonTicks"];
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new Error(`Unknown model config keys: ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("Model config schemaVersion must be 1");
  return {
    schemaVersion: 1,
    maxDepth: bounded(Number(value.maxDepth), "maxDepth", 1, 14),
    maxTime: bounded(Number(value.maxTime), "maxTime", 1, 12),
    maxPromiseGeneration: bounded(Number(value.maxPromiseGeneration), "maxPromiseGeneration", 1, 4),
    maxConsumerGeneration: bounded(Number(value.maxConsumerGeneration), "maxConsumerGeneration", 1, 4),
    recoveryHorizonTicks: bounded(Number(value.recoveryHorizonTicks), "recoveryHorizonTicks", 1, 8),
  };
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(checkPromiseWakeupModel(), null, 2)}\n`);
}
