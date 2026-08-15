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
import type { HostedMailboxMaterialObservationDrain } from "./mailbox-material-observation-drain.js";
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

type GmailWatchResponse = Awaited<ReturnType<GmailMailboxApiClient["renewWatch"]>>;

export type GmailOutboundProviderMessageDisposition = "ordinary" | "self_echo";

export interface GmailUnattendedRuntimeOptions {
  mailboxAddress: string;
  mailboxBindingId: string;
  labelId: string;
  pubsubSubscription: string;
  gmail: GmailMailboxApiClient;
  actions: GmailMailboxActionClient;
  intake: HostedMailboxIntakeService;
  pushBindingGeneration?: string;
  outboundProviderMessageLookup?: (
    providerMessageId: string,
  ) => Promise<GmailOutboundProviderMessageDisposition>;
  knownOutboundProviderMessageIds?: () => Promise<ReadonlySet<string>>;
  materialObservationDrain?: Pick<
    HostedMailboxMaterialObservationDrain,
    "drainObservationIds" | "drainRecent"
  >;
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
  readonly #pushBindingGeneration: string | null;
  readonly #outboundProviderMessageLookup:
    | ((providerMessageId: string) => Promise<GmailOutboundProviderMessageDisposition>)
    | undefined;
  readonly #knownOutbound: (() => Promise<ReadonlySet<string>>) | undefined;
  readonly #materialObservationDrain:
    | Pick<HostedMailboxMaterialObservationDrain, "drainObservationIds" | "drainRecent">
    | undefined;
  readonly #now: () => string;

