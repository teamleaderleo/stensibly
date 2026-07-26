import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import {
  parseExecutionEnvelope,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import type { ActorInput } from "./schemas.js";
import {
  dispatchNextWork,
  ensureDispatchSchema,
  type DispatchResult,
} from "./dispatcher.js";
import {
  ensureContinuationSchema,
  getContinuation,
  listContinuations,
  resolveContinuation,
  type ContinuationProposal,
} from "./continuations.js";
import { getWorkRun } from "./runs.js";
import {
  ConflictError,
  type Item,
  type StensiblyStore,
} from "./store.js";

export interface QueueContinuationForSupervisorInput {
  id: string;
  actor: ActorInput;
  supervisor: ActorInput;
  expectedGeneration: number;
  runnerType: string;
  runnerProfile: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  executionEnvelope?: ExecutionEnvelope;
  idempotencyKey?: string;
  policyMode?: "human" | "automatic" | "notify";
}

export interface SupervisorContinuationResult {
  continuation: ContinuationProposal;
  item: Item;
  run: DispatchResult["run"];
  createdItemId: string | null;
  notificationRecommended: boolean;
}

export interface RunContinuationSupervisorPolicyInput {
  supervisor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  project?: string;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
}

export interface ContinuationSupervisorPolicyResult {
  considered: number;
  dispatched: SupervisorContinuationResult[];
  skipped: Array<{
    id: string;
    generation: number;
    reason: string;
  }>;
}

interface ReplayRow {
  request_json: string;
  result_json: string;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function queueContinuationForSupervisor(
  store: StensiblyStore,
  rawInput: QueueContinuationForSupervisorInput,
  now = new Date(),
): SupervisorContinuationResult {
  ensureContinuationSupervisorSchema(store);
  const input = normalizeQueueInput(rawInput);
  const request = queueRequest(input);
  const requestJson = JSON.stringify(request);
  const explicitEnvelope = rawInput.executionEnvelope !== undefined;

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const replay = store.db
        .query<ReplayRow, [string]>(`
          SELECT request_json, result_json
          FROM continuation_supervisor_commands
          WHERE idempotency_key = ?1
        `)
        .get(input.idempotencyKey);
      if (replay) {
        const storedRequest = parseJsonRecord(replay.request_json);
        if (storedRequest.executionEnvelope === undefined) {
          if (explicitEnvelope) {
            throw new ConflictError(
              "Historical continuation supervisor request cannot be retrofitted with an execution envelope",
            );
          }
          return hydrateSupervisorReplay(store, replay.result_json, now);
        }
        if (replay.request_json !== requestJson) {
          throw new ConflictError(
            "Idempotency key was already used for a different continuation supervisor request",
          );
        }
        return hydrateSupervisorReplay(store, replay.result_json, now);
      }
    }

    let continuation = getContinuation(store, input.id);
    if (continuation.generation !== input.expectedGeneration) {
      throw new ConflictError(
        `Continuation generation changed from ${input.expectedGeneration} to ${continuation.generation}`,
      );
    }
    if (continuation.deliveryMode !== "supervisor" && input.policyMode !== "human") {
      throw new ConflictError(
        `Continuation delivery mode ${continuation.deliveryMode} is not eligible for supervisor policy`,
      );
    }
    if (input.policyMode === "automatic" && continuation.approvalMode !== "automatic") {
      throw new ConflictError(
        `Continuation approval mode ${continuation.approvalMode} is not automatic`,
      );
    }
    if (input.policyMode === "notify" && continuation.approvalMode !== "notify") {
      throw new ConflictError(
        `Continuation approval mode ${continuation.approvalMode} does not require notification`,
      );
    }

    if (continuation.status === "proposed" || continuation.status === "deferred") {
      continuation = resolveContinuation(store, {
        id: continuation.id,
        actor: input.actor,
        command: "approve",
        expectedGeneration: continuation.generation,
        note: approvalNote(input.policyMode),
      });
    } else if (continuation.status !== "approved") {
      throw new ConflictError(
        `Continuation cannot queue for supervisor while ${continuation.status}`,
      );
    }

    const materialized = materializeAction(
      store,
      continuation,
      input.supervisor,
    );
    const runnerProfile = continuation.action.kind === "dispatch_item"
      ? continuation.action.runnerProfile ?? input.runnerProfile
      : input.runnerProfile;
    const dispatch = dispatchNextWork(store, {
      actor: input.supervisor,
      runnerType: input.runnerType,
      runnerProfile,
      project: materialized.item.project,
      itemId: materialized.item.id,
      continuationRef: continuation.id,
      leaseSeconds: input.leaseSeconds,
      maxAttempts: input.maxAttempts,
      retryBackoffSeconds: input.retryBackoffSeconds,
      executionEnvelope: input.executionEnvelope,
    }, now);
    if (!dispatch) {
      throw new ConflictError(
        `Continuation target ${materialized.item.id} is not eligible for supervisor dispatch`,
      );
    }

    const consumed = resolveContinuation(store, {
      id: continuation.id,
      actor: input.supervisor,
      command: "consume",
      expectedGeneration: continuation.generation,
      note: `Queued run ${dispatch.run.id} through supervisor dispatch.`,
      result: {
        itemId: dispatch.item.id,
        runId: dispatch.run.id,
      },
    });
    const notificationRecommended = input.policyMode === "notify";
    if (notificationRecommended) {
      store.recordEvent({
        itemId: consumed.sourceItemId,
        actor: input.supervisor,
        type: "continuation.supervisor_notified",
        payload: {
          continuationId: consumed.id,
          itemId: dispatch.item.id,
          runId: dispatch.run.id,
          policyMode: input.policyMode,
        },
      });
    }

    const result: SupervisorContinuationResult = {
      continuation: consumed,
      item: dispatch.item,
      run: dispatch.run,
      createdItemId: materialized.created ? materialized.item.id : null,
      notificationRecommended,
    };
    if (input.idempotencyKey) {
      store.db
        .query(`
          INSERT INTO continuation_supervisor_commands (
            idempotency_key, continuation_id, request_json, result_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `)
        .run(
          input.idempotencyKey,
          input.id,
          requestJson,
          JSON.stringify(result),
          now.toISOString(),
        );
    }
    return result;
  });

  return transaction();
}

