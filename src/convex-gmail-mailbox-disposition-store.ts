import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.js";
import {
  type CurrentDurableStnMailboxState,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffect,
  type GmailMailboxDispositionEffectRecord,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxDispositionReconciliationPhase,
  type GmailMailboxDispositionReserveResult,
  type GmailMailboxDispositionSettledOutcome,
  type SettledGmailMessageBinding,
} from "./gmail-mailbox-disposition-effect.js";
import {
  freezeMailDeliveryReceipt,
  type MailDeliveryReceipt,
} from "./mail-provider.js";

export interface GmailMailboxDispositionConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexGmailMailboxDispositionStoreOptions {
  client: GmailMailboxDispositionConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class GmailMailboxDispositionLaneBlockedError extends Error {
  readonly record: GmailMailboxDispositionEffectRecord;

  constructor(record: GmailMailboxDispositionEffectRecord) {
    super("Gmail mailbox disposition target has an unresolved durable effect");
    this.name = "GmailMailboxDispositionLaneBlockedError";
    this.record = record;
  }
}

export class ConvexGmailMailboxDispositionStore
implements CurrentDurableStnMailboxStateReader, GmailMailboxDispositionEffectStore {
  readonly #client: GmailMailboxDispositionConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexGmailMailboxDispositionStoreOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Hosted Gmail disposition store options are required");
    if (!options.client || typeof options.client.query !== "function" || typeof options.client.mutation !== "function") {
      throw new TypeError("Hosted Gmail disposition Convex client is required");
    }
    this.#client = options.client;
    this.#serviceSecret = exact(options.serviceSecret, "Hosted Gmail disposition service secret", 64 * 1024);
    this.#workspace = workspaceSlug(options.workspace ?? "default");
  }

  async putCurrentState(
    stateInput: CurrentDurableStnMailboxState,
    expectedRevision?: string | null,
  ): Promise<CurrentDurableStnMailboxState> {
    const state = freezeCurrentState(stateInput);
    const args: Record<string, unknown> = { stateJson: JSON.stringify(state) };
    if (expectedRevision !== undefined) {
      args.expectedRevision = expectedRevision === null
        ? null
        : exact(expectedRevision, "Expected STN state revision", 320);
    }
    const value = responseRecord(await this.#client.mutation(
      convexApi.gmailMailboxDisposition.putCurrentState,
      this.#args(args),
    ), "Hosted Gmail disposition state write");
    return parseCurrentStateJson(value.stateJson);
  }

  async readCurrentState(input: { stnThreadId: string }): Promise<CurrentDurableStnMailboxState | null> {
    const value = await this.#client.query(
      convexApi.gmailMailboxDisposition.getCurrentState,
      this.#args({ stnThreadId: exact(input.stnThreadId, "STN thread ID", 240) }),
    );
    return value === null ? null : parseCurrentStateJson(value);
  }

  async recordSettledDelivery(receiptInput: MailDeliveryReceipt): Promise<MailDeliveryReceipt> {
    const receipt = settledReceipt(receiptInput);
    const value = responseRecord(await this.#client.mutation(
      convexApi.gmailMailboxDisposition.recordSettledDelivery,
      this.#args({ receiptJson: JSON.stringify(receipt) }),
    ), "Hosted Gmail disposition delivery write");
    return parseReceiptJson(value.receiptJson);
  }

  async getSettledDelivery(stnThreadId: string): Promise<MailDeliveryReceipt | null> {
    const value = await this.#client.query(
      convexApi.gmailMailboxDisposition.getSettledDelivery,
      this.#args({ stnThreadId: exact(stnThreadId, "STN thread ID", 240) }),
    );
    return value === null ? null : parseReceiptJson(value);
  }

  async getEffectRecord(effectId: string): Promise<GmailMailboxDispositionEffectRecord | null> {
    const value = await this.#client.query(
      convexApi.gmailMailboxDisposition.getEffect,
      this.#args({ effectId: exact(effectId, "Gmail disposition effect ID", 4096) }),
    );
    return value === null ? null : parseRecordJson(value);
  }

  async findOutstandingForTarget(binding: SettledGmailMessageBinding): Promise<GmailMailboxDispositionEffectRecord | null> {
    const target = freezeBinding(binding);
    const value = await this.#client.query(
      convexApi.gmailMailboxDisposition.findOutstanding,
      this.#args({
        accountBinding: target.accountBinding,
        mailboxAddress: target.mailboxAddress,
        providerThreadId: target.providerThreadId,
        providerMessageId: target.providerMessageId,
      }),
    );
    return value === null ? null : parseRecordJson(value);
  }

  async reserveEffect(effectInput: GmailMailboxDispositionEffect): Promise<GmailMailboxDispositionReserveResult> {
    const effect = freezeEffect(effectInput);
    const value = responseRecord(await this.#client.mutation(
      convexApi.gmailMailboxDisposition.reserveEffect,
      this.#args({ effectJson: JSON.stringify(effect) }),
    ), "Hosted Gmail disposition effect reservation");
    if (value.outcome === "reserved") return { status: "reserved" };
    if (value.outcome === "existing") {
      return { status: "existing", record: parseRecordJson(value.recordJson) };
    }
    if (value.outcome === "blocked") {
      throw new GmailMailboxDispositionLaneBlockedError(parseRecordJson(value.recordJson));
    }
    throw new TypeError("Hosted Gmail disposition reservation outcome is invalid");
  }

  async markReconciliationRequired(
    effectId: string,
    phase: GmailMailboxDispositionReconciliationPhase,
  ): Promise<void> {
    await this.#client.mutation(
      convexApi.gmailMailboxDisposition.markReconciliationRequired,
      this.#args({
        effectId: exact(effectId, "Gmail disposition effect ID", 4096),
        phase: reconciliationPhase(phase),
      }),
    );
  }

  async markSettled(
    effectId: string,
    outcome: GmailMailboxDispositionSettledOutcome,
  ): Promise<void> {
    await this.#client.mutation(
      convexApi.gmailMailboxDisposition.markSettled,
      this.#args({
        effectId: exact(effectId, "Gmail disposition effect ID", 4096),
        outcome: settledOutcome(outcome),
      }),
    );
  }

  async releasePreconditionRetry(effectId: string): Promise<void> {
    await this.#client.mutation(
      convexApi.gmailMailboxDisposition.releasePreconditionRetry,
      this.#args({ effectId: exact(effectId, "Gmail disposition effect ID", 4096) }),
    );
  }

  #args(value: Record<string, unknown>): Record<string, unknown> {
    return {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      ...value,
    };
  }
}

