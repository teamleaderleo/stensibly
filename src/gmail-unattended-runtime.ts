import { GmailMailboxActionClient } from "./gmail-mailbox-actions.js";
import {
  GmailMailboxApiClient,
  type GmailLabelSnapshotMessage,
} from "./gmail-mailbox-api.js";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailMailboxReconciliationResult,
  type GmailPubSubNotification,
} from "./gmail-mailbox-intake.js";
import {
  HostedMailboxIntakeService,
  type DurableMailboxObservationProjection,
  type MailboxIntakeSnapshot,
} from "./mailbox-intake-convex-service.js";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export interface GmailUnattendedRuntimeOptions {
  mailboxAddress: string;
  mailboxBindingId: string;
  labelId: string;
  pubsubSubscription: string;
  gmail: GmailMailboxApiClient;
  actions: GmailMailboxActionClient;
  intake: HostedMailboxIntakeService;
  knownOutboundProviderMessageIds?: () => Promise<ReadonlySet<string>>;
  now?: () => string;
}

export interface GmailUnattendedResult {
  readonly duplicate: boolean;
  readonly revision: number;
  readonly cursor: string;
  readonly admittedObservations: number;
  readonly materialObservations: number;
  readonly archivedMessages: number;
  readonly recoveryAction: GmailMailboxReconciliationResult["recoveryAction"];
}

const renewalWindowMs = 24 * 60 * 60_000;

export class GmailUnattendedRuntime {
  readonly #mailboxAddress: string;
  readonly #mailboxBindingId: string;
  readonly #labelId: string;
  readonly #pubsubSubscription: string;
  readonly #gmail: GmailMailboxApiClient;
  readonly #actions: GmailMailboxActionClient;
  readonly #intake: HostedMailboxIntakeService;
  readonly #knownOutbound: (() => Promise<ReadonlySet<string>>) | undefined;
  readonly #now: () => string;

  constructor(options: GmailUnattendedRuntimeOptions) {
    this.#mailboxAddress = email(options.mailboxAddress);
    this.#mailboxBindingId = identity(options.mailboxBindingId, "Gmail mailbox binding ID");
    this.#labelId = identity(options.labelId, "Gmail watched label ID");
    this.#pubsubSubscription = identity(options.pubsubSubscription, "Gmail Pub/Sub subscription");
    this.#gmail = options.gmail;
    this.#actions = options.actions;
    this.#intake = options.intake;
    this.#knownOutbound = options.knownOutboundProviderMessageIds;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async bootstrapOrCatchUp(): Promise<GmailUnattendedResult> {
    await this.#gmail.verifyMailboxAddress(this.#mailboxAddress);
    let snapshot = await this.#intake.get(this.#mailboxBindingId);
    if (!snapshot) {
      const watch = await this.#gmail.renewWatch({
        labelIds: [this.#labelId],
        labelFilterBehavior: "include",
      });
      const now = this.#now();
      const state = createMailboxSubscriptionState({
        mailboxBindingId: this.#mailboxBindingId,
        provider: "gmail",
        scope: { kind: "label", externalId: this.#labelId },
        cursor: { kind: "gmail_history_id", value: watch.historyId },
        coverage: "continuous",
        subscription: {
          externalId: this.#pubsubSubscription,
          expiresAt: epochMillisToIso(watch.expiration),
          health: "healthy",
          recoveryReason: null,
        },
        lastNotificationId: null,
        lastSuccessfulReconciliationAt: now,
      });
      snapshot = await this.#intake.initialize(state);
      const archivedMessages = await this.#enforceQuietHandoffMailbox();
      return freezeResult(
        snapshot.revision,
        state.cursor.value,
        0,
        0,
        archivedMessages,
        false,
        null,
      );
    }
    if (requiresFullSync(snapshot.state)) {
      return await this.#recoverFullSync(snapshot, null);
    }
    return await this.#reconcile(
      snapshot,
      null,
      reconciliationId("periodic", snapshot.state.cursor.value, this.#now()),
    );
  }

