import { sha256, stableJson } from "./canonical-json.js";
import {
  OperationWorkflowConflictError,
  type OperationWorkflow,
  type OperationWorkflowStore,
} from "./operation-workflow-contracts.js";
import { requestOperationWorkflowCancellation } from "./operation-workflow-machine.js";

export interface OperationWorkflowCancellationInput {
  project: string;
  workflowId: string;
  workflowIdempotencyKey: string;
  actorId: string;
  clientId: string;
  authorityGeneration: number;
}

export interface OperationWorkflowCancellationAuthorityInput {
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
  clientId: string;
  authorityGeneration: number;
}

export interface OperationWorkflowCancellationDependencies {
  workflows: OperationWorkflowStore;
  assertAuthority(input: OperationWorkflowCancellationAuthorityInput): Promise<void>;
  now?: () => string;
}

export interface OperationWorkflowCancellationResult {
  outcome: "admitted" | "replay";
  actionId: string;
  workflow: OperationWorkflow;
}

export class OperationWorkflowCancellationService {
  readonly #dependencies: OperationWorkflowCancellationDependencies;
  readonly #now: () => string;

  constructor(dependencies: OperationWorkflowCancellationDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async cancel(input: OperationWorkflowCancellationInput): Promise<OperationWorkflowCancellationResult> {
    const workflow = await this.#requiredWorkflow(input);
    await this.#assertCurrentAuthority(workflow, input);
    const actionId = operationWorkflowCancellationActionId(workflow, input);
    if (workflow.cancellationRequestedAt !== null) {
      return Object.freeze({ outcome: "replay", actionId, workflow });
    }
    if (workflow.terminalAt !== null) {
      throw terminalCancellationConflict();
    }

    const requestedAt = this.#now();
    try {
      return await this.#admit(workflow, input, actionId, requestedAt);
    } catch (firstError) {
      const reread = await this.#requiredWorkflow(input);
      await this.#assertCurrentAuthority(reread, input);
      if (reread.cancellationRequestedAt !== null) {
        return Object.freeze({
          outcome: "replay",
          actionId: operationWorkflowCancellationActionId(reread, input),
          workflow: reread,
        });
      }
      if (reread.terminalAt !== null) throw terminalCancellationConflict();

      // One bounded retry handles the symmetric CAS race where an in-flight provider
      // settlement commits immediately before cancellation. Re-derive cancellation
      // from the fresh durable workflow so completed evidence stays immutable and only
      // still-planned work becomes cancelled. Never loop or call a provider here.
      try {
        return await this.#admit(reread, input, actionId, requestedAt);
      } catch (retryError) {
        const finalRead = await this.#requiredWorkflow(input);
        await this.#assertCurrentAuthority(finalRead, input);
        if (finalRead.cancellationRequestedAt !== null) {
          return Object.freeze({
            outcome: "replay",
            actionId: operationWorkflowCancellationActionId(finalRead, input),
            workflow: finalRead,
          });
        }
        if (finalRead.terminalAt !== null) throw terminalCancellationConflict();
        throw retryError ?? firstError;
      }
    }
  }

  async #admit(
    workflow: OperationWorkflow,
    input: OperationWorkflowCancellationInput,
    actionId: string,
    requestedAt: string,
  ): Promise<OperationWorkflowCancellationResult> {
    const next = requestOperationWorkflowCancellation(workflow, requestedAt);
    const stored = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
    // The transition store re-admits the full aggregate. Rechecking attribution here
    // also prevents a malformed adapter from returning a different durable workflow.
    assertCancellationIdentity(stored, input);
    if (stored.cancellationRequestedAt !== requestedAt) {
      throw new OperationWorkflowConflictError("Operation workflow cancellation settlement conflicts with durable state");
    }
    return Object.freeze({ outcome: "admitted", actionId, workflow: stored });
  }

  async #requiredWorkflow(input: OperationWorkflowCancellationInput): Promise<OperationWorkflow> {
    const workflow = await this.#dependencies.workflows.getOperationWorkflow(
      exactProject(input.project),
      exactIdentifier(input.workflowIdempotencyKey, "workflow idempotency key", 240),
    );
    if (!workflow) throw new OperationWorkflowConflictError("Operation workflow does not exist");
    assertCancellationIdentity(workflow, input);
    return workflow;
  }

  async #assertCurrentAuthority(
    workflow: OperationWorkflow,
    input: OperationWorkflowCancellationInput,
  ): Promise<void> {
    await this.#dependencies.assertAuthority({
      project: workflow.project,
      itemId: workflow.itemId,
      runId: workflow.runId,
      actorId: input.actorId,
      clientId: input.clientId,
      authorityGeneration: input.authorityGeneration,
    });
  }
}

export function operationWorkflowCancellationActionId(
  workflow: OperationWorkflow,
  input: OperationWorkflowCancellationInput,
): string {
  assertCancellationIdentity(workflow, input);
  return `operation-workflow-cancel:${sha256(stableJson({
    version: 1,
    project: workflow.project,
    workflowId: workflow.id,
    workflowIdempotencyKey: workflow.idempotencyKey,
    actorId: workflow.actorId,
    clientId: workflow.clientId,
    authorityGeneration: input.authorityGeneration,
  })).slice(7, 39)}`;
}

function assertCancellationIdentity(
  workflow: OperationWorkflow,
  input: OperationWorkflowCancellationInput,
): void {
  const project = exactProject(input.project);
  const workflowId = exactIdentifier(input.workflowId, "workflow ID", 160);
  const workflowIdempotencyKey = exactIdentifier(
    input.workflowIdempotencyKey,
    "workflow idempotency key",
    240,
  );
  const actorId = exactIdentifier(input.actorId, "workflow actor ID", 160);
  const clientId = exactIdentifier(input.clientId, "workflow client ID", 240);
  const generation = positiveInteger(input.authorityGeneration, "authority generation");
  if (
    workflow.project !== project
    || workflow.id !== workflowId
    || workflow.idempotencyKey !== workflowIdempotencyKey
    || workflow.actorId !== actorId
    || workflow.clientId !== clientId
  ) {
    throw new OperationWorkflowConflictError("Operation workflow cancellation identity conflicts with durable state");
  }
  const resource = `run:${workflow.runId}:generation:${generation}`;
  for (const step of workflow.steps) {
    if (
      step.authorityFence.resource !== resource
      || step.authorityFence.holderId !== actorId
      || step.authorityFence.generation !== generation
    ) {
      throw new OperationWorkflowConflictError("Operation workflow cancellation authority conflicts with durable state");
    }
  }
}

function terminalCancellationConflict(): OperationWorkflowConflictError {
  return new OperationWorkflowConflictError("Terminal operation workflow cannot accept cancellation");
}

function exactProject(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new OperationWorkflowConflictError("Operation workflow cancellation project is invalid");
  }
  return value;
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new OperationWorkflowConflictError(`Operation workflow cancellation ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new OperationWorkflowConflictError(`Operation workflow cancellation ${label} is invalid`);
  }
  return Number(value);
}