function parseCurrentStateJson(value: unknown): CurrentDurableStnMailboxState {
  return freezeCurrentState(json(value, "Hosted Gmail disposition state") as CurrentDurableStnMailboxState);
}

function parseReceiptJson(value: unknown): MailDeliveryReceipt {
  return settledReceipt(freezeMailDeliveryReceipt(json(value, "Hosted Gmail disposition receipt") as MailDeliveryReceipt));
}

function parseRecordJson(value: unknown): GmailMailboxDispositionEffectRecord {
  const source = record(json(value, "Hosted Gmail disposition effect record"), "Hosted Gmail disposition effect record");
  const status = effectStatus(source.status);
  const phase = source.reconciliationPhase === null ? null : reconciliationPhase(source.reconciliationPhase);
  const outcome = source.settledOutcome === null ? null : settledOutcome(source.settledOutcome);
  if ((status === "settled") !== (outcome !== null)) {
    throw new TypeError("Hosted Gmail disposition settlement state is invalid");
  }
  if ((status === "reconciliation_required") !== (phase !== null)) {
    throw new TypeError("Hosted Gmail disposition reconciliation state is invalid");
  }
  return Object.freeze({
    effect: freezeEffect(source.effect as GmailMailboxDispositionEffect),
    status,
    reconciliationPhase: phase,
    settledOutcome: outcome,
  });
}

function freezeCurrentState(input: CurrentDurableStnMailboxState): CurrentDurableStnMailboxState {
  if (!input || input.source !== "durable_stn_state") {
    throw new TypeError("operator attention must come from current durable STN state");
  }
  if (input.state !== "active" && input.state !== "waiting" && input.state !== "resolved") {
    throw new TypeError("current STN mailbox state is invalid");
  }
  if (
    input.attentionClass !== "handoff"
    && input.attentionClass !== "review"
    && input.attentionClass !== "decision"
    && input.attentionClass !== "incident"
  ) throw new TypeError("current STN attention class is invalid");
  if (typeof input.operatorAttentionRequired !== "boolean") {
    throw new TypeError("operatorAttentionRequired must be boolean");
  }
  return Object.freeze({
    source: "durable_stn_state",
    stnThreadId: exact(input.stnThreadId, "STN thread ID", 240),
    revision: exact(input.revision, "STN state revision", 320),
    attentionClass: input.attentionClass,
    operatorAttentionRequired: input.operatorAttentionRequired,
    state: input.state,
  });
}