  async receivePubSubEnvelope(envelope: unknown): Promise<GmailUnattendedResult> {
    const receivedAt = this.#now();
    const notification = parseGmailPubSubNotification(envelope, {
      expectedMailboxAddress: this.#mailboxAddress,
      expectedSubscription: this.#pubsubSubscription,
      mailboxBindingId: this.#mailboxBindingId,
      receivedAt,
    });
    await this.#gmail.verifyMailboxAddress(this.#mailboxAddress);
    const snapshot = await this.#intake.get(this.#mailboxBindingId);
    if (!snapshot) {
      throw new Error("Gmail mailbox binding must be bootstrapped before push delivery");
    }
    if (requiresFullSync(snapshot.state)) {
      return await this.#recoverFullSync(snapshot, notification);
    }
    return await this.#reconcile(
      snapshot,
      notification,
      reconciliationId("push", notification.notificationId),
    );
  }

  async listRecentMaterialObservations(
    limit = 100,
  ): Promise<readonly DurableMailboxObservationProjection[]> {
    return await this.#intake.listRecentMaterialObservations(
      this.#mailboxBindingId,
      limit,
    );
  }

  async #reconcile(
    snapshot: MailboxIntakeSnapshot,
    notification: GmailPubSubNotification | null,
    reconciliationIdValue: string,
  ): Promise<GmailUnattendedResult> {
    const knownOutboundProviderMessageIds = this.#knownOutbound
      ? await this.#knownOutbound()
      : undefined;
    const now = this.#now();
    const duplicateNotification = notification?.notificationId
      === snapshot.state.lastNotificationId;
    const forceRenewalCatchUp = notification !== null
      && notificationCovered(snapshot.state, notification)
      && watchRenewalDue(snapshot.state, now);
    const reconciliationNotification = forceRenewalCatchUp ? null : notification;
    const result = await reconcileGmailMailbox({
      state: snapshot.state,
      notification: reconciliationNotification,
      client: this.#gmail,
      now,
      ...(knownOutboundProviderMessageIds ? { knownOutboundProviderMessageIds } : {}),
    });
    const nextState = forceRenewalCatchUp && notification
      ? stateWithNotification(result.state, notification.notificationId)
      : result.state;

    if (
      duplicateNotification
      && result.observations.length === 0
      && canonicalState(nextState) === canonicalState(snapshot.state)
    ) {
      const archivedMessages = await this.#enforceQuietHandoffMailbox();
      return freezeResult(
        snapshot.revision,
        snapshot.state.cursor.value,
        0,
        0,
        archivedMessages,
        true,
        result.recoveryAction,
      );
    }

    let committed: MailboxIntakeSnapshot;
    let committedObservations = result.observations;
    try {
      committed = await this.#intake.commit({
        previous: snapshot,
        nextState,
        observations: result.observations,
        reconciliationId: reconciliationIdValue,
      });
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const winner = await this.#intake.get(this.#mailboxBindingId);
      if (!winner) throw new Error("Mailbox intake binding disappeared during reconciliation");
      if (
        result.observations.length === 0
        && compareHistoryIds(winner.state.cursor.value, nextState.cursor.value) >= 0
      ) {
        const archivedMessages = await this.#enforceQuietHandoffMailbox();
        return freezeResult(
          winner.revision,
          winner.state.cursor.value,
          0,
          0,
          archivedMessages,
          duplicateNotification,
          null,
        );
      }

      const retry = await reconcileGmailMailbox({
        state: winner.state,
        notification,
        client: this.#gmail,
        now: this.#now(),
        ...(knownOutboundProviderMessageIds ? { knownOutboundProviderMessageIds } : {}),
      });
      if (
        retry.observations.length === 0
        && canonicalState(retry.state) === canonicalState(winner.state)
      ) {
        const archivedMessages = await this.#enforceQuietHandoffMailbox();
        return freezeResult(
          winner.revision,
          winner.state.cursor.value,
          0,
          0,
          archivedMessages,
          notification?.notificationId === winner.state.lastNotificationId,
          retry.recoveryAction,
        );
      }
      committedObservations = retry.observations;
      committed = await this.#intake.commit({
        previous: winner,
        nextState: retry.state,
        observations: retry.observations,
        reconciliationId: `${reconciliationIdValue}:retry`,
      });
    }

    const materialObservations = committedObservations.filter((observation) =>
      observation.wakeEligible && observation.loopDisposition === "ordinary"
    ).length;
    const archivedMessages = await this.#enforceQuietHandoffMailbox();
    return freezeResult(
      committed.revision,
      committed.state.cursor.value,
      committedObservations.length,
      materialObservations,
      archivedMessages,
      duplicateNotification,
      result.recoveryAction,
    );
  }

  async #recoverFullSync(
    snapshot: MailboxIntakeSnapshot,
    notification: GmailPubSubNotification | null,
  ): Promise<GmailUnattendedResult> {
    const now = this.#now();
    const knownOutboundProviderMessageIds = this.#knownOutbound
      ? await this.#knownOutbound()
      : new Set<string>();
    const watch = await this.#gmail.renewWatch({
      labelIds: [this.#labelId],
      labelFilterBehavior: "include",
    });
    const baselineCursor = watch.historyId;
    if (compareHistoryIds(baselineCursor, snapshot.state.cursor.value) < 0) {
      throw new Error("Gmail full-sync watch cursor regressed");
    }
    const members = await this.#gmail.listLabelMessages(this.#labelId);
    const baselineState = createMailboxSubscriptionState({
      mailboxBindingId: this.#mailboxBindingId,
      provider: "gmail",
      scope: { kind: "label", externalId: this.#labelId },
      cursor: { kind: "gmail_history_id", value: baselineCursor },
      coverage: "continuous",
      subscription: {
        externalId: this.#pubsubSubscription,
        expiresAt: epochMillisToIso(watch.expiration),
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: snapshot.state.lastNotificationId,
      lastSuccessfulReconciliationAt: snapshot.state.lastSuccessfulReconciliationAt,
    });
    const catchUp = await reconcileGmailMailbox({
      state: baselineState,
      notification: null,
      client: this.#gmail,
      now,
      knownOutboundProviderMessageIds,
    });
    if (!catchUp.complete || catchUp.recoveryAction !== null) {
      throw new Error("Gmail full-sync history catch-up did not complete");
    }
    if (
      notification
      && compareHistoryIds(catchUp.state.cursor.value, notification.targetHistoryId) < 0
    ) {
      throw new Error("Gmail full-sync did not reach the notification cursor");
    }

    const changedMessageIds = new Set(
      catchUp.observations.flatMap((observation) =>
        observation.providerMessageId ? [observation.providerMessageId] : []
      ),
    );
    const snapshotObservations = members
      .filter((member) => !changedMessageIds.has(member.id))
      .map((member) => fullSyncMembershipObservation({
        member,
        mailboxBindingId: this.#mailboxBindingId,
        labelId: this.#labelId,
        providerCursor: catchUp.state.cursor.value,
        now,
        selfEcho: knownOutboundProviderMessageIds.has(member.id),
      }));
    const recoveryObservation = createMailboxObservation({
      provider: "gmail",
      mailboxBindingId: this.#mailboxBindingId,
      sourceSchema: "gmail-subscription",
      sourceEventId: fullSyncSourceId("recovered", baselineCursor),
      eventType: "mail.subscription.recovered",
      providerCursor: catchUp.state.cursor.value,
      providerMessageId: null,
      providerThreadId: null,
      providerScopeId: null,
      observedAt: now,
      receivedAt: now,
      wakeEligible: false,
      loopDisposition: "automatic",
    });
    const observations = Object.freeze([
      ...snapshotObservations,
      ...catchUp.observations,
      recoveryObservation,
    ]);
    const nextState = createMailboxSubscriptionState({
      ...catchUp.state,
      coverage: "continuous",
      subscription: {
        ...catchUp.state.subscription,
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: notification?.notificationId
        ?? catchUp.state.lastNotificationId,
      lastSuccessfulReconciliationAt: now,
    });

    let committed: MailboxIntakeSnapshot;
    try {
      committed = await this.#intake.commit({
        previous: snapshot,
        nextState,
        observations,
        reconciliationId: reconciliationId(
          "fullsync",
          baselineCursor,
          catchUp.state.cursor.value,
        ),
      });
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const winner = await this.#intake.get(this.#mailboxBindingId);
      if (
        !winner
        || winner.state.coverage !== "continuous"
        || compareHistoryIds(winner.state.cursor.value, nextState.cursor.value) < 0
      ) {
        throw error;
      }
      committed = winner;
    }

    const materialObservations = observations.filter((observation) =>
      observation.wakeEligible && observation.loopDisposition === "ordinary"
    ).length;
    const archivedMessages = await this.#enforceQuietHandoffMailbox();
    return freezeResult(
      committed.revision,
      committed.state.cursor.value,
      observations.length,
      materialObservations,
      archivedMessages,
      false,
      null,
    );
  }

  async #enforceQuietHandoffMailbox(): Promise<number> {
    return await this.#actions.archiveMessagesWithLabels([
      this.#labelId,
      "INBOX",
    ]);
  }
}

