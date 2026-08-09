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
import type { StensiblyStore } from "./store.js";

interface WorkflowRow {
  project_id: string;
  external_id: string;
  idempotency_key: string;
  kind: string;
  request_sha256: string;
  state: string;
  revision: number;
  workflow_json: string;
  workflow_sha256: string;
  created_at: string;
  updated_at: string;
}

const initializedStores = new WeakSet<StensiblyStore>();

export class SqliteOperationWorkflowStore implements OperationWorkflowStore {
  readonly #store: StensiblyStore;

  constructor(store: StensiblyStore) {
    this.#store = store;
    ensureOperationWorkflowSchema(store);
  }

  async reserveOperationWorkflow(
    workflowInput: OperationWorkflow,
  ): Promise<OperationWorkflowReservation> {
    const requested = admitOperationWorkflow(workflowInput);
    requireInitial(requested);
    const transaction = this.#store.db.transaction(() => {
      const existing = this.#row(requested.project, requested.idempotencyKey);
      if (existing) {
        const workflow = storedWorkflow(existing);
        return Object.freeze({
          outcome: sameReservationRequest(workflow, requested) ? "replay" : "conflict",
          workflow,
        }) as OperationWorkflowReservation;
      }
      const idReuse = this.#store.db.query<WorkflowRow, [string]>(`
        SELECT project_id, external_id, idempotency_key, kind, request_sha256,
               state, revision, workflow_json, workflow_sha256, created_at, updated_at
        FROM operation_workflows
        WHERE external_id = ?1
      `).get(requested.id);
      if (idReuse) {
        if (idReuse.project_id !== requested.project) {
          return Object.freeze({
            outcome: "conflict",
            workflow: requested,
          }) as OperationWorkflowReservation;
        }
        return Object.freeze({
          outcome: "conflict",
          workflow: storedWorkflow(idReuse),
        }) as OperationWorkflowReservation;
      }
      this.#store.db.query(`
        INSERT INTO operation_workflows (
          external_id, project_id, idempotency_key, kind, request_sha256,
          state, revision, workflow_json, workflow_sha256, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).run(
        requested.id,
        requested.project,
        requested.idempotencyKey,
        requested.kind,
        requested.requestSha256,
        requested.state,
        requested.revision,
        canonicalOperationWorkflowJson(requested),
        fingerprintOperationWorkflow(requested),
        requested.createdAt,
        requested.updatedAt,
      );
      return Object.freeze({ outcome: "reserved", workflow: requested });
    });
    return transaction.immediate();
  }

  async transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow> {
    const { current, next } = assertOperationWorkflowTransition(input.current, input.next);
    const transaction = this.#store.db.transaction(() => {
      const row = this.#row(current.project, current.idempotencyKey);
      if (!row || row.workflow_sha256 !== fingerprintOperationWorkflow(current)) {
        throw new OperationWorkflowStorageError();
      }
      const result = this.#store.db.query(`
        UPDATE operation_workflows
        SET state = ?1,
            revision = ?2,
            workflow_json = ?3,
            workflow_sha256 = ?4,
            updated_at = ?5
        WHERE project_id = ?6
          AND idempotency_key = ?7
          AND revision = ?8
          AND workflow_sha256 = ?9
      `).run(
        next.state,
        next.revision,
        canonicalOperationWorkflowJson(next),
        fingerprintOperationWorkflow(next),
        next.updatedAt,
        current.project,
        current.idempotencyKey,
        current.revision,
        row.workflow_sha256,
      );
      if (result.changes !== 1) throw new OperationWorkflowStorageError();
      return next;
    });
    return transaction.immediate();
  }

  async getOperationWorkflow(
    project: string,
    idempotencyKey: string,
  ): Promise<OperationWorkflow | null> {
    const row = this.#row(exactProject(project), exactIdentifier(idempotencyKey));
    return row ? storedWorkflow(row) : null;
  }

  #row(project: string, idempotencyKey: string): WorkflowRow | null {
    return this.#store.db.query<WorkflowRow, [string, string]>(`
      SELECT project_id, external_id, idempotency_key, kind, request_sha256,
             state, revision, workflow_json, workflow_sha256, created_at, updated_at
      FROM operation_workflows
      WHERE project_id = ?1 AND idempotency_key = ?2
    `).get(project, idempotencyKey) ?? null;
  }
}

export function ensureOperationWorkflowSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS operation_workflows (
      external_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      workflow_json TEXT NOT NULL,
      workflow_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_operation_workflows_project_state_updated
      ON operation_workflows(project_id, state, updated_at);
  `);
  initializedStores.add(store);
}

export class OperationWorkflowStorageError extends Error {
  readonly code = "operation_workflow_storage_failed";

  constructor() {
    super("Operation workflow storage failed");
    this.name = "OperationWorkflowStorageError";
  }
}

function storedWorkflow(row: WorkflowRow): OperationWorkflow {
  const workflow = parseOperationWorkflowJson(row.workflow_json);
  if (
    workflow.project !== row.project_id
    || workflow.id !== row.external_id
    || workflow.idempotencyKey !== row.idempotency_key
    || workflow.kind !== row.kind
    || workflow.requestSha256 !== row.request_sha256
    || workflow.state !== row.state
    || workflow.revision !== row.revision
    || workflow.createdAt !== row.created_at
    || workflow.updatedAt !== row.updated_at
    || canonicalOperationWorkflowJson(workflow) !== row.workflow_json
    || fingerprintOperationWorkflow(workflow) !== row.workflow_sha256
  ) {
    throw new OperationWorkflowStorageError();
  }
  return workflow;
}

function requireInitial(workflow: OperationWorkflow): void {
  if (workflow.revision !== 1 || workflow.state !== "reserved" || workflow.steps.some((step) => step.state !== "planned")) {
    throw new RangeError("Operation workflow reservation must contain an untouched revision-one plan");
  }
}

function sameReservationRequest(left: OperationWorkflow, right: OperationWorkflow): boolean {
  return operationWorkflowStableRequestJson(left) === operationWorkflowStableRequestJson(right);
}

function exactProject(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Operation workflow project is invalid");
  }
  return value;
}

function exactIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)) {
    throw new RangeError("Operation workflow idempotency key is invalid");
  }
  return value;
}
