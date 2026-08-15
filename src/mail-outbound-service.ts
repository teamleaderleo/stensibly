import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "./canonical-json.js";
import {
  createMailThreadRecord,
  generateMailThreadHandle,
  parseMailThreadHandle,
  updateMailThreadMaterial,
  type MailThreadClass,
  type MailThreadHandle,
  type MailThreadRecord,
  type MailThreadState,
} from "./mail-thread-contract.js";
import {
  renderMailOutboundEnvelope,
  type MailContinuationRoute,
  type MailOutboundEnvelope,
  type MailSourceReference,
} from "./mail-outbound-envelope.js";
import {
  MailProviderAmbiguousFailure,
  MailProviderDefiniteFailure,
  freezeMailboxBinding,
  freezeMailDeliveryReceipt,
  freezeMailProviderMessage,
  freezeMailProviderProjection,
  type MailboxBinding,
  type MailDeliveryReceipt,
  type MailOutboundEffectRecord,
  type MailProvider,
  type MailProviderMessage,
  type MailProviderProjection,
  type MailProviderRfcMessageIdMode,
  type MailProviderSendResult,
} from "./mail-provider.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export interface PublishMailThreadCommand {
  workspace: string;
  project: string;
  threadClass: MailThreadClass;
  sourceIdentity: string;
  canonicalSubject: string;
  sourceFingerprint: string;
  whatChanged: string;
  attentionReason: string;
  nextAction: string;
  sourceObject: string;
  sourceRevision?: string | null;
  blocker?: string | null;
  resolutionCondition: string;
  threadState: MailThreadState;
  continuationRoute?: MailContinuationRoute | null;
  references?: readonly MailSourceReference[];
  continuesFromHandle?: string | null;
  mailbox: MailboxBinding;
}

export interface MailPublishResult {
  thread: MailThreadRecord;
  envelope: MailOutboundEnvelope;
  receipt: MailDeliveryReceipt;
  projection: MailProviderProjection | null;
  outcome: "sent" | "replayed" | "failed" | "reconciled";
}

export interface MailOutboundServiceDependencies {
  store: MailThreadStore;
  provider: MailProvider;
  now?: () => string;
  threadIdFactory?: () => string;
  handleFactory?: (threadClass: MailThreadClass) => MailThreadHandle;
}

export class MailDeliveryPendingReconciliationError extends Error {
  readonly effect: MailOutboundEffectRecord;
  constructor(effect: MailOutboundEffectRecord) {
    super("Mail delivery requires reconciliation before another provider dispatch");
    this.name = "MailDeliveryPendingReconciliationError";
    this.effect = effect;
  }
}

export class MailDeliveryConflictError extends Error {
  readonly effect: MailOutboundEffectRecord;
  constructor(effect: MailOutboundEffectRecord) {
    super("Mail outbound effect identity conflicts with a durable prior effect");
    this.name = "MailDeliveryConflictError";
    this.effect = effect;
  }
}

export class MailThreadSourceConflictError extends Error {
  readonly thread: MailThreadRecord;
  constructor(thread: MailThreadRecord) {
    super("Mail thread source identity is already bound to incompatible canonical thread identity");
    this.name = "MailThreadSourceConflictError";
    this.thread = thread;
  }
}

export class MailProjectionReceiptMismatchError extends Error {
  readonly thread: MailThreadRecord;
  readonly projection: MailProviderProjection;
  constructor(thread: MailThreadRecord, projection: MailProviderProjection) {
    super("Mail provider projection has no matching durable outbound effect receipt");
    this.name = "MailProjectionReceiptMismatchError";
    this.thread = thread;
    this.projection = projection;
  }
}

export class MailDestinationBindingConflictError extends Error {
  readonly thread: MailThreadRecord;
  constructor(thread: MailThreadRecord) {
    super("Mail provider destination changed for an existing canonical provider projection");
    this.name = "MailDestinationBindingConflictError";
    this.thread = thread;
  }
}

export class MailOutboundService {
  readonly #store: MailThreadStore;
  readonly #provider: MailProvider;
  readonly #now: () => string;
  readonly #threadIdFactory: () => string;
  readonly #handleFactory: (threadClass: MailThreadClass) => MailThreadHandle;