function freezeBinding(input: SettledGmailMessageBinding): SettledGmailMessageBinding {
  if (!input || input.source !== "settled_gmail_message_binding" || input.provider !== "gmail") {
    throw new TypeError("Hosted Gmail disposition binding is invalid");
  }
  return Object.freeze({
    source: "settled_gmail_message_binding",
    provider: "gmail",
    stnThreadId: exact(input.stnThreadId, "STN thread ID", 240),
    accountBinding: exact(input.accountBinding, "Gmail account binding", 320),
    mailboxAddress: exact(input.mailboxAddress, "Gmail mailbox address", 320),
    providerThreadId: exact(input.providerThreadId, "Gmail thread ID", 320),
    providerMessageId: exact(input.providerMessageId, "Gmail message ID", 320),
    stensiblyLabelId: exact(input.stensiblyLabelId, "Stensibly label ID", 160),
  });
}

function freezeEffect(input: GmailMailboxDispositionEffect): GmailMailboxDispositionEffect {
  if (!input || input.version !== "gmail-mailbox-disposition-effect/v1" || input.authorizesMailSend !== false) {
    throw new TypeError("Hosted Gmail disposition effect is invalid");
  }
  const binding = freezeBinding(input.binding);
  if (input.disposition.label !== "Stensibly" || typeof input.disposition.archive !== "boolean" || typeof input.disposition.markRead !== "boolean") {
    throw new TypeError("Hosted Gmail disposition policy is invalid");
  }
  if (!isDispositionReason(input.disposition.reason)) throw new TypeError("Hosted Gmail disposition reason is invalid");
  const requiredLabelIds = labels(input.requiredLabelIds);
  const forbiddenLabelIds = labels(input.forbiddenLabelIds);
  return Object.freeze({
    version: "gmail-mailbox-disposition-effect/v1",
    effectId: exact(input.effectId, "Gmail disposition effect ID", 4096),
    binding,
    stnStateRevision: exact(input.stnStateRevision, "STN state revision", 320),
    disposition: Object.freeze({ ...input.disposition }),
    requiredLabelIds,
    forbiddenLabelIds,
    authorizesMailSend: false,
  });
}

function settledReceipt(input: MailDeliveryReceipt): MailDeliveryReceipt {
  const receipt = freezeMailDeliveryReceipt(input);
  if (
    receipt.provider !== "gmail"
    || (receipt.result !== "sent" && receipt.result !== "reconciled")
    || receipt.providerThreadId === null
    || receipt.providerMessageId === null
  ) throw new TypeError("Hosted Gmail disposition requires a settled successful Gmail receipt");
  return receipt;
}

function effectStatus(value: unknown): GmailMailboxDispositionEffectRecord["status"] {
  if (value === "reserved" || value === "reconciliation_required" || value === "settled") return value;
  throw new TypeError("Hosted Gmail disposition effect status is invalid");
}

function reconciliationPhase(value: unknown): GmailMailboxDispositionReconciliationPhase {
  if (value === "interrupted" || value === "precondition_read" || value === "mutation_outcome" || value === "post_mutation_readback") return value;
  throw new TypeError("Hosted Gmail disposition reconciliation phase is invalid");
}

function settledOutcome(value: unknown): GmailMailboxDispositionSettledOutcome {
  if (value === "applied" || value === "noop" || value === "ignored_draft" || value === "reconciled") return value;
  throw new TypeError("Hosted Gmail disposition settled outcome is invalid");
}

function isDispositionReason(value: unknown): value is GmailMailboxDispositionEffect["disposition"]["reason"] {
  return value === "operator_attention" || value === "routine" || value === "waiting" || value === "resolved";
}

function labels(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 3) throw new TypeError("Hosted Gmail disposition labels are invalid");
  return Object.freeze([...new Set(value.map((entry) => exact(entry, "Gmail label ID", 160)))]);
}

function json(value: unknown, label: string): unknown {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 * 1024) {
    throw new TypeError(`${label} JSON is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value, label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function workspaceSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Hosted Gmail disposition workspace is invalid");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized) || normalized.length > 80) {
    throw new TypeError("Hosted Gmail disposition workspace is invalid");
  }
  return normalized;
}

function exact(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
