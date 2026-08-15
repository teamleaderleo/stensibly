import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";
import { GmailMailboxDispositionApiClient } from "./gmail-mailbox-disposition-api.js";
import { consumeGmailMailboxDisposition } from "./gmail-mailbox-disposition-consumer.js";
import {
  reconcileGmailMailboxDispositionEffect,
  type CurrentDurableStnMailboxState,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffectRecord,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxLabelClient,
} from "./gmail-mailbox-disposition-effect.js";
import {
  GmailMailProvider,
  type GmailOutboundClient,
} from "./gmail-mail-provider.js";
import { GmailOutboundApiClient } from "./gmail-outbound-api.js";
import {
  MailDeliveryPendingReconciliationError,
  MailOutboundService,
  type MailPublishResult,
  type PublishMailThreadCommand,
} from "./mail-outbound-service.js";
import {
  freezeMailboxBinding,
  type MailDeliveryReceipt,
  type MailOutboundEffectRecord,
} from "./mail-provider.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export interface HostedGmailCurrentMailboxStateInput {
  revision: string;
  state: CurrentDurableStnMailboxState["state"];
  operatorAttentionRequired: boolean;
}

export type HostedGmailOutboundMaterial = Omit<
  PublishMailThreadCommand,
  "workspace" | "project" | "mailbox" | "continuationRoute"
> & {
  currentMailboxState: HostedGmailCurrentMailboxStateInput;
};

export interface HostedGmailOutboundBinding {
  workspace: string;
  project: string;
  accountBinding: string;
  mailboxAddress: string;
  stensiblyLabelId: string;
  sourceSystem?: string;
}

export interface HostedGmailMailboxDispositionStore
extends CurrentDurableStnMailboxStateReader, GmailMailboxDispositionEffectStore {
  putCurrentState(
    state: CurrentDurableStnMailboxState,
    expectedRevision?: string | null,
  ): Promise<CurrentDurableStnMailboxState>;
  recordSettledDelivery(receipt: MailDeliveryReceipt): Promise<MailDeliveryReceipt>;
  getSettledDelivery(stnThreadId: string): Promise<MailDeliveryReceipt | null>;
  getEffectRecord(effectId: string): Promise<GmailMailboxDispositionEffectRecord | null>;
}

export interface HostedGmailOutboundServiceOptions {
  store: MailThreadStore;
  gmailClient: GmailOutboundClient;
  mailboxDispositionStore: HostedGmailMailboxDispositionStore;
  gmailLabelClient: GmailMailboxLabelClient;
  binding: HostedGmailOutboundBinding;
  now?: () => string;
}

export interface CreateHostedGmailOutboundServiceOptions
  extends Omit<HostedGmailOutboundServiceOptions, "gmailClient" | "gmailLabelClient"> {
  tokenProvider: GmailAccessTokenProvider;
  gmailApiBaseUrl?: string;
  fetch?: typeof fetch;
}

export type HostedGmailMailboxDispositionReceipt =
  | {
      status: "settled";
      stnThreadId: string;
      stnStateRevision: string;
      providerMessageId: string;
      effectId: string;
      outcome: "applied" | "noop" | "ignored_draft" | "reconciled";
    }
  | {
      status: "reconciliation_required";
      stnThreadId: string;
      stnStateRevision: string;
      providerMessageId: string;
      effectId: string;
      phase: "interrupted" | "precondition_read" | "mutation_outcome" | "post_mutation_readback";
    }
  | {
      status: "blocked";
      stnThreadId: string;
      stnStateRevision: string;
      providerMessageId: string | null;
      reason: string;
    }
  | {
      status: "awaiting_delivery";
      stnThreadId: string;
      stnStateRevision: string;
      providerMessageId: null;
    };

export interface HostedGmailPublishResult extends MailPublishResult {
  mailboxDisposition: HostedGmailMailboxDispositionReceipt | null;
}

