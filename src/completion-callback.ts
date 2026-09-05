import { createHash } from "node:crypto";
import type { CodexAppServerConnection } from "./codex-app-server-client.js";

export const COMPLETION_CALLBACK_V1 = 1 as const;

export const COMPLETION_CALLBACK_PRODUCERS = ["opencode", "agy", "external"] as const;
export type CompletionCallbackProducer = (typeof COMPLETION_CALLBACK_PRODUCERS)[number];

export const COMPLETION_CALLBACK_STATUSES = ["completed", "failed"] as const;
export type CompletionCallbackStatus = (typeof COMPLETION_CALLBACK_STATUSES)[number];

export interface CompletionCallbackInputV1 {
  /** Canonical Stensibly work-item ID. Never a display label. */
  readonly taskId: string;
  /** Canonical run ID that produced the outcome. */
  readonly runId: string;
  /** Claim generation the run executed under. */
  readonly claimGeneration: number;
  /** Which external worker family emitted the completion event. */
  readonly producer: CompletionCallbackProducer;
  readonly status: CompletionCallbackStatus;
  readonly summary?: string;
  /** Bounded opaque session/conversation reference from the producer. No secrets. */
  readonly sessionRef?: string | null;
  /** ISO-8601 completion timestamp. Defaults to now when omitted. */
  readonly completedAt?: string;
}

export interface CompletionCallbackReceiptV1 {
  readonly version: typeof COMPLETION_CALLBACK_V1;
  readonly taskId: string;
  readonly runId: string;
  readonly claimGeneration: number;
  readonly producer: CompletionCallbackProducer;
  readonly status: CompletionCallbackStatus;
  readonly summary: string | null;
  readonly sessionRef: string | null;
  readonly completedAt: string;
  /** Transport-level idempotency key. Exact replay returns the stored outcome. */
  readonly idempotencyKey: string;
}

export type CompletionCallbackTargetV1 =
  | { readonly mode: "standalone" }
  | { readonly mode: "bound-thread"; readonly threadId: string };

export interface CompletionCallbackTurnPolicyV1 {
  readonly cwd: string;
  readonly model: string;
}

export interface CompletionCallbackDeliveryV1 {
  readonly delivered: boolean;
  readonly idempotencyKey: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly duplicate: boolean;
}

