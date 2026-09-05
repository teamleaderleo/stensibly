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
 * That event compiles to an idempotent receipt here, and delivery appends
 * it to Codex through the supported app-server surface (`thread/start` or
 * `thread/resume`, then `turn/start`). It creates no queue, scheduler,
 * wake ledger, or mailbox: duplicate, delayed, replayed, or lost events
 * are harmless because exact claim/authority fencing stays decisive
 * downstream and transport dedup makes replay return the stored outcome.
 *
 * Supported vs unsupported, verified against the installed CLIs and the
 * generated protocol schema (`codex app-server generate-json-schema`):
 *
 * - SUPPORTED: standalone delivery. `thread/start` opens an independent
 *   Codex thread on this connection and `turn/start` delivers the receipt.
 *   The connection observes its own `turn/*` notifications live.
 * - SUPPORTED (storage level, cold threads only): bound-thread append.
 *   Threads persist in the shared local store (`~/.codex/sessions`), so
 *   `thread/resume` plus `turn/start` can append to a stored thread that
 *   has no live owner.
 * - UNSUPPORTED: delivery into a thread the desktop currently holds.
 *   Verified 2026-09-05 against `codex-cli 0.153.4`: `thread/read` on a
 *   live vscode-source thread from an independent stdio connection works,
 *   but `thread/resume` on it is rejected with `thread <id> already has
 *   an active writer`. Single-writer is enforced, and the protocol has no
 *   request that pushes a notification into a different connection's
 *   subscription (e.g. the desktop app's own app-server session), so a
 *   bound-thread append can neither run while the user holds the thread
 *   nor surface as a live ping. `thread/inject_items` likewise appends
 *   model-visible history without starting a turn and notifies nobody
 *   else. Same-thread live delivery therefore needs either a future
 *   Codex-supported cross-client notify/inject API or desktop-side
 *   cooperation; that is the exact missing integration.
 *
 * Official sources:
 * - Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 * - App-server reference: https://learn.chatgpt.com/docs/app-server
 * - Harness architecture: https://openai.com/index/unlocking-the-codex-harness/
 * - OpenCode SDK events: https://opencode.ai/docs/sdk/ (`event.subscribe()`
 *   SSE stream; `session.prompt` delivers into a session)
 * - Antigravity headless/streaming: https://antigravity.google/docs/cli/headless/
 *   (`-p --output-format stream-json` emits `init`, `step_update*`, one
 *   terminal `result` event; `--continue`/`--conversation` resume)
 * - Antigravity remote control is browser remote-driving of desktop
 *   sessions, not a programmatic callback API:
 *   https://antigravity.google/docs/remote-control/
 * - `agy` exposes no SDK and no event-subscription/server endpoint; the
 *   completion signal IS its terminal `result` event (stdout), consumed
 *   here via `completionCallbackFromAgyResultEventV1`.
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
 * `result` event carrying `status`/`error`/`usage`. Anything else fails
 * closed: the caller must wait for (or re-read) the terminal event.
 */
export function completionCallbackFromAgyResultEventV1(input: {
  readonly taskId: string;
  readonly runId: string;
  readonly claimGeneration: number;
  readonly event: unknown;
  readonly sessionRef?: string | null;
}): CompletionCallbackReceiptV1 {
  if (!isRecord(input.event) || input.event.event !== "result" || !isRecord(input.event.result)) {
    throw new RangeError("Antigravity stream event is not a terminal result event");
  }
  const result = input.event.result;
  const status = typeof result.status === "string" && result.status.toLowerCase() === "failed"
    ? "failed"
    : "completed";
  const summary = typeof result.text === "string" && result.text.trim()
    ? result.text
    : typeof result.error === "string" && result.error.trim()
    ? result.error
    : `Antigravity run finished with status ${safeCoarse(String(result.status ?? "unknown"))}`;
  return compileCompletionCallbackV1({
    taskId: input.taskId,
    runId: input.runId,
    claimGeneration: input.claimGeneration,
    producer: "agy",
    status,
    summary,
    sessionRef: input.sessionRef,
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
 */
export async function deliverCompletionCallbackV1(input: {
  readonly connection: CodexAppServerConnection;
  readonly receipt: CompletionCallbackReceiptV1;
  readonly target: CompletionCallbackTargetV1;
  readonly policy: CompletionCallbackTurnPolicyV1;
  readonly deliveredKeys?: {
    readonly has: (key: string) => boolean;
    readonly add: (key: string) => void;
  };
}): Promise<CompletionCallbackDeliveryV1> {
  const receipt = admitReceipt(input.receipt);
  const target = admitTarget(input.target);
  const policy = admitPolicy(input.policy);
  if (input.deliveredKeys?.has(receipt.idempotencyKey)) {
    return deepFreeze({
      delivered: false,
      idempotencyKey: receipt.idempotencyKey,
      threadId: null,
      turnId: null,
      duplicate: true,
    });
  }
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
  input.deliveredKeys?.add(receipt.idempotencyKey);
  return deepFreeze({
    delivered: true,
    idempotencyKey: receipt.idempotencyKey,
    threadId,
    turnId,
    duplicate: false,
  });
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