export class HostedGmailOutboundService {
  readonly #store: MailThreadStore;
  readonly #service: MailOutboundService;
  readonly #mailboxDispositionStore: HostedGmailMailboxDispositionStore;
  readonly #gmailLabelClient: GmailMailboxLabelClient;
  readonly #workspace: string;
  readonly #project: string;
  readonly #mailbox: Readonly<{
    provider: "gmail";
    accountBinding: string;
    mailboxAddress: string;
  }>;
  readonly #stensiblyLabelId: string;
  readonly #sourceSystem: string;

  constructor(options: HostedGmailOutboundServiceOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Hosted Gmail outbound options are required");
    this.#store = options.store;
    this.#mailboxDispositionStore = options.mailboxDispositionStore;
    this.#gmailLabelClient = options.gmailLabelClient;
    this.#workspace = workspaceSlug(options.binding.workspace);
    this.#project = identifier(options.binding.project, "Hosted Gmail project", 120);
    const mailbox = freezeMailboxBinding({
      provider: "gmail",
      accountBinding: options.binding.accountBinding,
      mailboxAddress: options.binding.mailboxAddress,
    });
    this.#mailbox = Object.freeze({
      provider: "gmail",
      accountBinding: mailbox.accountBinding,
      mailboxAddress: mailbox.mailboxAddress,
    });
    this.#stensiblyLabelId = identifier(options.binding.stensiblyLabelId, "Stensibly label ID", 160);
    if (this.#stensiblyLabelId === "INBOX" || this.#stensiblyLabelId === "UNREAD" || this.#stensiblyLabelId === "DRAFT") {
      throw new TypeError("Hosted Gmail Stensibly label must be an existing non-system label");
    }
    this.#sourceSystem = presentationName(options.binding.sourceSystem ?? "GitHub", "Hosted Gmail source system");
    this.#service = new MailOutboundService({
      store: options.store,
      provider: new GmailMailProvider(options.gmailClient, { now: options.now }),
      now: options.now,
    });
  }

  async publish(material: HostedGmailOutboundMaterial): Promise<HostedGmailPublishResult> {
    const { currentMailboxState, ...outboundMaterial } = material;
    validateMailboxStateAgainstOutbound(currentMailboxState, outboundMaterial.threadState);
    let result: MailPublishResult;
    try {
      result = await this.#service.publish({
        ...outboundMaterial,
        workspace: this.#workspace,
        project: this.#project,
        mailbox: this.#mailbox,
        continuationRoute: {
          mailProvider: "Gmail",
          sourceSystem: this.#sourceSystem,
        },
      });
    } catch (error) {
      if (error instanceof MailDeliveryPendingReconciliationError) {
        // Seed-only: a different durable revision that arrived while delivery was in flight wins.
        await this.#mailboxDispositionStore.putCurrentState(currentState(
          error.effect.threadId,
          outboundMaterial.threadClass,
          currentMailboxState,
        ));
      }
      throw error;
    }

    // Seed-only after settlement. If a newer durable revision already exists, it is retained;
    // consumeGmailMailboxDisposition will reread and converge that durable winner.
    await this.#mailboxDispositionStore.putCurrentState(currentState(
      result.thread.threadId,
      outboundMaterial.threadClass,
      currentMailboxState,
    ));
    const mailboxDisposition = isSettledSuccessfulReceipt(result.receipt)
      ? await this.#converge(result.receipt)
      : null;
    return Object.freeze({ ...result, mailboxDisposition });
  }

  async reconcile(outboundEffectId: string): Promise<HostedGmailPublishResult | null> {
    const result = await this.#service.reconcile({
      outboundEffectId: identifier(outboundEffectId, "Hosted Gmail outbound effect ID", 240),
      mailbox: this.#mailbox,
    });
    if (result === null) return null;
    const mailboxDisposition = isSettledSuccessfulReceipt(result.receipt)
      ? await this.#converge(result.receipt)
      : null;
    return Object.freeze({ ...result, mailboxDisposition });
  }

  async updateCurrentMailboxState(
    stateInput: CurrentDurableStnMailboxState,
  ): Promise<HostedGmailMailboxDispositionReceipt> {
    const prior = await this.#mailboxDispositionStore.readCurrentState({
      stnThreadId: stateInput.stnThreadId,
    });
    const state = await this.#mailboxDispositionStore.putCurrentState(
      stateInput,
      prior?.revision ?? null,
    );
    const receipt = await this.#mailboxDispositionStore.getSettledDelivery(state.stnThreadId);
    if (receipt === null) {
      return Object.freeze({
        status: "awaiting_delivery",
        stnThreadId: state.stnThreadId,
        stnStateRevision: state.revision,
        providerMessageId: null,
      });
    }
    return await this.#converge(receipt);
  }

  async getCurrentMailboxState(stnThreadId: string) {
    return await this.#mailboxDispositionStore.readCurrentState({
      stnThreadId: identifier(stnThreadId, "Hosted Gmail STN thread ID", 240),
    });
  }

  async getMailboxDispositionEffect(effectId: string) {
    return await this.#mailboxDispositionStore.getEffectRecord(
      identifier(effectId, "Hosted Gmail disposition effect ID", 4096),
    );
  }

  async getThreadByHandle(handle: string) {
    return await this.#service.getThreadByHandle(handle);
  }

  async getKnownOutboundProviderMessage(
    providerMessageId: string,
  ): Promise<MailOutboundEffectRecord | null> {
    return await this.#store.getDeliveryEffectByProviderMessageId(
      "gmail",
      this.#mailbox.accountBinding,
      identifier(providerMessageId, "Hosted Gmail provider message ID", 320),
    );
  }

  async #converge(receiptInput: MailDeliveryReceipt): Promise<HostedGmailMailboxDispositionReceipt> {
    const receipt = await this.#mailboxDispositionStore.recordSettledDelivery(receiptInput);
    if (receipt.providerMessageId === null) throw new TypeError("Hosted Gmail disposition target message is missing");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let execution;
      try {
        execution = await consumeGmailMailboxDisposition({
          deliveryReceipt: receipt,
          stensiblyLabelId: this.#stensiblyLabelId,
          stateReader: this.#mailboxDispositionStore,
          labelClient: this.#gmailLabelClient,
          effectStore: this.#mailboxDispositionStore,
        });
      } catch (error) {
        const record = laneBlockedRecord(error);
        if (record === null) throw error;
        const recovered = await this.#reconcileRecord(record);
        if (recovered === "retry_current") continue;
        return recovered;
      }

      if (execution.status === "applied" || execution.status === "noop" || execution.status === "ignored_draft" || execution.status === "replayed") {
        return Object.freeze({
          status: "settled",
          stnThreadId: execution.effect.binding.stnThreadId,
          stnStateRevision: execution.effect.stnStateRevision,
          providerMessageId: execution.effect.binding.providerMessageId,
          effectId: execution.effect.effectId,
          outcome: execution.outcome,
        });
      }
      if (execution.status === "reconciliation_required") {
        const recovered = await this.#reconcileRecord({
          effect: execution.effect,
          status: "reconciliation_required",
          reconciliationPhase: execution.phase,
          settledOutcome: null,
        });
        if (recovered === "retry_current") continue;
        return recovered;
      }
      if (execution.status === "blocked_by_prior_reconciliation") {
        const record = await this.#mailboxDispositionStore.getEffectRecord(execution.outstandingEffectId);
        if (record === null) {
          return blockedReceipt(
            execution.effect.binding.stnThreadId,
            execution.effect.stnStateRevision,
            execution.effect.binding.providerMessageId,
            "prior_reconciliation_effect_missing",
          );
        }
        const recovered = await this.#reconcileRecord(record);
        if (recovered === "retry_current") continue;
        return recovered;
      }
      if (execution.status === "blocked") {
        return blockedReceipt(
          execution.effect?.binding.stnThreadId ?? receipt.threadId,
          execution.effect?.stnStateRevision ?? (await this.#requiredCurrentState(receipt.threadId)).revision,
          receipt.providerMessageId,
          execution.reason,
        );
      }
      throw new TypeError("Hosted Gmail disposition execution result is invalid");
    }

    const state = await this.#requiredCurrentState(receipt.threadId);
    return blockedReceipt(
      receipt.threadId,
      state.revision,
      receipt.providerMessageId,
      "disposition_convergence_bound_exhausted",
    );
  }

  async #reconcileRecord(
    record: GmailMailboxDispositionEffectRecord,
  ): Promise<HostedGmailMailboxDispositionReceipt | "retry_current"> {
    const phase = record.reconciliationPhase ?? "interrupted";
    const result = await reconcileGmailMailboxDispositionEffect({
      effect: record.effect,
      phase,
      stateReader: this.#mailboxDispositionStore,
      labelClient: this.#gmailLabelClient,
      effectStore: this.#mailboxDispositionStore,
    });
    if (result.status === "reconciled") {
      return Object.freeze({
        status: "settled",
        stnThreadId: result.effect.binding.stnThreadId,
        stnStateRevision: result.effect.stnStateRevision,
        providerMessageId: result.effect.binding.providerMessageId,
        effectId: result.effect.effectId,
        outcome: "reconciled",
      });
    }
    if (result.status === "retry_safe") return "retry_current";
    if (result.status === "superseded" && result.priorEffectCleared) return "retry_current";
    if (result.status === "pending") {
      return Object.freeze({
        status: "reconciliation_required",
        stnThreadId: result.effect.binding.stnThreadId,
        stnStateRevision: result.effect.stnStateRevision,
        providerMessageId: result.effect.binding.providerMessageId,
        effectId: result.effect.effectId,
        phase,
      });
    }
    if (result.status === "superseded") {
      return Object.freeze({
        status: "reconciliation_required",
        stnThreadId: result.effect.binding.stnThreadId,
        stnStateRevision: result.currentStateRevision,
        providerMessageId: result.effect.binding.providerMessageId,
        effectId: result.effect.effectId,
        phase,
      });
    }
    return blockedReceipt(
      result.effect.binding.stnThreadId,
      result.effect.stnStateRevision,
      result.effect.binding.providerMessageId,
      result.reason,
    );
  }

  async #requiredCurrentState(stnThreadId: string): Promise<CurrentDurableStnMailboxState> {
    const state = await this.#mailboxDispositionStore.readCurrentState({ stnThreadId });
    if (state === null) throw new Error("Hosted Gmail current disposition state is unavailable");
    return state;
  }
}