/**
 * Smallest supported event-driven completion-to-Codex handoff.
 *
 * External workers (OpenCode sessions observed over the `event.subscribe()`
 * SSE stream, or `agy -p --output-format stream-json` print runs whose
 * terminal `result` event fires on completion) emit a completion event.
 * That event compiles to an idempotent receipt here, and delivery sends
 * it to Codex. It creates no scheduler, wake ledger, or mailbox:
 * duplicate, delayed, replayed, or lost events are harmless because exact
 * claim/authority fencing stays decisive downstream. Transport dedup
 * provides in-process deduplication and in-flight single-flight synchronization
 * against concurrent duplicate sends, while durable exactly-once settlement
 * remains anchored in downstream claim/authority fencing.
 *
 * Receipt status is terminal producer status only (`completed`/`failed`);
 * acceptance stays with downstream claim/authority fencing. This module
 * never marks a task accepted.
 *
 * Supported transport, verified against the installed CLI
 * (`codex queue --help`, `codex-cli 0.153.4`):
 *
 * - SUPPORTED (same-conversation live ping): an external supervisor
 *   process runs `codex queue --thread <UUID> --message <TEXT>` with the
 *   fixed bound thread ID. The daemon routes TEXT into the existing
 *   desktop conversation and starts a coordinator turn, even while the
 *   desktop holds the thread. This is the direct callback path; see
 *   `codexQueueArgvV1` / `deliverCompletionCallbackViaQueueV1`.
 * - SUPPORTED: standalone delivery over an app-server connection.
 *   `thread/start` plus `turn/start` opens an independent Codex thread.
 * - SUPPORTED (storage level, cold threads only): `thread/resume` plus
 *   `turn/start` can append to a stored thread with no live owner.
 *   App-server `thread/resume` on a desktop-held thread is rejected
 *   (`already has an active writer`); that single-writer limit is why
 *   bound live delivery uses the `codex queue` CLI, not resume.
 *
 * Correction: earlier revisions of this module claimed no supported
 * direct same-conversation path existed after probing app-server resume.
 * That claim was wrong. The supported path is the `codex queue` CLI
 * transport implemented below, proven by coordinator verification that
 * an external CLI supervisor ping reaches the existing desktop
 * conversation and starts a turn.
 *
 * Official sources:
 * - Codex CLI `queue` transport: local `codex queue --help`
 *   (`codex queue --thread <THREAD> --message <TEXT>`, THREAD is a
 *   session UUID or exact session name).
 * - Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 * - App-server reference: https://learn.chatgpt.com/docs/app-server
 * - OpenCode SDK events: https://opencode.ai/docs/sdk/ (`event.subscribe()`
 *   SSE stream)
 * - Antigravity headless/streaming: https://antigravity.google/docs/cli/headless/
 *   (`-p --output-format stream-json` emits `init`, `step_update*`, one
 *   terminal `result` event carrying `status` ["SUCCESS"/"ERROR"], `response`,
 *   `error`, `conversation_id`, and `usage`)
 * - `agy` exposes no event-subscription/server endpoint; the completion
 *   signal IS its terminal `result` event (stdout), consumed here via
 *   `completionCallbackFromAgyResultEventV1`.
 */
export function compileCompletionCallbackV1(input: CompletionCallbackInputV1): CompletionCallbackReceiptV1 {
  const taskId = safeIdentifier(input.taskId, "Task ID", 240);
  const runId = safeIdentifier(input.runId, "Run ID", 240);
  const claimGeneration = nonNegativeInteger(input.claimGeneration, "Claim generation");
  const producer = exactProducer(input.producer);
  const status = exactStatus(input.status);
  const summary = input.summary === undefined ? null : safeText(input.summary, "Summary", 10_000);
  const sessionRef = input.sessionRef === undefined || input.sessionRef === null
    ? null
    : safeIdentifier(input.sessionRef, "Session reference", 240);
  const completedAt = input.completedAt === undefined ? new Date().toISOString() : safeTimestamp(input.completedAt);
  const idempotencyKey = `completion-callback/v1:${digest(
    [taskId, runId, String(claimGeneration), producer, status, summary ?? ""].join("\n"),
  )}`;
  return deepFreeze({
    version: COMPLETION_CALLBACK_V1,
    taskId,
    runId,
    claimGeneration,
    producer,
    status,
    summary,
    sessionRef,
    completedAt,
    idempotencyKey,
  });
}

/**
 * Compiles the terminal `result` event of an `agy -p --output-format
 * stream-json` run into a receipt. The documented stream shape is one
 * `init` event, zero or more `step_update` events, and exactly one terminal
 * `result` event carrying `status`/`response`/`error`/`usage`.
 *
 * Official Antigravity stream-json schema:
 * - Emits `status: "SUCCESS"` on successful completion, `"ERROR"` on error.
 * - Response content is emitted in `response` (with legacy `text` fallback).
 * - Fails closed: only explicit recognized success statuses ("SUCCESS", "success",
 *   "completed", "ok") map to "completed". Any error ("ERROR", "failed"), missing,
 *   or unknown status maps to "failed".
 * - Supports both nested result envelope (`event.result`) and top-level result payload.
 * - Non-terminal events (e.g. `step_update`, `init`) fail closed with RangeError.
 */
