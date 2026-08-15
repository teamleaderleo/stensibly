import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.js";
import {
  exactMailThreadIdentifier,
  exactMailThreadSha256,
  exactMailThreadTimestamp,
  freezeMailThreadRecord,
  parseMailThreadHandle,
  type MailThreadRecord,
} from "./mail-thread-contract.js";
import {
  exactRfcMessageId,
  freezeMailboxBinding,
  freezeMailDeliveryReceipt,
  freezeMailProviderProjection,
  type MailDeliveryReceipt,
  type MailDeliveryReservation,
  type MailOutboundEffectRecord,
  type MailProviderProjection,
} from "./mail-provider.js";
import type {
  MailThreadReservation,
  MailThreadStore,
} from "./mail-thread-store.js";

export interface MailOutboundConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexMailThreadStoreOptions {
  client: MailOutboundConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexMailThreadStore implements MailThreadStore {
  readonly #client: MailOutboundConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexMailThreadStoreOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Hosted mail store options are required");
    if (!options.client || typeof options.client.query !== "function" || typeof options.client.mutation !== "function") {
      throw new TypeError("Hosted mail store Convex client is required");
    }
    this.#client = options.client;
    this.#serviceSecret = secret(options.serviceSecret);
    this.#workspace = workspaceSlug(options.workspace ?? "default");
  }

  async reserveThread(threadInput: MailThreadRecord): Promise<MailThreadReservation> {
    const thread = this.#thread(threadInput);
    const value = responseRecord(await this.#client.mutation(
      convexApi.mailOutbound.reserveThread,
      this.#args({ threadJson: JSON.stringify(thread) }),
    ), "Hosted mail thread reservation");
    const outcome = reservationOutcome(value.outcome);
    return Object.freeze({
      outcome,
      thread: parseThreadJson(value.threadJson, this.#workspace),
    });
  }

  async getThreadByHandle(handle: string): Promise<MailThreadRecord | null> {
    const value = await this.#client.query(
      convexApi.mailOutbound.getThreadByHandle,
      this.#args({ handle: parseMailThreadHandle(handle) }),
    );
    return value === null ? null : parseThreadJson(value, this.#workspace);
  }

  async getThreadBySource(
    workspace: string,
    project: string,
    sourceIdentity: string,
  ): Promise<MailThreadRecord | null> {
    if (workspaceSlug(workspace) !== this.#workspace) throw new Error("Hosted mail store workspace conflict");
    const value = await this.#client.query(
      convexApi.mailOutbound.getThreadBySource,
      this.#args({
        project: exactMailThreadIdentifier(project, "Mail project", 120),
        sourceIdentity: exactMailThreadIdentifier(sourceIdentity, "Mail source identity", 320),
      }),
    );
    return value === null ? null : parseThreadJson(value, this.#workspace);
  }

  async updateThread(threadInput: MailThreadRecord): Promise<MailThreadRecord> {
    const thread = this.#thread(threadInput);
    const value = responseRecord(await this.#client.mutation(
      convexApi.mailOutbound.updateThread,
      this.#args({ threadJson: JSON.stringify(thread) }),
    ), "Hosted mail thread update");
    return parseThreadJson(value.threadJson, this.#workspace);
  }

  async getProviderProjection(
    threadId: string,
    provider: string,
    accountBinding: string,
  ): Promise<MailProviderProjection | null> {
    const binding = validationBinding(provider, accountBinding);
    const value = await this.#client.query(
      convexApi.mailOutbound.getProviderProjection,
      this.#args({
        threadId: exactMailThreadIdentifier(threadId, "Mail thread ID", 240),
        provider: binding.provider,
        accountBinding: binding.accountBinding,
      }),
    );
    return value === null ? null : parseProjectionJson(value);
  }

  async reserveDeliveryEffect(effectInput: MailOutboundEffectRecord): Promise<MailDeliveryReservation> {
    const effect = parseEffect(effectInput);
    const value = responseRecord(await this.#client.mutation(
      convexApi.mailOutbound.reserveEffect,
      this.#args({ effectJson: JSON.stringify(effect) }),
    ), "Hosted mail effect reservation");
    return Object.freeze({
      outcome: effectReservationOutcome(value.outcome),
      effect: parseEffectJson(value.effectJson),
    });
  }

  async settleDeliveryEffect(input: {
    effect: MailOutboundEffectRecord;
    receipt: MailDeliveryReceipt;
    projection?: MailProviderProjection | null;
  }): Promise<MailOutboundEffectRecord> {
    const effect = parseEffect(input.effect);
    const receipt = freezeMailDeliveryReceipt(input.receipt);
    const projection = input.projection === undefined || input.projection === null
      ? null
      : freezeMailProviderProjection(input.projection);
    const value = responseRecord(await this.#client.mutation(
      convexApi.mailOutbound.settleEffect,
      this.#args({
        effectJson: JSON.stringify(effect),
        receiptJson: JSON.stringify(receipt),
        ...(projection === null ? {} : { projectionJson: JSON.stringify(projection) }),
      }),
    ), "Hosted mail effect settlement");
    return parseEffectJson(value.effectJson);
  }

  async getDeliveryEffect(outboundEffectId: string): Promise<MailOutboundEffectRecord | null> {
    const value = await this.#client.query(
      convexApi.mailOutbound.getEffect,
      this.#args({
        outboundEffectId: exactMailThreadIdentifier(outboundEffectId, "Mail outbound effect ID", 240),
      }),
    );
    return value === null ? null : parseEffectJson(value);
  }

  async getDeliveryEffectByProviderMessageId(
    provider: string,
    accountBinding: string,
    providerMessageId: string,
  ): Promise<MailOutboundEffectRecord | null> {
    const binding = validationBinding(provider, accountBinding);
    const value = await this.#client.query(
      convexApi.mailOutbound.getEffectByProviderMessage,
      this.#args({
        provider: binding.provider,
        accountBinding: binding.accountBinding,
        providerMessageId: exactMailThreadIdentifier(providerMessageId, "Provider mail message ID", 320),
      }),
    );
    return value === null ? null : parseEffectJson(value);
  }

  #thread(input: MailThreadRecord): MailThreadRecord {
    const thread = freezeMailThreadRecord(input);
    if (thread.workspace !== this.#workspace) throw new Error("Hosted mail store workspace conflict");
    return thread;
  }

  #args(value: Record<string, unknown>): Record<string, unknown> {
    return {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      ...value,
    };
  }
}