  constructor(dependencies: MailOutboundServiceDependencies) {
    this.#store = dependencies.store;
    this.#provider = dependencies.provider;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#threadIdFactory = dependencies.threadIdFactory ?? (() => `mail_thread_${randomUUID()}`);
    this.#handleFactory = dependencies.handleFactory ?? ((threadClass) => generateMailThreadHandle(threadClass));
  }

  async publish(command: PublishMailThreadCommand): Promise<MailPublishResult> {
    const binding = freezeMailboxBinding(command.mailbox);
    if (binding.provider !== this.#provider.provider) {
      throw new TypeError("Mail outbound service provider does not match mailbox binding");
    }

    let thread = await this.#ensureThread(command);
    const envelope = renderMailOutboundEnvelope({
      thread,
      sourceFingerprint: command.sourceFingerprint,
      whatChanged: command.whatChanged,
      attentionReason: command.attentionReason,
      nextAction: command.nextAction,
      sourceObject: command.sourceObject,
      sourceRevision: command.sourceRevision,
      blocker: command.blocker,
      resolutionCondition: command.resolutionCondition,
      threadState: command.threadState,
      continuationRoute: command.continuationRoute,
      references: command.references,
    });

    const existingProjection = await this.#store.getProviderProjection(
      thread.threadId,
      binding.provider,
      binding.accountBinding,
    );
    assertProjectionDestination(thread, existingProjection, binding);