export function completionCallbackFromAgyResultEventV1(input: {
  readonly taskId: string;
  readonly runId: string;
  readonly claimGeneration: number;
  readonly event: unknown;
  readonly sessionRef?: string | null;
}): CompletionCallbackReceiptV1 {
  if (!isRecord(input.event)) {
    throw new RangeError("Antigravity stream event is not a terminal result event");
  }
  if (input.event.event !== undefined && input.event.event !== "result") {
    throw new RangeError("Antigravity stream event is not a terminal result event");
  }

  let payload: Record<string, unknown>;
  if (isRecord(input.event.result)) {
    payload = input.event.result;
  } else if (
    input.event.status !== undefined ||
    input.event.response !== undefined ||
    input.event.text !== undefined ||
    input.event.error !== undefined ||
    input.event.conversation_id !== undefined
  ) {
    payload = input.event;
  } else {
    throw new RangeError("Antigravity stream event is not a terminal result event");
  }

  const rawStatus = typeof payload.status === "string"
    ? payload.status.trim().toLowerCase()
    : typeof input.event.status === "string"
    ? (input.event.status as string).trim().toLowerCase()
    : "";

  const isSuccess = rawStatus === "success" || rawStatus === "completed" || rawStatus === "ok";
  const status: CompletionCallbackStatus = isSuccess ? "completed" : "failed";

  const responseText = typeof payload.response === "string" && payload.response.trim()
    ? payload.response.trim()
    : typeof payload.text === "string" && payload.text.trim()
    ? payload.text.trim()
    : typeof input.event.response === "string" && (input.event.response as string).trim()
    ? (input.event.response as string).trim()
    : typeof input.event.text === "string" && (input.event.text as string).trim()
    ? (input.event.text as string).trim()
    : null;

  const errorText = typeof payload.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : typeof input.event.error === "string" && (input.event.error as string).trim()
    ? (input.event.error as string).trim()
    : null;

  let summary: string;
  if (status === "failed") {
    if (errorText) {
      summary = errorText;
    } else if (responseText) {
      summary = responseText;
    } else {
      summary = `Antigravity run failed with status ${safeCoarse(String(payload.status ?? input.event.status ?? "unknown"))}`;
    }
  } else {
    if (responseText) {
      summary = responseText;
    } else if (errorText) {
      summary = errorText;
    } else {
      summary = `Antigravity run finished with status ${safeCoarse(String(payload.status ?? input.event.status ?? "completed"))}`;
    }
  }

  const conversationId = typeof payload.conversation_id === "string" && payload.conversation_id.trim()
    ? payload.conversation_id.trim()
    : typeof input.event.conversation_id === "string" && (input.event.conversation_id as string).trim()
    ? (input.event.conversation_id as string).trim()
    : null;
  const sessionRef = input.sessionRef !== undefined && input.sessionRef !== null
    ? input.sessionRef
    : conversationId;

  return compileCompletionCallbackV1({
    taskId: input.taskId,
    runId: input.runId,
    claimGeneration: input.claimGeneration,
    producer: "agy",
    status,
    summary,
    sessionRef,
  });
}

/** Bounded human- and model-readable text delivered to Codex as the turn input. */
export function completionCallbackMessageV1(receipt: CompletionCallbackReceiptV1): string {
  const admitted = admitReceipt(receipt);
  const lines = [
    `External worker ${admitted.status}: ${admitted.producer} run ${admitted.runId} for task ${admitted.taskId} (claim generation ${admitted.claimGeneration}).`,
    `Receipt: ${admitted.idempotencyKey}`,
    `Completed at: ${admitted.completedAt}`,
  ];
  if (admitted.sessionRef) lines.push(`Producer session: ${admitted.sessionRef}`);
  lines.push(admitted.summary ? `Summary: ${admitted.summary}` : "Summary: (none provided)");
  return lines.join("\n").slice(0, 12_000);
}