export function runContinuationSupervisorPolicy(
  store: StensiblyStore,
  rawInput: RunContinuationSupervisorPolicyInput,
  now = new Date(),
): ContinuationSupervisorPolicyResult {
  ensureContinuationSupervisorSchema(store);
  const input = normalizePolicyInput(rawInput);
  const candidates = [
    ...listContinuations(store, {
      status: "proposed",
      deliveryMode: "supervisor",
    }),
    ...listContinuations(store, {
      status: "deferred",
      deliveryMode: "supervisor",
    }),
  ]
    .filter((proposal) =>
      proposal.approvalMode === "automatic" || proposal.approvalMode === "notify"
    )
    .filter((proposal) => {
      if (!input.project) return true;
      return continuationTouchesOnlyProject(store, proposal, input.project);
    })
    .sort(policyOrder)
    .slice(0, input.limit);

  const result: ContinuationSupervisorPolicyResult = {
    considered: candidates.length,
    dispatched: [],
    skipped: [],
  };
  for (const proposal of candidates) {
    if (proposal.action.kind === "request_decision") {
      result.skipped.push({
        id: proposal.id,
        generation: proposal.generation,
        reason: "Decision requests remain human-owned.",
      });
      continue;
    }
    try {
      result.dispatched.push(queueContinuationForSupervisor(store, {
        id: proposal.id,
        actor: input.supervisor,
        supervisor: input.supervisor,
        expectedGeneration: proposal.generation,
        runnerType: input.runnerType,
        runnerProfile: input.runnerProfile,
        leaseSeconds: input.leaseSeconds,
        maxAttempts: input.maxAttempts,
        retryBackoffSeconds: input.retryBackoffSeconds,
        idempotencyKey: `continuation-policy:${proposal.id}:${proposal.generation}`,
        policyMode: proposal.approvalMode,
      }, now));
    } catch (error) {
      result.skipped.push({
        id: proposal.id,
        generation: proposal.generation,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export function ensureContinuationSupervisorSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensureContinuationSchema(store);
  ensureDispatchSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS continuation_supervisor_commands (
      idempotency_key TEXT PRIMARY KEY,
      continuation_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(continuation_id) REFERENCES continuations(id) ON DELETE CASCADE
    );
  `);
  initializedStores.add(store);
}

function hydrateSupervisorReplay(
  store: StensiblyStore,
  resultJson: string,
  now: Date,
): SupervisorContinuationResult {
  const result = JSON.parse(resultJson) as SupervisorContinuationResult;
  return {
    ...result,
    run: getWorkRun(store, result.run.id, now),
  };
}

function materializeAction(
  store: StensiblyStore,
  continuation: ContinuationProposal,
  supervisor: ActorInput,
): { item: Item; created: boolean } {
  if (continuation.action.kind === "create_item") {
    const source = store.getItem(continuation.sourceItemId);
    return {
      item: store.createItem({
        project: continuation.action.project,
        kind: "task",
        title: continuation.title,
        summary: continuation.rationale,
        nextAction: continuation.instruction,
        priority: source.priority,
        actor: supervisor,
      }),
      created: true,
    };
  }
  if (
    continuation.action.kind === "resume_item"
    || continuation.action.kind === "dispatch_item"
  ) {
    return {
      item: store.getItem(continuation.action.itemId),
      created: false,
    };
  }
  throw new ConflictError("Decision-request continuations cannot be supervisor-dispatched");
}

function continuationTouchesOnlyProject(
  store: StensiblyStore,
  continuation: ContinuationProposal,
  project: string,
): boolean {
  try {
    if (store.getItem(continuation.sourceItemId).project !== project) return false;
    if (continuation.action.kind === "create_item") {
      return continuation.action.project === project;
    }
    if (
      continuation.action.kind === "resume_item"
      || continuation.action.kind === "dispatch_item"
    ) {
      return store.getItem(continuation.action.itemId).project === project;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeQueueInput(input: QueueContinuationForSupervisorInput) {
  const id = requiredText(input.id, "Continuation ID", 240);
  const runnerProfile = requiredText(input.runnerProfile, "Runner profile", 160);
  return {
    id,
    actor: normalizeActor(input.actor, "Approval actor"),
    supervisor: normalizeSupervisor(input.supervisor),
    expectedGeneration: positiveInteger(
      input.expectedGeneration,
      "Expected generation",
    ),
    runnerType: requiredText(input.runnerType, "Runner type", 80),
    runnerProfile,
    leaseSeconds: positiveInteger(input.leaseSeconds ?? 900, "Lease seconds", 86_400, 30),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: positiveInteger(
      input.retryBackoffSeconds ?? 60,
      "Retry backoff seconds",
      86_400,
      0,
    ),
    executionEnvelope: parseExecutionEnvelope(
      input.executionEnvelope
        ?? compatibilityExecutionEnvelope(
          `Execute continuation ${id} with runner profile ${runnerProfile}`,
        ),
    ),
    idempotencyKey: optionalText(input.idempotencyKey, "Idempotency key", 240),
    policyMode: input.policyMode ?? "human" as const,
  };
}

function normalizePolicyInput(input: RunContinuationSupervisorPolicyInput) {
  const project = optionalText(input.project, "Project", 80);
  if (project && !/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
    throw new TypeError("Project must be a lowercase slug");
  }
  return {
    supervisor: normalizeSupervisor(input.supervisor),
    runnerType: requiredText(input.runnerType, "Runner type", 80),
    runnerProfile: requiredText(input.runnerProfile, "Runner profile", 160),
    ...(project ? { project } : {}),
    limit: positiveInteger(input.limit ?? 20, "Policy limit", 100),
    leaseSeconds: positiveInteger(input.leaseSeconds ?? 900, "Lease seconds", 86_400, 30),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: positiveInteger(
      input.retryBackoffSeconds ?? 60,
      "Retry backoff seconds",
      86_400,
      0,
    ),
  };
}

function queueRequest(input: ReturnType<typeof normalizeQueueInput>) {
  return {
    id: input.id,
    actor: input.actor,
    supervisor: input.supervisor,
    expectedGeneration: input.expectedGeneration,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    leaseSeconds: input.leaseSeconds,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
    executionEnvelope: input.executionEnvelope,
    policyMode: input.policyMode,
  };
}

function approvalNote(mode: "human" | "automatic" | "notify"): string {
  if (mode === "human") return "Approved for supervisor dispatch by a human-triggered command.";
  if (mode === "notify") return "Approved by notify-and-dispatch supervisor policy.";
  return "Approved by automatic supervisor policy.";
}

function policyOrder(left: ContinuationProposal, right: ContinuationProposal): number {
  const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
  return leftExpiry - rightExpiry
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function normalizeSupervisor(actor: ActorInput): ActorInput {
  const normalized = normalizeActor(actor, "Supervisor actor");
  if (normalized.kind === "human") {
    throw new TypeError("Supervisor actor must be an agent or service");
  }
  return normalized;
}

function normalizeActor(actor: ActorInput, label: string): ActorInput {
  if (!actor || typeof actor !== "object") throw new TypeError(`${label} is required`);
  if (!( ["human", "agent", "service"] as const).includes(actor.kind)) {
    throw new TypeError(`${label} kind must be human, agent, or service`);
  }
  return {
    id: requiredText(actor.id, `${label} ID`, 120),
    name: requiredText(actor.name, `${label} name`, 160),
    kind: actor.kind,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maxLength) {
    throw new TypeError(`${label} may contain at most ${maxLength} characters`);
  }
  if (/stn\.tok_/i.test(output)) {
    throw new TypeError(`${label} cannot contain credential-shaped text`);
  }
  return output;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 1,
): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new TypeError(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return output;
}
