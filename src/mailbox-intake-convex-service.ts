import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";

const initializeRef = makeFunctionReference<"mutation">("mailboxIntake:initialize");
const commitRef = makeFunctionReference<"mutation">("mailboxIntake:commitReconciliation");
const getRef = makeFunctionReference<"query">("mailboxIntake:getBinding");

export interface MailboxIntakeSnapshot {
  readonly state: MailboxSubscriptionState;
  readonly revision: number;
}

export interface HostedMailboxIntakeServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class HostedMailboxIntakeService {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: HostedMailboxIntakeServiceOptions) {
    this.#client = options.client;
    this.#serviceSecret = required(options.serviceSecret, "Mailbox intake service secret");
    this.#workspace = required(options.workspace ?? "default", "Mailbox intake workspace");
  }

  async get(mailboxBindingId: string): Promise<MailboxIntakeSnapshot | null> {
    const raw = await this.#client.query(getRef, this.#args({ mailboxBindingId }));
    if (raw === null) return null;
    const row = record(raw);
    const subscription = record(row.subscription);
    const scope = record(row.scope);
    const provider = row.provider;
    if (provider !== "gmail" && provider !== "outlook") throw new Error("Mailbox intake storage returned an invalid provider");
    const cursorValue = text(row.cursorValue, "Mailbox cursor");
    const state = createMailboxSubscriptionState({
      mailboxBindingId: text(row.mailboxBindingId, "Mailbox binding ID"),
      provider,
      scope: provider === "gmail"
        ? { kind: "label", externalId: text(scope.externalId, "Mailbox scope ID") }
        : { kind: "folder", externalId: text(scope.externalId, "Mailbox scope ID") },
      cursor: provider === "gmail"
        ? { kind: "gmail_history_id", value: cursorValue }
        : { kind: "outlook_delta_ref", value: cursorValue },
      coverage: row.coverage === "continuous" ? "continuous" : "unknown",
      subscription: {
        externalId: nullableText(subscription.externalId, "Mailbox subscription ID"),
        expiresAt: nullableText(subscription.expiresAt, "Mailbox subscription expiry"),
        health: subscription.health === "healthy"
          ? "healthy"
          : subscription.health === "recovering" ? "recovering" : "degraded",
        recoveryReason: nullableText(subscription.recoveryReason, "Mailbox recovery reason"),
      },
      lastNotificationId: nullableText(row.lastNotificationId, "Mailbox notification ID"),
      lastSuccessfulReconciliationAt: nullableText(
        row.lastSuccessfulReconciliationAt,
        "Mailbox reconciliation time",
      ),
    });
    return Object.freeze({ state, revision: positiveRevision(row.revision) });
  }

  async initialize(state: MailboxSubscriptionState): Promise<MailboxIntakeSnapshot> {
    const raw = await this.#client.mutation(initializeRef, this.#args({
      stateJson: canonicalJsonString(state),
    }));
    const result = record(raw);
    return Object.freeze({ state, revision: positiveRevision(result.revision) });
  }

  async commit(input: {
    previous: MailboxIntakeSnapshot;
    nextState: MailboxSubscriptionState;
    observations: readonly MailboxObservation[];
    reconciliationId: string;
  }): Promise<MailboxIntakeSnapshot> {
    const raw = await this.#client.mutation(commitRef, this.#args({
      mailboxBindingId: input.previous.state.mailboxBindingId,
      reconciliationId: required(input.reconciliationId, "Mailbox reconciliation ID"),
      expectedRevision: input.previous.revision,
      expectedCursor: input.previous.state.cursor.value,
      nextStateJson: canonicalJsonString(input.nextState),
      observationsJson: input.observations.map(canonicalJsonString),
    }));
    const result = record(raw);
    return Object.freeze({
      state: input.nextState,
      revision: positiveRevision(result.revision),
    });
  }

  #args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mailbox intake storage returned an invalid response");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error(`${label} is invalid`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}

function positiveRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Mailbox intake revision is invalid");
  return value;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new RangeError(`${label} is required`);
  }
  return value;
}