    if (
      thread.currentMaterialFingerprint !== envelope.materialFingerprint
      || thread.resolutionCondition !== envelope.resolutionCondition
      || thread.state !== envelope.threadState
    ) {
      thread = await this.#store.updateThread(updateMailThreadMaterial(thread, {
        materialFingerprint: envelope.materialFingerprint,
        resolutionCondition: envelope.resolutionCondition,
        state: envelope.threadState,
        updatedAt: this.#now(),
      }));
    }

    let effect = createEffect(
      thread,
      envelope,
      binding,
      this.#provider.rfcMessageIdMode,
      this.#now(),
    );
    const reservation = await this.#store.reserveDeliveryEffect(effect);
    if (reservation.outcome === "conflict") throw new MailDeliveryConflictError(reservation.effect);
    if (reservation.outcome === "blocked") throw new MailDeliveryPendingReconciliationError(reservation.effect);
    if (reservation.outcome === "replay") {
      return await this.#replayResult(reservation.effect, thread, envelope, existingProjection);
    }
    effect = reservation.effect;

    const message = createProviderMessage(thread, envelope, effect, existingProjection);
    let providerResult: MailProviderSendResult;
    try {
      providerResult = existingProjection
        ? await this.#provider.replyThread(binding, existingProjection, message)
        : await this.#provider.createThread(binding, message);
    } catch (error) {
      if (error instanceof MailProviderDefiniteFailure) {
        const settled = await this.#store.settleDeliveryEffect({ effect, receipt: failedReceipt(effect, error.code) });
        return { thread, envelope, receipt: settled.receipt!, projection: existingProjection, outcome: "failed" };
      }
      const code = error instanceof MailProviderAmbiguousFailure ? error.code : "mail_provider_outcome_ambiguous";
      const settled = await this.#store.settleDeliveryEffect({ effect, receipt: ambiguousReceipt(effect, code) });
      throw new MailDeliveryPendingReconciliationError(settled);
    }

    if (effect.rfcMessageId !== null && providerResult.rfcMessageId !== effect.rfcMessageId) {
      const settled = await this.#store.settleDeliveryEffect({
        effect,
        receipt: ambiguousReceipt(effect, "mail_provider_message_identity_mismatch"),
      });
      throw new MailDeliveryPendingReconciliationError(settled);
    }

    let projection: MailProviderProjection;
    try {
      projection = projectionFromSend(thread, binding, envelope, message, providerResult, existingProjection);
    } catch (error) {
      const code = error instanceof MailProviderAmbiguousFailure ? error.code : "mail_provider_projection_invalid";
      const settled = await this.#store.settleDeliveryEffect({ effect, receipt: ambiguousReceipt(effect, code) });
      throw new MailDeliveryPendingReconciliationError(settled);
    }

    const settled = await this.#store.settleDeliveryEffect({
      effect,
      receipt: sentReceipt(effect, providerResult),
      projection,
    });
    return { thread, envelope, receipt: settled.receipt!, projection, outcome: "sent" };
  }

  async reconcile(input: { outboundEffectId: string; mailbox: MailboxBinding }): Promise<MailPublishResult | null> {
    const binding = freezeMailboxBinding(input.mailbox);
    if (binding.provider !== this.#provider.provider) {
      throw new TypeError("Mail reconciliation provider does not match mailbox binding");
    }
    let effect = await this.#store.getDeliveryEffect(input.outboundEffectId);
    if (!effect) return null;
    const thread = await this.#store.getThreadByHandle(effect.handle);
    if (
      !thread
      || thread.threadId !== effect.threadId
      || effect.provider !== binding.provider
      || effect.accountBinding !== binding.accountBinding
      || effect.mailboxAddress !== binding.mailboxAddress
    ) throw new MailDeliveryConflictError(effect);

    const projection = await this.#store.getProviderProjection(thread.threadId, binding.provider, binding.accountBinding);
    assertProjectionDestination(thread, projection, binding);
    const envelope = envelopeFromEffect(thread, effect);

    if (effect.state === "sent" || effect.state === "reconciled" || effect.state === "failed") {
      return {
        thread,
        envelope,
        receipt: effect.receipt!,
        projection,
        outcome: effect.state === "failed" ? "failed" : "replayed",
      };
    }
    if (effect.state === "reserved") {
      effect = await this.#store.settleDeliveryEffect({
        effect,
        receipt: ambiguousReceipt(effect, "mail_delivery_reservation_unsettled"),
      });
    }

    const lookup = await this.#provider.getDeliveryProjection(binding, {
      outboundEffectId: effect.outboundEffectId,
      rfcMessageId: effect.rfcMessageId,
      expectedProviderThreadId: projection?.providerThreadId ?? null,
    });
    if (lookup.status === "found") {
      const message = createProviderMessage(thread, envelope, effect, projection);
      let nextProjection: MailProviderProjection;
      try {
        nextProjection = projectionFromSend(thread, binding, envelope, message, lookup.result, projection);
      } catch {
        throw new MailDeliveryPendingReconciliationError(effect);
      }
      const settled = await this.#store.settleDeliveryEffect({
        effect,
        receipt: reconciledReceipt(effect, lookup.result),
        projection: nextProjection,
      });
      return { thread, envelope, receipt: settled.receipt!, projection: nextProjection, outcome: "reconciled" };
    }
    if (lookup.status === "missing" && lookup.coverage === "complete") {
      const settled = await this.#store.settleDeliveryEffect({
        effect,
        receipt: failedReceipt(effect, "mail_delivery_missing_after_complete_reconciliation"),
      });
      return { thread, envelope, receipt: settled.receipt!, projection, outcome: "failed" };
    }
    throw new MailDeliveryPendingReconciliationError(effect);
  }

  async getThreadByHandle(handle: string): Promise<MailThreadRecord | null> {
    return this.#store.getThreadByHandle(parseMailThreadHandle(handle));
  }

  async #ensureThread(command: PublishMailThreadCommand): Promise<MailThreadRecord> {
    const parent = command.continuesFromHandle === undefined || command.continuesFromHandle === null
      ? null
      : await this.#store.getThreadByHandle(parseMailThreadHandle(command.continuesFromHandle));
    if (command.continuesFromHandle && !parent) throw new Error("Mail continuation parent handle is missing");
    const existing = await this.#store.getThreadBySource(command.workspace, command.project, command.sourceIdentity);
    if (existing) {
      assertThreadMatchesCommand(existing, command, parent);
      return existing;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = createMailThreadRecord({
        threadId: this.#threadIdFactory(),
        handle: this.#handleFactory(command.threadClass),
        workspace: command.workspace,
        project: command.project,
        threadClass: command.threadClass,
        canonicalSubject: command.canonicalSubject,
        sourceIdentity: command.sourceIdentity,
        resolutionCondition: command.resolutionCondition,
        continuesFromThreadId: parent?.threadId ?? null,
        createdAt: this.#now(),
      });
      const reservation = await this.#store.reserveThread(candidate);
      if (reservation.outcome === "created" || reservation.outcome === "existing" || reservation.outcome === "source_conflict") {
        assertThreadMatchesCommand(reservation.thread, command, parent);
        return reservation.thread;
      }
    }
    throw new Error("Mail thread handle allocation exhausted collision retries");
  }

  async #replayResult(
    effect: MailOutboundEffectRecord,
    thread: MailThreadRecord,
    envelope: MailOutboundEnvelope,
    projection: MailProviderProjection | null,
  ): Promise<MailPublishResult> {
    if (effect.state === "reserved" || effect.state === "ambiguous") throw new MailDeliveryPendingReconciliationError(effect);
    if (!effect.receipt) throw new Error("Terminal mail delivery effect is missing its receipt");
    return { thread, envelope, receipt: effect.receipt, projection, outcome: effect.state === "failed" ? "failed" : "replayed" };
  }
}