/**
 * Delivers one receipt to Codex over an existing app-server connection.
 * `deliveredKeys` is caller-owned transport dedup (a `Set` suffices); the
 * durable exactly-once boundary stays with the existing `item.completed`
 * idempotency-key path, so this adds no ledger or queue.
 *
 * Bound live threads (desktop-held) must use `deliverCompletionCallbackViaQueueV1`
 * below, not `thread/resume` here: resume is single-writer and is rejected
 * on held threads, while the `codex queue` CLI is the supported live ping.
 */
interface InFlightQueueEntry {
  readonly promise: Promise<CompletionCallbackQueueDeliveryV1>;
  readonly threadId: string;
}

const inFlightQueueSends = new Map<string, InFlightQueueEntry>();
const inFlightAppServerSends = new Map<string, Promise<CompletionCallbackDeliveryV1>>();

/**
 * Delivers one receipt to Codex over an existing app-server connection.
 * `deliveredKeys` is caller-owned transport dedup; in-flight single-flight
 * synchronization prevents concurrent duplicate sends. The durable
 * exactly-once boundary stays with the downstream claim/authority fencing.
 *
 * Bound live threads (desktop-held) must use `deliverCompletionCallbackViaQueueV1`
 * below, not `thread/resume` here: resume is single-writer and is rejected
 * on held threads, while the `codex queue` CLI is the supported live ping.
 */
export async function deliverCompletionCallbackV1(input: {
  readonly connection: CodexAppServerConnection;
  readonly receipt: CompletionCallbackReceiptV1;
  readonly target: CompletionCallbackTargetV1;
  readonly policy: CompletionCallbackTurnPolicyV1;
  readonly deliveredKeys?: {
    readonly has: (key: string) => boolean | Promise<boolean>;
    readonly add: (key: string) => void | Promise<void>;
  };
}): Promise<CompletionCallbackDeliveryV1> {
  const receipt = admitReceipt(input.receipt);
  const target = admitTarget(input.target);
  const policy = admitPolicy(input.policy);

  if (await input.deliveredKeys?.has(receipt.idempotencyKey)) {
    return deepFreeze({
      delivered: false,
      idempotencyKey: receipt.idempotencyKey,
      threadId: null,
      turnId: null,
      duplicate: true,
    });
  }

  const inFlight = inFlightAppServerSends.get(receipt.idempotencyKey);
  if (inFlight !== undefined) {
    const inFlightOutcome = await inFlight;
    if (inFlightOutcome.delivered) {
      return deepFreeze({
        delivered: false,
        idempotencyKey: receipt.idempotencyKey,
        threadId: null,
        turnId: null,
        duplicate: true,
      });
    }
    return inFlightOutcome;
  }

  const execution = (async (): Promise<CompletionCallbackDeliveryV1> => {
    try {
      let threadId: string;
      if (target.mode === "standalone") {
        const started = record(
          await input.connection.request("thread/start", {
            model: policy.model,
            cwd: policy.cwd,
            runtimeWorkspaceRoots: [policy.cwd],
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
            historyMode: "paginated",
            serviceName: "stensibly-completion-callback",
          }),
          "thread/start response",
        );
        threadId = threadIdentity(started);
      } else {
        const resumed = record(
          await input.connection.request("thread/resume", { threadId: target.threadId }),
          "thread/resume response",
        );
        const resumedId = threadIdentity(resumed);
        if (resumedId !== target.threadId) {
          throw new Error("Codex resumed a different thread than the bound completion target");
        }
        threadId = resumedId;
      }
      const turn = record(
        await input.connection.request("turn/start", {
          threadId,
          input: [{ type: "text", text: completionCallbackMessageV1(receipt), text_elements: [] }],
          cwd: policy.cwd,
          approvalPolicy: "never",
          model: policy.model,
        }),
        "turn/start response",
      );
      const turnId = identifier(record(turn.turn, "Codex turn").id, "Codex turn ID");
      await input.deliveredKeys?.add(receipt.idempotencyKey);
      return deepFreeze({
        delivered: true,
        idempotencyKey: receipt.idempotencyKey,
        threadId,
        turnId,
        duplicate: false,
      });
    } finally {
      inFlightAppServerSends.delete(receipt.idempotencyKey);
    }
  })();

  inFlightAppServerSends.set(receipt.idempotencyKey, execution);
  return execution;
}