  constructor(options: GmailUnattendedRuntimeOptions) {
    this.#mailboxAddress = email(options.mailboxAddress);
    this.#mailboxBindingId = identity(options.mailboxBindingId, "Gmail mailbox binding ID");
    this.#labelId = identity(options.labelId, "Gmail watched label ID");
    this.#pubsubSubscription = identity(options.pubsubSubscription, "Gmail Pub/Sub subscription");
    this.#gmail = options.gmail;
    this.#actions = options.actions;
    this.#intake = options.intake;
    this.#pushBindingGeneration = options.pushBindingGeneration === undefined
      ? null
      : identity(options.pushBindingGeneration, "Gmail push binding generation");
    this.#outboundProviderMessageLookup = options.outboundProviderMessageLookup;
    this.#knownOutbound = options.knownOutboundProviderMessageIds;
    this.#materialObservationDrain = options.materialObservationDrain;
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
      const state = createMailboxSubscriptionState({
        mailboxBindingId: this.#mailboxBindingId,
        provider: "gmail",
        scope: { kind: "label", externalId: this.#labelId },
        cursor: { kind: "gmail_history_id", value: watch.historyId },
        coverage: "unknown",
        subscription: {
          externalId: this.#pubsubSubscription,
          expiresAt: epochMillisToIso(watch.expiration),
          health: "recovering",
          recoveryReason: "initial_snapshot_pending",
          healthGeneration: this.#pushBindingGeneration,
        },
        lastNotificationId: null,
        lastSuccessfulReconciliationAt: null,
      });
      try {
        snapshot = await this.#intake.initialize(state);
      } catch (error) {
        if (!isBindingConflict(error)) throw error;
        snapshot = await this.#intake.get(this.#mailboxBindingId);
        if (!snapshot) throw new Error("Mailbox intake binding disappeared during bootstrap");
      }
      if (requiresFullSync(snapshot.state)) {
        return await this.#recoverFullSync(
          snapshot,
          null,
          null,
          snapshot.state.cursor.value === watch.historyId ? watch : undefined,
        );
      }
    }
    if (requiresFullSync(snapshot.state)) {
      return await this.#recoverFullSync(snapshot, null, null);
    }
    return await this.#reconcile(
      snapshot,
      null,
      reconciliationId("periodic", snapshot.state.cursor.value, this.#now()),
      null,
    );
  }

  async receivePubSubEnvelope(
    envelope: unknown,
    authenticatedPushGeneration?: string,
  ): Promise<GmailUnattendedResult> {
    const receivedAt = this.#now();
    const notification = parseGmailPubSubNotification(envelope, {
      expectedMailboxAddress: this.#mailboxAddress,
      expectedSubscription: this.#pubsubSubscription,
      mailboxBindingId: this.#mailboxBindingId,
      receivedAt,
    });
    const authenticatedGeneration = authenticatedPushGeneration === undefined
      ? null
      : identity(authenticatedPushGeneration, "Authenticated Gmail push generation");
    if (
      authenticatedGeneration !== null
      && authenticatedGeneration !== this.#pushBindingGeneration
    ) {
      throw new Error("Authenticated Gmail push generation does not match the deployed binding generation");
    }
    await this.#gmail.verifyMailboxAddress(this.#mailboxAddress);
    const snapshot = await this.#intake.get(this.#mailboxBindingId);
    if (!snapshot) {
      throw new Error("Gmail mailbox binding must be bootstrapped before push delivery");
    }
    if (requiresFullSync(snapshot.state)) {
      return await this.#recoverFullSync(snapshot, notification, authenticatedGeneration);
    }
    return await this.#reconcile(
      snapshot,
      notification,
      reconciliationId("push", notification.notificationId),
      authenticatedGeneration,
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
    authenticatedPushGeneration: string | null,
  ): Promise<GmailUnattendedResult> {
    const now = this.#now();
    const duplicateNotification = notification?.notificationId
      === snapshot.state.lastNotificationId;
    const renewalRequired = watchRenewalDue(snapshot.state, now);
    const forceRenewalCatchUp = notification !== null
      && notificationCovered(snapshot.state, notification)
      && renewalRequired;
    const reconciliationNotification = forceRenewalCatchUp ? null : notification;
    const result = await reconcileGmailMailbox({
      state: snapshot.state,
      notification: reconciliationNotification,
      client: this.#gmail,
      now,
    });
    const rawNextState = forceRenewalCatchUp && notification
      ? stateWithNotification(result.state, notification.notificationId)
      : result.state;
    const nextState = this.#applyPushHealth(
      rawNextState,
      snapshot.state,
      authenticatedPushGeneration,
      renewalRequired,
    );
    const observations = await this.#prepareObservations(result.observations, nextState);

    if (
      duplicateNotification
      && observations.length === 0
      && canonicalState(nextState) === canonicalState(snapshot.state)
    ) {
      return await this.#finish(snapshot, [], true, result.recoveryAction);
    }

    let committed: MailboxIntakeSnapshot;
    let committedObservations = observations;
    let recoveryAction = result.recoveryAction;
    try {
      committed = await this.#intake.commit({
        previous: snapshot,
        nextState,
        observations,
        reconciliationId: reconciliationIdValue,
      });
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const winner = await this.#intake.get(this.#mailboxBindingId);
      if (!winner) throw new Error("Mailbox intake binding disappeared during reconciliation");
      if (
        observations.length === 0
        && compareHistoryIds(winner.state.cursor.value, nextState.cursor.value) >= 0
      ) {
        const winnerState = this.#applyPushHealth(
          winner.state,
          winner.state,
          authenticatedPushGeneration,
          watchRenewalDue(winner.state, this.#now()),
        );
        if (canonicalState(winnerState) === canonicalState(winner.state)) {
          return await this.#finish(winner, [], duplicateNotification, null);
        }
        committed = await this.#intake.commit({
          previous: winner,
          nextState: winnerState,
          observations: [],
          reconciliationId: `${reconciliationIdValue}:winner-health`,
        });
        return await this.#finish(committed, [], duplicateNotification, null);
      }

      const retryNow = this.#now();
      const retryRenewalRequired = watchRenewalDue(winner.state, retryNow);
      const retryForceRenewalCatchUp = notification !== null
        && notificationCovered(winner.state, notification)
        && retryRenewalRequired;
      const retry = await reconcileGmailMailbox({
        state: winner.state,
        notification: retryForceRenewalCatchUp ? null : notification,
        client: this.#gmail,
        now: retryNow,
      });
      const retryRawState = retryForceRenewalCatchUp && notification
        ? stateWithNotification(retry.state, notification.notificationId)
        : retry.state;
      const retryState = this.#applyPushHealth(
        retryRawState,
        winner.state,
        authenticatedPushGeneration,
        retryRenewalRequired,
      );
      const retryObservations = await this.#prepareObservations(
        retry.observations,
        retryState,
      );
      if (
        retryObservations.length === 0
        && canonicalState(retryState) === canonicalState(winner.state)
      ) {
        return await this.#finish(
          winner,
          [],
          notification?.notificationId === winner.state.lastNotificationId,
          retry.recoveryAction,
        );
      }
      committedObservations = retryObservations;
      recoveryAction = retry.recoveryAction;
      committed = await this.#intake.commit({
        previous: winner,
        nextState: retryState,
        observations: retryObservations,
        reconciliationId: `${reconciliationIdValue}:retry`,
      });
    }

    return await this.#finish(
      committed,
      committedObservations,
      duplicateNotification,
      recoveryAction,
    );
  }

  async #recoverFullSync(
    snapshot: MailboxIntakeSnapshot,
    notification: GmailPubSubNotification | null,
    authenticatedPushGeneration: string | null,
    suppliedWatch?: GmailWatchResponse,
  ): Promise<GmailUnattendedResult> {
    const now = this.#now();
    const watch = suppliedWatch ?? await this.#gmail.renewWatch({
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
        health: "recovering",
        recoveryReason: "push_transport_unverified",
        healthGeneration: this.#pushBindingGeneration,
      },
      lastNotificationId: snapshot.state.lastNotificationId,
      lastSuccessfulReconciliationAt: snapshot.state.lastSuccessfulReconciliationAt,
    });
    const catchUp = await reconcileGmailMailbox({
      state: baselineState,
      notification: null,
      client: this.#gmail,
      now,
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

    const preparedCatchUp = await this.#classifyOutboundObservations(catchUp.observations);
    const changedMessageIds = new Set(
      preparedCatchUp.flatMap((observation) =>
        observation.providerMessageId ? [observation.providerMessageId] : []
      ),
    );
    const snapshotObservations: MailboxObservation[] = [];
    for (const member of members) {
      if (changedMessageIds.has(member.id)) continue;
      const disposition = await this.#outboundDisposition(member.id);
      snapshotObservations.push(fullSyncMembershipObservation({
        member,
        mailboxBindingId: this.#mailboxBindingId,
        labelId: this.#labelId,
        providerCursor: catchUp.state.cursor.value,
        now,
        disposition,
      }));
    }

    const rawNextState = createMailboxSubscriptionState({
      ...catchUp.state,
      coverage: "continuous",
      subscription: this.#pushBindingGeneration === null
        ? catchUp.state.subscription
        : {
            ...catchUp.state.subscription,
            health: "recovering",
            recoveryReason: "push_transport_unverified",
            healthGeneration: this.#pushBindingGeneration,
          },
      lastNotificationId: notification?.notificationId
        ?? catchUp.state.lastNotificationId,
      lastSuccessfulReconciliationAt: now,
    });
    const nextState = this.#applyPushHealth(
      rawNextState,
      snapshot.state,
      authenticatedPushGeneration,
      true,
    );
    const observations = Object.freeze([
      ...snapshotObservations,
      ...filterRecoveredObservations(
        preparedCatchUp,
        nextState,
        snapshot.state.subscription.recoveryReason === "initial_snapshot_pending",
      ),
    ]);

    let committed: MailboxIntakeSnapshot;
    let committedObservations = observations;
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
      const winnerState = this.#applyPushHealth(
        winner.state,
        winner.state,
        authenticatedPushGeneration,
        false,
      );
      if (canonicalState(winnerState) === canonicalState(winner.state)) {
        committed = winner;
      } else {
        committed = await this.#intake.commit({
          previous: winner,
          nextState: winnerState,
          observations: [],
          reconciliationId: reconciliationId(
            "fullsync-winner-health",
            winner.state.cursor.value,
          ),
        });
      }
      committedObservations = [];
    }

    return await this.#finish(committed, committedObservations, false, null);
  }

  async #prepareObservations(
    observations: readonly MailboxObservation[],
    nextState: MailboxSubscriptionState,
  ): Promise<readonly MailboxObservation[]> {
    const classified = await this.#classifyOutboundObservations(observations);
    return filterRecoveredObservations(classified, nextState);
  }

  async #classifyOutboundObservations(
    observations: readonly MailboxObservation[],
  ): Promise<readonly MailboxObservation[]> {
    if (!this.#outboundProviderMessageLookup && !this.#knownOutbound) return observations;
    const classified: MailboxObservation[] = [];
    const cache = new Map<string, GmailOutboundProviderMessageDisposition>();
    for (const observation of observations) {
      if (
        observation.providerMessageId === null
        || observation.wakeEligible !== true
        || observation.loopDisposition !== "ordinary"
      ) {
        classified.push(observation);
        continue;
      }
      let disposition = cache.get(observation.providerMessageId);
      if (!disposition) {
        disposition = await this.#outboundDisposition(observation.providerMessageId);
        cache.set(observation.providerMessageId, disposition);
      }
      classified.push(
        disposition === "self_echo"
          ? observationWithDisposition(observation, "self_echo")
          : observation,
      );
    }
    return Object.freeze(classified);
  }

  async #outboundDisposition(
    providerMessageId: string,
  ): Promise<GmailOutboundProviderMessageDisposition> {
    if (this.#outboundProviderMessageLookup) {
      const disposition = await this.#outboundProviderMessageLookup(providerMessageId);
      if (disposition !== "ordinary" && disposition !== "self_echo") {
        throw new Error("Hosted Gmail outbound provider-message lookup returned an invalid disposition");
      }
      return disposition;
    }
    if (this.#knownOutbound) {
      return (await this.#knownOutbound()).has(providerMessageId) ? "self_echo" : "ordinary";
    }
    return "ordinary";
  }

  #applyPushHealth(
    next: MailboxSubscriptionState,
    previous: MailboxSubscriptionState,
    authenticatedPushGeneration: string | null,
    renewalRequired: boolean,
  ): MailboxSubscriptionState {
    const generation = this.#pushBindingGeneration;
    if (generation === null) return next;
    if (next.subscription.health === "degraded") {
      return createMailboxSubscriptionState({
        ...next,
        subscription: {
          ...next.subscription,
          healthGeneration: generation,
        },
      });
    }
    const callbackVerified = authenticatedPushGeneration === generation
      && next.coverage === "continuous";
    const priorVerified = !renewalRequired
      && previous.subscription.health === "healthy"
      && previous.subscription.healthGeneration === generation;
    const healthy = callbackVerified || priorVerified;
    return createMailboxSubscriptionState({
      ...next,
      subscription: {
        ...next.subscription,
        health: healthy ? "healthy" : "recovering",
        recoveryReason: healthy ? null : "push_transport_unverified",
        healthGeneration: generation,
      },
    });
  }

  async #finish(
    snapshot: MailboxIntakeSnapshot,
    observations: readonly MailboxObservation[],
    duplicate: boolean,
    recoveryAction: GmailUnattendedResult["recoveryAction"],
  ): Promise<GmailUnattendedResult> {
    const materialObservationIds = observations
      .filter((observation) =>
        observation.wakeEligible && observation.loopDisposition === "ordinary"
      )
      .map((observation) => observation.observationId);
    if (this.#materialObservationDrain) {
      if (materialObservationIds.length > 0) {
        await this.#materialObservationDrain.drainObservationIds(materialObservationIds);
      }
      await this.#materialObservationDrain.drainRecent();
    }
    const archivedMessages = await this.#enforceQuietHandoffMailbox();
    return freezeResult(
      snapshot.revision,
      snapshot.state.cursor.value,
      observations.length,
      materialObservationIds.length,
      archivedMessages,
      duplicate,
      recoveryAction,
    );
  }

  async #enforceQuietHandoffMailbox(): Promise<number> {
    return await this.#actions.archiveMessagesWithLabels([
      this.#labelId,
      "INBOX",
    ]);
  }
}