export function createHostedGmailOutboundService(
  options: CreateHostedGmailOutboundServiceOptions,
): HostedGmailOutboundService {
  const gmailClient = new GmailOutboundApiClient({
    tokenProvider: options.tokenProvider,
    apiBaseUrl: options.gmailApiBaseUrl,
    fetch: options.fetch,
  });
  const gmailLabelClient = new GmailMailboxDispositionApiClient({
    tokenProvider: options.tokenProvider,
    accountBinding: options.binding.accountBinding,
    mailboxAddress: options.binding.mailboxAddress,
    stensiblyLabelId: options.binding.stensiblyLabelId,
    apiBaseUrl: options.gmailApiBaseUrl,
    fetch: options.fetch,
  });
  return new HostedGmailOutboundService({
    store: options.store,
    gmailClient,
    mailboxDispositionStore: options.mailboxDispositionStore,
    gmailLabelClient,
    binding: options.binding,
    now: options.now,
  });
}

function currentState(
  stnThreadId: string,
  attentionClass: CurrentDurableStnMailboxState["attentionClass"],
  input: HostedGmailCurrentMailboxStateInput,
): CurrentDurableStnMailboxState {
  return Object.freeze({
    source: "durable_stn_state",
    stnThreadId: identifier(stnThreadId, "Hosted Gmail STN thread ID", 240),
    revision: identifier(input.revision, "Hosted Gmail STN state revision", 320),
    attentionClass,
    operatorAttentionRequired: input.operatorAttentionRequired,
    state: input.state,
  });
}