export const CODEX_QUEUE_COMMAND_V1 = "codex" as const;

export interface CompletionCallbackQueueDeliveryV1 {
  readonly delivered: boolean;
  readonly transport: "codex-queue-cli";
  readonly idempotencyKey: string;
  /** Fixed bound thread the message was queued to. Exact match only. */
  readonly threadId: string | null;
  readonly duplicate: boolean;
  readonly recovered?: boolean;
}

export interface CompletionCallbackQueueSpawnV1 {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly threadId?: string;
}

export type CompletionCallbackQueueRunnerV1 = (
  command: string,
  argv: readonly string[],
) => Promise<CompletionCallbackQueueSpawnV1>;

function resolveBoundThreadId(input: {
  readonly threadId?: string;
  readonly target?: CompletionCallbackTargetV1;
}): string {
  if (input.target !== undefined) {
    const target = admitTarget(input.target);
    if (target.mode !== "bound-thread") {
      throw new RangeError("Codex queue CLI transport requires a bound-thread target");
    }
    if (input.threadId !== undefined) {
      const explicitThread = identifier(input.threadId, "Bound thread ID");
      if (explicitThread !== target.threadId) {
        throw new RangeError("Completion callback thread binding mismatch between target and threadId");
      }
    }
    return target.threadId;
  }
  if (input.threadId !== undefined) {
    return identifier(input.threadId, "Bound thread ID");
  }
  throw new RangeError("Bound thread ID or bound-thread target is required");
}

/**
 * Builds the exact supported CLI argv for a direct same-conversation ping:
 * `codex queue --thread <UUID> --message <TEXT>`, run as a child of an
 * external supervisor process (no Codex intermediary, no scheduler, no
 * extra queue). TEXT is `completionCallbackMessageV1(receipt)` (bounded,
 * compact). Argv form (not a shell string) keeps spaces/newlines safe.
 */
export function codexQueueArgvV1(input: {
  readonly receipt: CompletionCallbackReceiptV1;
  readonly threadId?: string;
  readonly target?: CompletionCallbackTargetV1;
}): readonly string[] {
  const receipt = admitReceipt(input.receipt);
  const threadId = resolveBoundThreadId(input);
  return deepFreeze([
    "queue",
    "--thread",
    threadId,
    "--message",
    completionCallbackMessageV1(receipt),
  ] as const as readonly string[]);
}

export interface CompletionCallbackQueueInputV1 {
  readonly receipt: CompletionCallbackReceiptV1;
  readonly threadId?: string;
  readonly target?: CompletionCallbackTargetV1;
  readonly run: CompletionCallbackQueueRunnerV1;
  readonly deliveredKeys?: {
    readonly has: (key: string) => boolean | Promise<boolean>;
    readonly add: (key: string) => void | Promise<void>;
  };
  readonly reconcile?: (
    receipt: CompletionCallbackReceiptV1,
    threadId: string,
    error: unknown,
  ) => Promise<boolean> | boolean;
}

/**
 * Sends one receipt into the existing desktop conversation via the
 * supported `codex queue` CLI transport.
 *
 * - Fixed target binding: queues only to the exact `threadId` (or bound-thread
 *   target); fails closed without spawning on binding mismatch or standalone target.
 * - Concurrency & Idempotency: in-flight single-flight synchronization prevents
 *   concurrent duplicate subprocess spawns for the same receipt. Exact replay
 *   with a key already delivered returns the stored duplicate outcome without spawning.
 * - Ambiguous send recovery: the key is marked only on exit code 0 or successful
 *   reconciliation. Non-zero exits and runner throws (e.g. timeout) propagate without
 *   marking unless an optional `reconcile` callback confirms accepted delivery.
 *   The caller must reconcile before retrying, and retries after reconciliation dedup
 *   cleanly without duplicate send.
 */