function observationWithDisposition(
  observation: MailboxObservation,
  disposition: "self_echo",
): MailboxObservation {
  return createMailboxObservation({
    provider: observation.provider,
    mailboxBindingId: observation.mailboxBindingId,
    sourceSchema: observation.sourceSchema,
    sourceEventId: observation.sourceEventId,
    eventType: observation.eventType,
    providerCursor: observation.providerCursor,
    providerMessageId: observation.providerMessageId,
    providerThreadId: observation.providerThreadId,
    providerScopeId: observation.providerScopeId,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    wakeEligible: false,
    loopDisposition: disposition,
  });
}

function filterRecoveredObservations(
  observations: readonly MailboxObservation[],
  nextState: MailboxSubscriptionState,
  forceDrop = false,
): readonly MailboxObservation[] {
  if (!forceDrop && nextState.subscription.health === "healthy") return observations;
  return Object.freeze(
    observations.filter((observation) =>
      observation.eventType !== "mail.subscription.recovered"
    ),
  );
}

function fullSyncMembershipObservation(input: {
  member: GmailLabelSnapshotMessage;
  mailboxBindingId: string;
  labelId: string;
  providerCursor: string;
  now: string;
  disposition: GmailOutboundProviderMessageDisposition;
}): MailboxObservation {
  const selfEcho = input.disposition === "self_echo";
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
    wakeEligible: !selfEcho,
    loopDisposition: selfEcho ? "self_echo" : "ordinary",
  });
}

function fullSyncSourceId(kind: string, value: string): string {
  return `fullsync:${kind}:${fingerprintCanonicalRequest({ kind, value }).slice("sha256:".length)}`;
}

function requiresFullSync(state: MailboxSubscriptionState): boolean {
  return state.coverage === "unknown";
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
  return errorMessageIncludes(error, "MAILBOX_INTAKE_REVISION_CONFLICT");
}

function isBindingConflict(error: unknown): boolean {
  return errorMessageIncludes(error, "MAILBOX_INTAKE_BINDING_CONFLICT");
}

function errorMessageIncludes(error: unknown, expected: string): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return Boolean(
      descriptor
      && "value" in descriptor
      && typeof descriptor.value === "string"
      && descriptor.value.includes(expected),
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