function validateMailboxStateAgainstOutbound(
  input: HostedGmailCurrentMailboxStateInput,
  outboundState: PublishMailThreadCommand["threadState"],
): void {
  identifier(input.revision, "Hosted Gmail STN state revision", 320);
  if (typeof input.operatorAttentionRequired !== "boolean") {
    throw new TypeError("Hosted Gmail operatorAttentionRequired must be boolean");
  }
  if (input.state === "active" && outboundState !== "open") {
    throw new TypeError("Hosted Gmail active mailbox state requires an open STN thread");
  }
  if (input.state === "waiting" && outboundState !== "quiet") {
    throw new TypeError("Hosted Gmail waiting mailbox state requires a quiet STN thread");
  }
  if (input.state === "resolved" && outboundState !== "resolved" && outboundState !== "superseded") {
    throw new TypeError("Hosted Gmail resolved mailbox state requires a terminal STN thread");
  }
  if (input.state !== "active" && input.state !== "waiting" && input.state !== "resolved") {
    throw new TypeError("Hosted Gmail mailbox state is invalid");
  }
}

function isSettledSuccessfulReceipt(receipt: MailDeliveryReceipt): boolean {
  return receipt.provider === "gmail"
    && (receipt.result === "sent" || receipt.result === "reconciled")
    && receipt.providerThreadId !== null
    && receipt.providerMessageId !== null;
}

function laneBlockedRecord(error: unknown): GmailMailboxDispositionEffectRecord | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; record?: unknown };
  if (candidate.name !== "GmailMailboxDispositionLaneBlockedError" || !candidate.record) return null;
  return candidate.record as GmailMailboxDispositionEffectRecord;
}

function blockedReceipt(
  stnThreadId: string,
  stnStateRevision: string,
  providerMessageId: string | null,
  reason: string,
): HostedGmailMailboxDispositionReceipt {
  return Object.freeze({
    status: "blocked",
    stnThreadId,
    stnStateRevision,
    providerMessageId,
    reason,
  });
}

function workspaceSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Hosted Gmail workspace is invalid");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized) || normalized.length > 80) {
    throw new TypeError("Hosted Gmail workspace is invalid");
  }
  return normalized;
}

function identifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+|%=-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function presentationName(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || value !== value.trim()
    || /[\r\n\u0000]/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}