export async function deliverCompletionCallbackViaQueueV1(
  input: CompletionCallbackQueueInputV1,
): Promise<CompletionCallbackQueueDeliveryV1> {
  const receipt = admitReceipt(input.receipt);
  const threadId = resolveBoundThreadId(input);

  if (await input.deliveredKeys?.has(receipt.idempotencyKey)) {
    return deepFreeze({
      delivered: false,
      transport: "codex-queue-cli",
      idempotencyKey: receipt.idempotencyKey,
      threadId: null,
      duplicate: true,
    });
  }

  const existingInFlight = inFlightQueueSends.get(receipt.idempotencyKey);
  if (existingInFlight !== undefined) {
    if (existingInFlight.threadId !== threadId) {
      throw new RangeError("Concurrent delivery binding conflict: send already in flight for different thread");
    }
    const inFlightOutcome = await existingInFlight.promise;
    if (inFlightOutcome.delivered) {
      return deepFreeze({
        delivered: false,
        transport: "codex-queue-cli",
        idempotencyKey: receipt.idempotencyKey,
        threadId: null,
        duplicate: true,
      });
    }
    return inFlightOutcome;
  }

  const execution = (async (): Promise<CompletionCallbackQueueDeliveryV1> => {
    const argv = codexQueueArgvV1({ receipt, threadId });
    try {
      const spawned = await input.run(CODEX_QUEUE_COMMAND_V1, argv);
      if (!isRecord(spawned) || !Number.isSafeInteger(spawned.exitCode)) {
        throw new Error("Codex queue runner returned an invalid result (reconcile before retry)");
      }
      if (
        typeof (spawned as Record<string, unknown>).threadId === "string" &&
        (spawned as Record<string, unknown>).threadId !== threadId
      ) {
        throw new Error("Codex queue runner returned a thread binding mismatch");
      }
      if (spawned.exitCode !== 0) {
        throw new Error(
          `Codex queue send failed with exit ${String(spawned.exitCode)}: ${compactTail(String(spawned.stderr ?? ""))}`,
        );
      }
      await input.deliveredKeys?.add(receipt.idempotencyKey);
      return deepFreeze({
        delivered: true,
        transport: "codex-queue-cli",
        idempotencyKey: receipt.idempotencyKey,
        threadId,
        duplicate: false,
      });
    } catch (error) {
      if (input.reconcile) {
        try {
          const accepted = await input.reconcile(receipt, threadId, error);
          if (accepted) {
            await input.deliveredKeys?.add(receipt.idempotencyKey);
            return deepFreeze({
              delivered: true,
              transport: "codex-queue-cli",
              idempotencyKey: receipt.idempotencyKey,
              threadId,
              duplicate: false,
              recovered: true,
            });
          }
        } catch {
          // Reconcile threw, fall through to rethrow original error
        }
      }
      throw error;
    } finally {
      inFlightQueueSends.delete(receipt.idempotencyKey);
    }
  })();

  inFlightQueueSends.set(receipt.idempotencyKey, { promise: execution, threadId });
  return execution;
}

/**
 * Reconciles an ambiguous delivery outcome (e.g. accepted-but-timeout).
 * When `accepted` is true, marks the receipt idempotency key so that
 * subsequent retries dedup cleanly without duplicate dispatch.
 */
export function reconcileCompletionCallbackDeliveryV1(input: {
  readonly receipt: CompletionCallbackReceiptV1;
  readonly deliveredKeys: {
    readonly add: (key: string) => void | Promise<void>;
  };
  readonly accepted: boolean;
}): boolean {
  const receipt = admitReceipt(input.receipt);
  if (input.accepted) {
    input.deliveredKeys.add(receipt.idempotencyKey);
    return true;
  }
  return false;
}

