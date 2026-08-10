export const operationWorkflowKinds = ["github_publish_change", "github_land_pr"] as const;

export type OperationWorkflowKind = typeof operationWorkflowKinds[number];

export const operationWorkflowStates = [
  "reserved",
  "running",
  "waiting_reconciliation",
  "succeeded",
  "compensating",
  "compensated",
  "partially_completed",
  "failed",
  "cancelled",
  "escalated",
] as const;

export type OperationWorkflowState = typeof operationWorkflowStates[number];

export const operationWorkflowStepStates = [
  "planned",
  "dispatch_reserved",
  "verified",
  "rejected",
  "pending_reconciliation",
  "compensating",
  "compensated",
  "compensation_failed",
  "cancelled",
] as const;

export type OperationWorkflowStepState =
  typeof operationWorkflowStepStates[number];

export type OperationCompensationDisposition =
  | "reversible"
  | "conditionally_reversible"
  | "compensatable"
  | "irreversible";

export interface OperationAuthorityFence {
  resource: string;
  holderId: string;
  generation: number;
  expiresAt: string;
}

export interface OperationWorkflowStep {
  id: string;
  ordinal: number;
  kind: string;
  commandId: string;
  commandSha256: string;
  providerIdempotencyKey: string;
  authorityFence: OperationAuthorityFence;
  state: OperationWorkflowStepState;
  reservedAt: string | null;
  settledAt: string | null;
  providerReceiptRef: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  verificationSha256: string | null;
  errorCode: string | null;
  retry: "none" | "reconcile_before_retry";
  compensation: {
    disposition: OperationCompensationDisposition;
    kind: string | null;
    commandSha256: string | null;
    state: "not_started" | "reserved" | "succeeded" | "failed" | "unavailable";
    providerReceiptRef: string | null;
  };
}

/**
 * One bounded saga snapshot. Provider bodies, patches, prompts, tokens, and
 * arbitrary error prose are deliberately absent; the aggregate retains only
 * stable identities, digests, closed lifecycle state, and receipt references.
 */
export interface OperationWorkflow {
  version: 1;
  id: string;
  revision: number;
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
  clientId: string;
  kind: OperationWorkflowKind;
  target: string;
  requestSha256: string;
  idempotencyKey: string;
  state: OperationWorkflowState;
  steps: OperationWorkflowStep[];
  cancellationRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  recovery: {
    nextAction:
      | "continue"
      | "reconcile_current_step"
      | "compensate_completed_steps"
      | "manual_reconciliation"
      | "none";
  };
}

export interface OperationWorkflowReservation {
  outcome: "reserved" | "replay" | "conflict";
  workflow: OperationWorkflow;
}

export interface OperationWorkflowStore {
  reserveOperationWorkflow(
    workflow: OperationWorkflow,
  ): Promise<OperationWorkflowReservation>;
  transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow>;
  getOperationWorkflow(
    project: string,
    idempotencyKey: string,
  ): Promise<OperationWorkflow | null>;
}

export function operationWorkflowStore(value: unknown): OperationWorkflowStore | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<OperationWorkflowStore>;
  return typeof candidate.reserveOperationWorkflow === "function"
    && typeof candidate.transitionOperationWorkflow === "function"
    && typeof candidate.getOperationWorkflow === "function"
    ? candidate as OperationWorkflowStore
    : null;
}

export class OperationWorkflowConflictError extends Error {
  readonly code = "operation_workflow_conflict";

  constructor(message = "Operation workflow conflicts with durable state") {
    super(message);
    this.name = "OperationWorkflowConflictError";
  }
}

export class OperationWorkflowPendingReconciliationError extends Error {
  readonly code = "operation_workflow_pending_reconciliation";
  readonly workflow: OperationWorkflow;

  constructor(workflow: OperationWorkflow) {
    super("Operation workflow requires reconciliation before another provider dispatch");
    this.name = "OperationWorkflowPendingReconciliationError";
    this.workflow = workflow;
  }
}