function fullSyncMembershipObservation(input: {
  member: GmailLabelSnapshotMessage;
  mailboxBindingId: string;
  labelId: string;
  providerCursor: string;
  now: string;
  selfEcho: boolean;
}): MailboxObservation {
  return createMailboxObservation({
    provider: "gmail",
    mailboxBindingId: input.mailboxBindingId,
    sourceSchema: "gmail-history",
    sourceEventId: fullSyncSourceId("member", input.member.id),
    eventType: "mail.scope.added",
    providerCursor: input.providerCursor,
    providerMessageId: input.member.id,
    providerThreadId: input.member.threadId,
    providerScopeId: input.labelId,
    observedAt: input.now,
    receivedAt: input.now,
    wakeEligible: !input.selfEcho,
    loopDisposition: input.selfEcho ? "self_echo" : "ordinary",
  });
}

function fullSyncSourceId(kind: string, value: string): string {
  return `fullsync:${kind}:${fingerprintCanonicalRequest({ kind, value }).slice("sha256:".length)}`;
}

function requiresFullSync(state: MailboxSubscriptionState): boolean {
  return state.coverage === "unknown"
    && state.subscription.health === "degraded"
    && state.subscription.recoveryReason === "history_cursor_expired";
}

function watchRenewalDue(state: MailboxSubscriptionState, now: string): boolean {
  if (state.subscription.expiresAt === null) return true;
  return Date.parse(state.subscription.expiresAt) - Date.parse(now) <= renewalWindowMs;
}