function assertThreadMatchesCommand(thread: MailThreadRecord, command: PublishMailThreadCommand, parent: MailThreadRecord | null): void {
  if (
    thread.workspace !== command.workspace
    || thread.project !== command.project
    || thread.threadClass !== command.threadClass
    || thread.canonicalSubject !== command.canonicalSubject
    || thread.sourceIdentity !== command.sourceIdentity
    || thread.continuesFromThreadId !== (parent?.threadId ?? null)
  ) throw new MailThreadSourceConflictError(thread);
}

function assertProjectionDestination(thread: MailThreadRecord, projection: MailProviderProjection | null, binding: MailboxBinding): void {
  if (projection && projection.mailboxAddress !== binding.mailboxAddress) throw new MailDestinationBindingConflictError(thread);
}

function createEffect(
  thread: MailThreadRecord,
  envelope: MailOutboundEnvelope,
  binding: MailboxBinding,
  rfcMessageIdMode: MailProviderRfcMessageIdMode,
  reservedAt: string,
): MailOutboundEffectRecord {
  if (rfcMessageIdMode !== "caller_assigned" && rfcMessageIdMode !== "provider_assigned") {
    throw new TypeError("Mail provider RFC Message-ID mode is invalid");
  }
  const digest = sha256(stableJson({
    version: 1,
    threadId: thread.threadId,
    provider: binding.provider,
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    contentFingerprint: envelope.materialFingerprint,
  }));
  const hex = digest.slice("sha256:".length);
  return Object.freeze({
    version: 1,
    outboundEffectId: `mailfx_${hex.slice(0, 40)}`,
    threadId: thread.threadId,
    handle: thread.handle,
    provider: binding.provider,
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    attemptNumber: 1,
    contentFingerprint: envelope.materialFingerprint,
    rfcMessageId: rfcMessageIdMode === "caller_assigned" ? `<stn.${hex}@mail.stensibly.com>` : null,
    reservedAt,
    state: "reserved",
    receipt: null,
  });
}

function createProviderMessage(
  thread: MailThreadRecord,
  envelope: MailOutboundEnvelope,
  effect: MailOutboundEffectRecord,
  projection: MailProviderProjection | null,
): MailProviderMessage {
  const latestRfcMessageId = effect.rfcMessageId === null ? null : projection?.latestRfcMessageId ?? null;
  const references = latestRfcMessageId === null
    ? []
    : appendReference(projection?.lastVerifiedReferences ?? [], latestRfcMessageId);
  return freezeMailProviderMessage({
    outboundEffectId: effect.outboundEffectId,
    threadId: thread.threadId,
    handle: thread.handle,
    contentFingerprint: effect.contentFingerprint,
    rfcMessageId: effect.rfcMessageId,
    subject: envelope.subject,
    body: envelope.body,
    inReplyTo: latestRfcMessageId,
    references,
  });
}

function appendReference(prior: readonly string[], latest: string): readonly string[] {
  const next = prior.includes(latest) ? [...prior] : [...prior, latest];
  return Object.freeze(next.slice(-32));
}