function parseThreadJson(value: unknown, workspace: string): MailThreadRecord {
  const thread = freezeMailThreadRecord(json(value, "Hosted mail thread") as MailThreadRecord);
  if (thread.workspace !== workspace) throw new Error("Hosted mail thread workspace conflict");
  return thread;
}

function parseProjectionJson(value: unknown): MailProviderProjection {
  return freezeMailProviderProjection(json(value, "Hosted mail projection") as MailProviderProjection);
}

function parseEffectJson(value: unknown): MailOutboundEffectRecord {
  return parseEffect(json(value, "Hosted mail effect") as MailOutboundEffectRecord);
}

function parseEffect(input: MailOutboundEffectRecord): MailOutboundEffectRecord {
  if (!input || typeof input !== "object" || input.version !== 1) throw new TypeError("Hosted mail effect is invalid");
  const binding = freezeMailboxBinding({
    provider: input.provider,
    accountBinding: input.accountBinding,
    mailboxAddress: input.mailboxAddress,
  });
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1 || input.attemptNumber > 64) {
    throw new TypeError("Hosted mail effect attempt is invalid");
  }
  if (!["reserved", "sent", "ambiguous", "failed", "reconciled"].includes(input.state)) {
    throw new TypeError("Hosted mail effect state is invalid");
  }
  const receipt = input.receipt === null ? null : freezeMailDeliveryReceipt(input.receipt);
  const effect: MailOutboundEffectRecord = Object.freeze({
    version: 1,
    outboundEffectId: exactMailThreadIdentifier(input.outboundEffectId, "Mail outbound effect ID", 240),
    threadId: exactMailThreadIdentifier(input.threadId, "Mail thread ID", 240),
    handle: parseMailThreadHandle(input.handle),
    provider: binding.provider,
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    attemptNumber: input.attemptNumber,
    contentFingerprint: exactMailThreadSha256(input.contentFingerprint, "Mail content fingerprint"),
    rfcMessageId: exactRfcMessageId(input.rfcMessageId),
    reservedAt: exactMailThreadTimestamp(input.reservedAt, "Mail reservation time"),
    state: input.state,
    receipt,
  });
  if ((effect.state === "reserved") !== (effect.receipt === null)) {
    throw new TypeError("Hosted mail effect state and receipt disagree");
  }
  if (receipt !== null && (!receiptMatchesEffect(receipt, effect) || receipt.result !== effect.state)) {
    throw new TypeError("Hosted mail effect receipt conflicts with identity");
  }
  return effect;
}

function receiptMatchesEffect(receipt: MailDeliveryReceipt, effect: MailOutboundEffectRecord): boolean {
  return receipt.outboundEffectId === effect.outboundEffectId
    && receipt.threadId === effect.threadId
    && receipt.handle === effect.handle
    && receipt.provider === effect.provider
    && receipt.accountBinding === effect.accountBinding
    && receipt.mailboxAddress === effect.mailboxAddress
    && receipt.attemptNumber === effect.attemptNumber
    && receipt.contentFingerprint === effect.contentFingerprint
    && receipt.rfcMessageId === effect.rfcMessageId;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} response is invalid`);
  return value as Record<string, unknown>;
}

function reservationOutcome(value: unknown): MailThreadReservation["outcome"] {
  if (value === "created" || value === "existing" || value === "handle_conflict" || value === "source_conflict") {
    return value;
  }
  throw new TypeError("Hosted mail thread reservation outcome is invalid");
}

function effectReservationOutcome(value: unknown): MailDeliveryReservation["outcome"] {
  if (value === "reserved" || value === "replay" || value === "conflict" || value === "blocked") return value;
  throw new TypeError("Hosted mail effect reservation outcome is invalid");
}

function validationBinding(provider: string, accountBinding: string) {
  return freezeMailboxBinding({ provider, accountBinding, mailboxAddress: "validation@example.invalid" });
}

function workspaceSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Hosted mail workspace is invalid");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized) || normalized.length > 80) {
    throw new TypeError("Hosted mail workspace is invalid");
  }
  return normalized;
}

function secret(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new TypeError("Hosted mail service secret is required");
  }
  return value;
}
