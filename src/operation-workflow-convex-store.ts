import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitOperationWorkflow,
  assertOperationWorkflowTransition,
  canonicalOperationWorkflowJson,
  fingerprintOperationWorkflow,
  operationWorkflowStableRequestJson,
  parseOperationWorkflowJson,
} from "./operation-workflow-admission.js";
import type {
  OperationWorkflow,
  OperationWorkflowReservation,
  OperationWorkflowStore,
} from "./operation-workflow-contracts.js";
import { OperationWorkflowStorageError } from "./operation-workflow-sqlite-store.js";

const reserveRef = makeFunctionReference<"mutation">("operationWorkflows:reserve");
const transitionRef = makeFunctionReference<"mutation">("operationWorkflows:transition");
const getRef = makeFunctionReference<"query">("operationWorkflows:get");

export interface ConvexOperationWorkflowStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexOperationWorkflowStore implements OperationWorkflowStore {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexOperationWorkflowStoreOptions) {
    this.#client = options.client;
    this.#serviceSecret = bounded(options.serviceSecret, "Convex service secret", 4_096);
    this.#workspace = slug(options.workspace ?? "default", "Workspace");
  }

  async reserveOperationWorkflow(
    workflowInput: OperationWorkflow,
  ): Promise<OperationWorkflowReservation> {
    const workflow = admitOperationWorkflow(workflowInput);
    if (workflow.revision !== 1 || workflow.state !== "reserved" || workflow.steps.some((step) => step.state !== "planned")) {
      throw new RangeError("Operation workflow reservation must contain an untouched revision-one plan");
    }
    const raw = await this.#client.mutation(reserveRef, this.#args({
      project: workflow.project,
      workflowJson: canonicalOperationWorkflowJson(workflow),
      workflowSha256: fingerprintOperationWorkflow(workflow),
      stableRequestJson: operationWorkflowStableRequestJson(workflow),
    }));
    const result = reservation(raw);
    if (result.outcome === "reserved" && canonicalOperationWorkflowJson(result.workflow) !== canonicalOperationWorkflowJson(workflow)) {
      throw new OperationWorkflowStorageError();
    }
    return result;
  }

  async transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow> {
    const { current, next } = assertOperationWorkflowTransition(input.current, input.next);
    const raw = await this.#client.mutation(transitionRef, this.#args({
      project: current.project,
      idempotencyKey: current.idempotencyKey,
      currentSha256: fingerprintOperationWorkflow(current),
      nextWorkflowJson: canonicalOperationWorkflowJson(next),
      nextWorkflowSha256: fingerprintOperationWorkflow(next),
    }));
    const stored = storedResult(raw);
    if (canonicalOperationWorkflowJson(stored) !== canonicalOperationWorkflowJson(next)) {
      throw new OperationWorkflowStorageError();
    }
    return stored;
  }

  async getOperationWorkflow(project: string, idempotencyKey: string): Promise<OperationWorkflow | null> {
    const raw = await this.#client.query(getRef, this.#args({
      project: slug(project, "Project"),
      idempotencyKey: bounded(idempotencyKey, "Operation workflow idempotency key", 240),
    }));
    return raw === null ? null : storedResult(raw);
  }

  #args(input: Record<string, unknown>): Record<string, unknown> {
    return { ...input, serviceSecret: this.#serviceSecret, workspace: this.#workspace };
  }
}

export function withConvexOperationWorkflowStore<T extends object>(
  target: T,
  options: ConvexOperationWorkflowStoreOptions,
): T & OperationWorkflowStore {
  const store = new ConvexOperationWorkflowStore(options);
  return Object.assign(target, {
    reserveOperationWorkflow: store.reserveOperationWorkflow.bind(store),
    transitionOperationWorkflow: store.transitionOperationWorkflow.bind(store),
    getOperationWorkflow: store.getOperationWorkflow.bind(store),
  });
}

function reservation(value: unknown): OperationWorkflowReservation {
  const record = exactRecord(value, ["outcome", "workflowJson", "workflowSha256"]);
  if (record.outcome !== "reserved" && record.outcome !== "replay" && record.outcome !== "conflict") {
    throw new OperationWorkflowStorageError();
  }
  return Object.freeze({ outcome: record.outcome, workflow: storedResult(record) });
}

function storedResult(value: unknown): OperationWorkflow {
  const record = exactRecord(value, ["workflowJson", "workflowSha256"], true);
  const workflow = parseOperationWorkflowJson(record.workflowJson);
  if (record.workflowSha256 !== fingerprintOperationWorkflow(workflow)) {
    throw new OperationWorkflowStorageError();
  }
  return workflow;
}

function exactRecord(value: unknown, keys: readonly string[], allowExtras = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationWorkflowStorageError();
  const record = value as Record<string, unknown>;
  if (!keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new OperationWorkflowStorageError();
  if (!allowExtras && Object.keys(record).length !== keys.length) throw new OperationWorkflowStorageError();
  return record;
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new RangeError(`${label} is invalid`);
  return value;
}

function slug(value: unknown, label: string): string {
  const text = bounded(value, label, 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(text)) throw new RangeError(`${label} is invalid`);
  return text;
}