function projectionFromSend(
  thread: MailThreadRecord,
  binding: MailboxBinding,
  envelope: MailOutboundEnvelope,
  message: MailProviderMessage,
  result: MailProviderSendResult,
  existing: MailProviderProjection | null,
): MailProviderProjection {
  if (existing && result.providerThreadId !== existing.providerThreadId) {
    throw new MailProviderAmbiguousFailure("mail_provider_reply_thread_changed");
  }
  if (existing && existing.mailboxAddress !== binding.mailboxAddress) {
    throw new MailProviderAmbiguousFailure("mail_provider_reply_destination_changed");
  }
  return freezeMailProviderProjection({
    version: 1,
    threadId: thread.threadId,
    provider: binding.provider,
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    providerThreadId: result.providerThreadId,
    rootProviderMessageId: existing?.rootProviderMessageId ?? result.providerMessageId,
    latestProviderMessageId: result.providerMessageId,
    rootRfcMessageId: existing?.rootRfcMessageId ?? result.rfcMessageId,
    latestRfcMessageId: result.rfcMessageId,
    latestSentFingerprint: message.contentFingerprint,
    lastVerifiedSubject: envelope.subject,
    lastVerifiedReferences: message.references,
    verifiedAt: result.acceptedAt,
  });
}

function sentReceipt(effect: MailOutboundEffectRecord, result: MailProviderSendResult): MailDeliveryReceipt {
  return freezeMailDeliveryReceipt({
    version: 1,
    outboundEffectId: effect.outboundEffectId,
    threadId: effect.threadId,
    handle: effect.handle,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: effect.mailboxAddress,
    attemptNumber: effect.attemptNumber,
    contentFingerprint: effect.contentFingerprint,
    rfcMessageId: effect.rfcMessageId,
    providerRequestId: result.providerRequestId,
    providerThreadId: result.providerThreadId,
    providerMessageId: result.providerMessageId,
    attemptedAt: effect.reservedAt,
    result: "sent",
    failureClass: null,
    recoveryAction: "none",
    containsSecrets: false,
  });
}

function reconciledReceipt(effect: MailOutboundEffectRecord, result: MailProviderSendResult): MailDeliveryReceipt {
  return freezeMailDeliveryReceipt({ ...sentReceipt(effect, result), result: "reconciled" });
}

function ambiguousReceipt(effect: MailOutboundEffectRecord, failureClass: string): MailDeliveryReceipt {
  return freezeMailDeliveryReceipt({
    version: 1,
    outboundEffectId: effect.outboundEffectId,
    threadId: effect.threadId,
    handle: effect.handle,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: effect.mailboxAddress,
    attemptNumber: effect.attemptNumber,
    contentFingerprint: effect.contentFingerprint,
    rfcMessageId: effect.rfcMessageId,
    providerRequestId: null,
    providerThreadId: null,
    providerMessageId: null,
    attemptedAt: effect.reservedAt,
    result: "ambiguous",
    failureClass,
    recoveryAction: "reconcile_before_retry",
    containsSecrets: false,
  });
}

function failedReceipt(effect: MailOutboundEffectRecord, failureClass: string): MailDeliveryReceipt {
  return freezeMailDeliveryReceipt({
    version: 1,
    outboundEffectId: effect.outboundEffectId,
    threadId: effect.threadId,
    handle: effect.handle,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: effect.mailboxAddress,
    attemptNumber: effect.attemptNumber,
    contentFingerprint: effect.contentFingerprint,
    rfcMessageId: effect.rfcMessageId,
    providerRequestId: null,
    providerThreadId: null,
    providerMessageId: null,
    attemptedAt: effect.reservedAt,
    result: "failed",
    failureClass,
    recoveryAction: "retry_new_attempt",
    containsSecrets: false,
  });
}

function envelopeFromEffect(thread: MailThreadRecord, effect: MailOutboundEffectRecord): MailOutboundEnvelope {
  return Object.freeze({
    version: 1,
    threadId: thread.threadId,
    handle: thread.handle,
    subject: `[${thread.handle}] ${thread.canonicalSubject}`,
    body: `Continue ${thread.handle}.`,
    launchLine: `Continue ${thread.handle}.`,
    sourceFingerprint: effect.contentFingerprint,
    materialFingerprint: effect.contentFingerprint,
    sourceObject: thread.sourceIdentity,
    sourceRevision: null,
    resolutionCondition: thread.resolutionCondition,
    threadState: thread.state,
    containsSecrets: false,
  });
}
