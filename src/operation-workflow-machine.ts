import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "./canonical-json.js";
import {
  admitOperationWorkflow,
  deriveOperationWorkflowState,
  recoveryForState,
} from "./operation-workflow-admission.js";
import type {
  OperationAuthorityFence,
  OperationCompensationDisposition,
  OperationWorkflow,
  OperationWorkflowKind,
  OperationWorkflowStep,
} from "./operation-workflow-contracts.js";

export interface BuildOperationWorkflowInput {
  id?: string;
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
  clientId: string;
  kind: OperationWorkflowKind;
  target: string;
  request: unknown;
  idempotencyKey: string;
  authorityFence: OperationAuthorityFence;
  steps: Array<{
    id?: string;
    kind: string;
    commandId?: string;
    providerIdempotencyKey?: string;
    command: unknown;
    compensation: {
      disposition: OperationCompensationDisposition;
      kind?: string;
      command?: unknown;
    };
  }>;
  now?: string;
}

export function buildOperationWorkflow(input: BuildOperationWorkflowInput): OperationWorkflow {
  const now = input.now ?? new Date().toISOString();
  const workflowId = input.id ?? `opw_${randomUUID()}`;
  return admitOperationWorkflow({
    version: 1,
    id: workflowId,
    revision: 1,
    project: input.project,
    itemId: input.itemId,
    runId: input.runId,
    actorId: input.actorId,
    clientId: input.clientId,
    kind: input.kind,
    target: input.target,
    requestSha256: sha256(stableJson(input.request)),
    idempotencyKey: input.idempotencyKey,
    state: "reserved",
    steps: input.steps.map((step, index) => ({
      id: step.id ?? `${workflowId}:step:${index + 1}`,
      ordinal: index + 1,
      kind: step.kind,
      commandId: step.commandId ?? `${workflowId}:command:${index + 1}`,
      commandSha256: sha256(stableJson(step.command)),
      providerIdempotencyKey: step.providerIdempotencyKey
        ?? `operation-step:${sha256(stableJson({
          project: input.project,
          idempotencyKey: input.idempotencyKey,
          ordinal: index + 1,
        })).slice(7, 39)}`,
      authorityFence: { ...input.authorityFence },
      state: "planned",
      reservedAt: null,
      settledAt: null,
      providerReceiptRef: null,
      beforeSha256: null,
      afterSha256: null,
      verificationSha256: null,
      errorCode: null,
      retry: "none",
      compensation: {
        disposition: step.compensation.disposition,
        kind: step.compensation.kind ?? null,
        commandSha256: step.compensation.command === undefined
          ? null
          : sha256(stableJson(step.compensation.command)),
        state: step.compensation.disposition === "irreversible" ? "unavailable" : "not_started",
        providerReceiptRef: null,
      },
    })),
    cancellationRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    recovery: { nextAction: "continue" },
  });
}

export function reserveOperationWorkflowStep(
  workflowInput: OperationWorkflow,
  stepId: string,
  reservedAt: string,
): OperationWorkflow {
  const workflow = admitOperationWorkflow(workflowInput);
  if (workflow.state === "waiting_reconciliation") {
    throw new RangeError("Operation workflow requires reconciliation before dispatch");
  }
  const index = workflow.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new RangeError("Operation workflow step does not exist");
  const step = workflow.steps[index]!;
  if (step.state !== "planned") throw new RangeError("Operation workflow step is not dispatchable");
  if (workflow.steps.slice(0, index).some((candidate) => candidate.state !== "verified")) {
    throw new RangeError("Operation workflow steps must dispatch in order");
  }
  if (workflow.steps.some((candidate) => candidate.state === "dispatch_reserved")) {
    throw new RangeError("Operation workflow already has an in-flight step");
  }
  return replaceStep(workflow, index, {
    ...step,
    state: "dispatch_reserved",
    reservedAt,
  }, reservedAt);
}

export function settleOperationWorkflowStep(
  workflowInput: OperationWorkflow,
  input:
    | {
      stepId: string;
      outcome: "verified";
      settledAt: string;
      providerReceiptRef: string;
      before: unknown;
      after: unknown;
      verification: unknown;
    }
    | {
      stepId: string;
      outcome: "pending_reconciliation" | "rejected";
      settledAt: string;
      providerReceiptRef?: string;
      errorCode: string;
    },
): OperationWorkflow {
  const workflow = admitOperationWorkflow(workflowInput);
  const index = workflow.steps.findIndex((step) => step.id === input.stepId);
  if (index < 0) throw new RangeError("Operation workflow step does not exist");
  const step = workflow.steps[index]!;
  if (step.state !== "dispatch_reserved" && !(step.state === "pending_reconciliation" && input.outcome !== "pending_reconciliation")) {
    throw new RangeError("Operation workflow step is not awaiting settlement");
  }
  const next: OperationWorkflowStep = input.outcome === "verified"
    ? {
      ...step,
      state: "verified",
      settledAt: input.settledAt,
      providerReceiptRef: input.providerReceiptRef,
      beforeSha256: sha256(stableJson(input.before)),
      afterSha256: sha256(stableJson(input.after)),
      verificationSha256: sha256(stableJson(input.verification)),
      errorCode: null,
      retry: "none",
    }
    : {
      ...step,
      state: input.outcome,
      settledAt: input.settledAt,
      providerReceiptRef: input.providerReceiptRef ?? null,
      errorCode: input.errorCode,
      retry: input.outcome === "pending_reconciliation" ? "reconcile_before_retry" : "none",
    };
  return replaceStep(workflow, index, next, input.settledAt);
}

function replaceStep(
  workflow: OperationWorkflow,
  index: number,
  step: OperationWorkflowStep,
  updatedAt: string,
): OperationWorkflow {
  const steps = workflow.steps.map((candidate, candidateIndex) => candidateIndex === index ? step : candidate);
  const state = deriveOperationWorkflowState(steps, workflow.cancellationRequestedAt !== null);
  const terminal = terminalStates.has(state);
  return admitOperationWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    state,
    steps,
    updatedAt,
    terminalAt: terminal ? updatedAt : null,
    recovery: { nextAction: recoveryForState(state) },
  });
}

const terminalStates = new Set([
  "succeeded", "compensated", "failed", "cancelled", "escalated",
]);