function notificationCovered(
  state: MailboxSubscriptionState,
  notification: GmailPubSubNotification,
): boolean {
  return compareHistoryIds(notification.targetHistoryId, state.cursor.value) <= 0;
}

function stateWithNotification(
  state: MailboxSubscriptionState,
  notificationId: string,
): MailboxSubscriptionState {
  return createMailboxSubscriptionState({
    ...state,
    lastNotificationId: notificationId,
  });
}

function freezeResult(
  revision: number,
  cursor: string,
  admittedObservations: number,
  materialObservations: number,
  archivedMessages: number,
  duplicate: boolean,
  recoveryAction: GmailUnattendedResult["recoveryAction"],
): GmailUnattendedResult {
  return Object.freeze({
    duplicate,
    revision,
    cursor,
    admittedObservations,
    materialObservations,
    archivedMessages,
    recoveryAction,
  });
}

function canonicalState(value: unknown): string {
  return JSON.stringify(value);
}

function reconciliationId(kind: string, ...parts: string[]): string {
  return `gmail-${kind}:${fingerprintCanonicalRequest({ kind, parts }).slice("sha256:".length)}`;
}

function isRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return Boolean(
      descriptor
      && "value" in descriptor
      && typeof descriptor.value === "string"
      && descriptor.value.includes("MAILBOX_INTAKE_REVISION_CONFLICT"),
    );
  } catch {
    return false;
  }
}

function compareHistoryIds(left: string, right: string): number {
  if (!/^[1-9][0-9]{0,39}$/u.test(left) || !/^[1-9][0-9]{0,39}$/u.test(right)) {
    throw new RangeError("Gmail history cursor is invalid");
  }
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function epochMillisToIso(value: string): string {
  if (!/^[1-9][0-9]{10,16}$/u.test(value)) {
    throw new RangeError("Gmail watch expiration is invalid");
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError("Gmail watch expiration is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > 1024
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function email(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length > 320
    || !/^[^\s@]+@[^\s@]+$/u.test(value)
  ) {
    throw new RangeError("Gmail mailbox address is invalid");
  }
  return value.toLowerCase();
}