function compactTail(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "(no stderr)";
  return trimmed.slice(-500);
}

function admitReceipt(value: CompletionCallbackReceiptV1): CompletionCallbackReceiptV1 {
  if (!isRecord(value) || value.version !== COMPLETION_CALLBACK_V1) {
    throw new RangeError("Completion callback receipt version is invalid");
  }
  const recompiled = compileCompletionCallbackV1({
    taskId: text(value.taskId, "Task ID", 240),
    runId: text(value.runId, "Run ID", 240),
    claimGeneration: value.claimGeneration,
    producer: value.producer,
    status: value.status,
    ...(value.summary === null ? {} : { summary: text(value.summary, "Summary", 10_000) }),
    ...(value.sessionRef === null ? {} : { sessionRef: text(value.sessionRef, "Session reference", 240) }),
    completedAt: text(value.completedAt, "Completed at", 64),
  });
  if (recompiled.idempotencyKey !== value.idempotencyKey) {
    throw new RangeError("Completion callback receipt idempotency key does not match its fields");
  }
  return recompiled;
}

function admitTarget(value: CompletionCallbackTargetV1): CompletionCallbackTargetV1 {
  if (!isRecord(value)) throw new RangeError("Completion callback target is invalid");
  if (value.mode === "standalone") return deepFreeze({ mode: "standalone" });
  if (value.mode === "bound-thread") {
    return deepFreeze({ mode: "bound-thread", threadId: identifier(value.threadId, "Bound thread ID") });
  }
  throw new RangeError("Completion callback target mode is invalid");
}

function admitPolicy(value: CompletionCallbackTurnPolicyV1): CompletionCallbackTurnPolicyV1 {
  if (!isRecord(value)) throw new RangeError("Completion callback turn policy is invalid");
  return deepFreeze({
    cwd: absolutePath(value.cwd),
    model: safeIdentifier(value.model, "Codex model", 160),
  });
}

function threadIdentity(response: Record<string, unknown>): string {
  const thread = record(response.thread, "thread response thread");
  const threadId = identifier(thread.id, "Codex thread ID");
  const sessionId = thread.sessionId === undefined ? threadId : identifier(thread.sessionId, "Codex session ID");
  if (sessionId !== threadId) {
    throw new Error("Completion callback delivery requires an independent root session");
  }
  return threadId;
}

function exactProducer(value: unknown): CompletionCallbackProducer {
  if (typeof value !== "string" || !(COMPLETION_CALLBACK_PRODUCERS as readonly string[]).includes(value)) {
    throw new RangeError("Completion callback producer is invalid");
  }
  return value as CompletionCallbackProducer;
}

function exactStatus(value: unknown): CompletionCallbackStatus {
  if (typeof value !== "string" || !(COMPLETION_CALLBACK_STATUSES as readonly string[]).includes(value)) {
    throw new RangeError("Completion callback status is invalid");
  }
  return value as CompletionCallbackStatus;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeCoarse(value: string): string {
  return value.trim().slice(0, 80) || "unknown";
}

function safeTimestamp(value: string): string {
  const output = safeText(value, "Completed at", 64).trim();
  if (Number.isNaN(Date.parse(output))) throw new RangeError("Completed at is not a valid timestamp");
  return output;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string, maximum: number): string {
  return safeText(value, label, maximum);
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string, maximum: number): string {
  const output = safeText(value, label, maximum).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+\-=]*$/u.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function identifier(value: unknown, label: string): string {
  return safeIdentifier(value, label, 240);
}

function absolutePath(value: unknown): string {
  const output = safeText(value, "Codex working directory", 4_096).trim();
  if (!output.startsWith("/")) throw new RangeError("Codex working directory must be absolute");
  return output;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${label} must be non-negative`);
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
