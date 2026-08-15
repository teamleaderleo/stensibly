import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";

export type OutlookMailboxLifecycleEvent =
  | "change"
  | "missed"
  | "reauthorizationRequired"
  | "subscriptionRemoved";

export interface OutlookMailboxNotification {
  readonly provider: "outlook";
  readonly mailboxBindingId: string;
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly clientStateVerified: boolean;
  readonly lifecycleEvent: OutlookMailboxLifecycleEvent;
  readonly observedAt: string;
  readonly receivedAt: string;
}

export interface OutlookDeltaChange {
  readonly immutableId: string;
  readonly conversationId?: string | null;
  readonly removed: boolean;
}

export interface OutlookDeltaPage {
  readonly changes?: readonly OutlookDeltaChange[];
  readonly nextPageRef?: string;
  readonly deltaRef?: string;
}

export interface OutlookMailboxClient {
  listDelta(request: {
    folderId: string;
    cursorRef: string;
    pageRef?: string;
  }): Promise<OutlookDeltaPage>;
  recoverSubscription(request: {
    folderId: string;
    subscriptionId: string | null;
    reason:
      | "subscription_expired"
      | "subscription_renewal_due"
      | "reauthorization_required"
      | "subscription_removed";
  }): Promise<{ id: string; expiration: string }>;
}

export class OutlookDeltaCursorExpiredError extends Error {
  constructor() {
    super("Outlook delta cursor expired");
    this.name = "OutlookDeltaCursorExpiredError";
  }
}

export interface OutlookMailboxReconciliationResult {
  readonly complete: boolean;
  readonly duplicateNotification: boolean;
  readonly state: MailboxSubscriptionState;
  readonly observations: readonly MailboxObservation[];
  readonly recoveryAction: "recover_subscription" | "full_sync_required" | null;
}

export interface ReconcileOutlookMailboxInput {
  state: MailboxSubscriptionState;
  notification: OutlookMailboxNotification | null;
  client: OutlookMailboxClient;
  now: string;
  knownOutboundProviderMessageIds?: ReadonlySet<string>;
  knownInScopeProviderMessageIds?: ReadonlySet<string>;
  renewalWindowMs?: number;
}

const maximumDeltaPages = 32;
const maximumDeltaChangesPerPage = 500;
const defaultRenewalWindowMs = 24 * 60 * 60_000;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;
const opaqueRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,4095}$/u;

export async function reconcileOutlookMailbox(
  input: ReconcileOutlookMailboxInput,
): Promise<OutlookMailboxReconciliationResult> {
  assertOutlookState(input.state);
  const now = canonicalTimestamp(input.now, "Outlook reconciliation time");
  const notification = input.notification === null
    ? null
    : admitOutlookMailboxNotification(input.notification);
  if (notification && notification.mailboxBindingId !== input.state.mailboxBindingId) {
    throw new RangeError("Outlook notification mailbox binding mismatch");
  }
  if (
    notification
    && input.state.subscription.externalId !== null
    && notification.subscriptionId !== input.state.subscription.externalId
  ) {
    throw new RangeError("Outlook notification subscription binding mismatch");
  }

  const duplicateNotification = notification?.notificationId
    === input.state.lastNotificationId;
  const renewalWindowMs = input.renewalWindowMs ?? defaultRenewalWindowMs;
  if (!Number.isSafeInteger(renewalWindowMs) || renewalWindowMs < 0) {
    throw new RangeError("Outlook subscription renewal window is invalid");
  }

  const nowMs = Date.parse(now);
  const expiresAtMs = input.state.subscription.expiresAt === null
    ? null
    : Date.parse(input.state.subscription.expiresAt);
  const expired = expiresAtMs !== null && expiresAtMs <= nowMs;
  const renewalDue = expiresAtMs === null || expiresAtMs - nowMs <= renewalWindowMs;
  const lifecycleNeedsRecovery = notification?.lifecycleEvent === "reauthorizationRequired"
    || notification?.lifecycleEvent === "subscriptionRemoved";

  if (
    duplicateNotification
    && !expired
    && !renewalDue
    && !lifecycleNeedsRecovery
    && notification?.lifecycleEvent !== "missed"
  ) {
    return frozenResult({
      complete: true,
      duplicateNotification: true,
      state: input.state,
      observations: [],
      recoveryAction: null,
    });
  }

  const observations: MailboxObservation[] = [];
  let workingState = input.state;
  let emitRecovered = workingState.subscription.health !== "healthy";

  if (notification?.lifecycleEvent === "missed") {
    if (workingState.subscription.health === "healthy") {
      observations.push(subscriptionObservation({
        state: workingState,
        eventType: "mail.subscription.degraded",
        sourceEventId: eventId("missed", notification.notificationId),
        now,
      }));
    }
    workingState = replaceState(workingState, {
      subscription: {
        ...workingState.subscription,
        health: "recovering",
        recoveryReason: "missed_notifications",
      },
    });
    emitRecovered = true;
  }

  let recoveryReason: Parameters<OutlookMailboxClient["recoverSubscription"]>[0]["reason"] | null = null;
  if (notification?.lifecycleEvent === "subscriptionRemoved") {
    recoveryReason = "subscription_removed";
  } else if (notification?.lifecycleEvent === "reauthorizationRequired") {
    recoveryReason = "reauthorization_required";
  } else if (expired) {
    recoveryReason = "subscription_expired";
  } else if (renewalDue) {
    recoveryReason = "subscription_renewal_due";
  }

  if (recoveryReason !== null) {
    const shouldDegrade = recoveryReason !== "subscription_renewal_due";
    if (shouldDegrade && workingState.subscription.health === "healthy") {
      observations.push(subscriptionObservation({
        state: workingState,
        eventType: "mail.subscription.degraded",
        sourceEventId: eventId("subscription", recoveryReason, now),
        now,
      }));
      emitRecovered = true;
    }
    if (shouldDegrade) {
      workingState = replaceState(workingState, {
        subscription: {
          ...workingState.subscription,
          health: "degraded",
          recoveryReason,
        },
      });
    }

    let recovered: { id: string; expiration: string };
    try {
      recovered = await input.client.recoverSubscription({
        folderId: workingState.scope.externalId,
        subscriptionId: workingState.subscription.externalId,
        reason: recoveryReason,
      });
    } catch {
      const degradedState = replaceState(workingState, {
        subscription: {
          ...workingState.subscription,
          health: "degraded",
          recoveryReason: `${recoveryReason}_failed`,
        },
      });
      return frozenResult({
        complete: false,
        duplicateNotification,
        state: degradedState,
        observations,
        recoveryAction: "recover_subscription",
      });
    }

    workingState = replaceState(workingState, {
      subscription: {
        externalId: providerId(recovered.id, "Outlook subscription ID"),
        expiresAt: canonicalTimestamp(
          recovered.expiration,
          "Outlook subscription expiration",
        ),
        health: emitRecovered ? "recovering" : "healthy",
        recoveryReason: emitRecovered ? recoveryReason : null,
      },
    });
  }

  const knownInScope = new Set(input.knownInScopeProviderMessageIds ?? []);
  const knownOutbound = input.knownOutboundProviderMessageIds ?? emptyIds;
  const admitted = new Map<string, MailboxObservation>();
  const currentCursor = workingState.cursor.value;
  let pageRef: string | undefined;
  let finalDeltaRef: string | null = null;

  try {
    for (let pageIndex = 0; pageIndex < maximumDeltaPages; pageIndex += 1) {
      const request = {
        folderId: workingState.scope.externalId,
        cursorRef: currentCursor,
        ...(pageRef === undefined ? {} : { pageRef }),
      };
      const page = admitDeltaPage(await input.client.listDelta(request));
      const evidenceRef = page.deltaRef ?? page.nextPageRef ?? pageRef ?? currentCursor;
      const changes = page.changes ?? [];
      for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
        const change = changes[changeIndex]!;
        const observation = deltaObservation({
          state: workingState,
          change,
          evidenceRef,
          pageRef: pageRef ?? currentCursor,
          changeIndex,
          knownInScope,
          knownOutbound,
          observedAt: notification?.observedAt ?? now,
          receivedAt: notification?.receivedAt ?? now,
        });
        admitted.set(observation.observationId, observation);
        if (change.removed) knownInScope.delete(change.immutableId);
        else knownInScope.add(change.immutableId);
      }

      if (page.nextPageRef !== undefined) {
        pageRef = page.nextPageRef;
        if (pageIndex === maximumDeltaPages - 1) {
          throw new RangeError("Outlook delta reconciliation exceeded the page bound");
        }
        continue;
      }
      if (page.deltaRef === undefined) {
        throw new RangeError("Outlook final delta page requires a durable delta reference");
      }
      finalDeltaRef = page.deltaRef;
      break;
    }
  } catch (error) {
    if (error instanceof OutlookDeltaCursorExpiredError) {
      const degradedState = replaceState(workingState, {
        coverage: "unknown",
        subscription: {
          ...workingState.subscription,
          health: "degraded",
          recoveryReason: "delta_cursor_expired",
        },
      });
      if (!observations.some((entry) => entry.eventType === "mail.subscription.degraded")) {
        observations.push(subscriptionObservation({
          state: degradedState,
          eventType: "mail.subscription.degraded",
          sourceEventId: eventId("delta-cursor-expired", currentCursor),
          now,
        }));
      }
      return frozenResult({
        complete: false,
        duplicateNotification,
        state: degradedState,
        observations,
        recoveryAction: "full_sync_required",
      });
    }
    throw error;
  }

  if (finalDeltaRef === null) {
    throw new RangeError("Outlook delta reconciliation did not reach a final cursor");
  }

  observations.push(...admitted.values());
  workingState = replaceState(workingState, {
    cursor: { kind: "outlook_delta_ref", value: finalDeltaRef },
    coverage: "continuous",
    subscription: {
      ...workingState.subscription,
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: notification?.notificationId
      ?? workingState.lastNotificationId,
    lastSuccessfulReconciliationAt: now,
  });

  if (emitRecovered) {
    observations.push(subscriptionObservation({
      state: workingState,
      eventType: "mail.subscription.recovered",
      sourceEventId: eventId(
        "subscription-recovered",
        workingState.subscription.externalId ?? "none",
        finalDeltaRef,
      ),
      now,
    }));
  }

  return frozenResult({
    complete: true,
    duplicateNotification,
    state: workingState,
    observations,
    recoveryAction: null,
  });
}

const emptyIds = new Set<string>();

function deltaObservation(input: {
  state: MailboxSubscriptionState;
  change: OutlookDeltaChange;
  evidenceRef: string;
  pageRef: string;
  changeIndex: number;
  knownInScope: Set<string>;
  knownOutbound: ReadonlySet<string>;
  observedAt: string;
  receivedAt: string;
}): MailboxObservation {
  const messageId = providerId(input.change.immutableId, "Outlook immutable message ID");
  const conversationId = input.change.conversationId === undefined
    || input.change.conversationId === null
    ? null
    : providerId(input.change.conversationId, "Outlook conversation ID");
  const wasInScope = input.knownInScope.has(messageId);
  const eventType = input.change.removed
    ? "mail.scope.removed" as const
    : wasInScope
      ? "mail.message.updated" as const
      : "mail.scope.added" as const;
  const loopDisposition = input.knownOutbound.has(messageId)
    ? "self_echo" as const
    : "ordinary" as const;
  return createMailboxObservation({
    provider: "outlook",
    mailboxBindingId: input.state.mailboxBindingId,
    sourceSchema: "outlook-delta",
    sourceEventId: eventId(
      "delta",
      input.pageRef,
      input.changeIndex.toString(10),
      input.change.removed ? "removed" : wasInScope ? "updated" : "added",
      messageId,
    ),
    eventType,
    providerCursor: opaqueRef(input.evidenceRef, "Outlook delta evidence reference"),
    providerMessageId: messageId,
    providerThreadId: conversationId,
    providerScopeId: input.state.scope.externalId,
    observedAt: canonicalTimestamp(input.observedAt, "Outlook observed time"),
    receivedAt: canonicalTimestamp(input.receivedAt, "Outlook received time"),
    wakeEligible: eventType === "mail.scope.added" && loopDisposition === "ordinary",
    loopDisposition,
  });
}

function subscriptionObservation(input: {
  state: MailboxSubscriptionState;
  eventType: "mail.subscription.degraded" | "mail.subscription.recovered";
  sourceEventId: string;
  now: string;
}): MailboxObservation {
  return createMailboxObservation({
    provider: "outlook",
    mailboxBindingId: input.state.mailboxBindingId,
    sourceSchema: "outlook-subscription",
    sourceEventId: input.sourceEventId,
    eventType: input.eventType,
    providerCursor: input.state.cursor.value,
    providerMessageId: null,
    providerThreadId: null,
    providerScopeId: null,
    observedAt: input.now,
    receivedAt: input.now,
    wakeEligible: false,
    loopDisposition: "automatic",
  });
}

export function admitOutlookMailboxNotification(
  value: OutlookMailboxNotification,
): OutlookMailboxNotification {
  if (value.provider !== "outlook") {
    throw new RangeError("Outlook notification provider is invalid");
  }
  if (value.clientStateVerified !== true) {
    throw new RangeError("Outlook notification client state was not verified");
  }
  const lifecycleEvent = value.lifecycleEvent;
  if (
    lifecycleEvent !== "change"
    && lifecycleEvent !== "missed"
    && lifecycleEvent !== "reauthorizationRequired"
    && lifecycleEvent !== "subscriptionRemoved"
  ) {
    throw new RangeError("Outlook lifecycle notification is invalid");
  }
  const observedAt = canonicalTimestamp(value.observedAt, "Outlook notification observed time");
  const receivedAt = canonicalTimestamp(value.receivedAt, "Outlook notification received time");
  if (Date.parse(observedAt) > Date.parse(receivedAt) + 5 * 60_000) {
    throw new RangeError("Outlook notification observed time is too far in the future");
  }
  return Object.freeze({
    provider: "outlook" as const,
    mailboxBindingId: providerId(value.mailboxBindingId, "Outlook mailbox binding ID"),
    notificationId: providerId(value.notificationId, "Outlook notification ID"),
    subscriptionId: providerId(value.subscriptionId, "Outlook notification subscription ID"),
    clientStateVerified: true,
    lifecycleEvent,
    observedAt,
    receivedAt,
  });
}

function admitDeltaPage(value: OutlookDeltaPage): OutlookDeltaPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Outlook delta page is invalid");
  }
  const rawChanges = value.changes ?? [];
  if (!Array.isArray(rawChanges) || rawChanges.length > maximumDeltaChangesPerPage) {
    throw new RangeError("Outlook delta changes exceed the configured bound");
  }
  const changes = rawChanges.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RangeError("Outlook delta change is invalid");
    }
    if (typeof entry.removed !== "boolean") {
      throw new RangeError("Outlook delta removal state is invalid");
    }
    return Object.freeze({
      immutableId: providerId(entry.immutableId, "Outlook immutable message ID"),
      conversationId: entry.conversationId === undefined || entry.conversationId === null
        ? null
        : providerId(entry.conversationId, "Outlook conversation ID"),
      removed: entry.removed,
    });
  });
  const nextPageRef = value.nextPageRef === undefined
    ? undefined
    : opaqueRef(value.nextPageRef, "Outlook next-page reference");
  const deltaRef = value.deltaRef === undefined
    ? undefined
    : opaqueRef(value.deltaRef, "Outlook delta reference");
  if (nextPageRef !== undefined && deltaRef !== undefined) {
    throw new RangeError("Outlook delta page cannot be both intermediate and final");
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    ...(nextPageRef === undefined ? {} : { nextPageRef }),
    ...(deltaRef === undefined ? {} : { deltaRef }),
  });
}

function replaceState(
  state: MailboxSubscriptionState,
  changes: Partial<Omit<
    MailboxSubscriptionState,
    "version" | "provider" | "mailboxBindingId" | "scope"
  >>,
): MailboxSubscriptionState {
  return createMailboxSubscriptionState({
    mailboxBindingId: state.mailboxBindingId,
    provider: "outlook",
    scope: state.scope,
    cursor: changes.cursor ?? state.cursor,
    coverage: changes.coverage ?? state.coverage,
    subscription: changes.subscription ?? state.subscription,
    lastNotificationId: changes.lastNotificationId === undefined
      ? state.lastNotificationId
      : changes.lastNotificationId,
    lastSuccessfulReconciliationAt:
      changes.lastSuccessfulReconciliationAt === undefined
        ? state.lastSuccessfulReconciliationAt
        : changes.lastSuccessfulReconciliationAt,
  });
}

function assertOutlookState(state: MailboxSubscriptionState): void {
  if (
    state.version !== 1
    || state.provider !== "outlook"
    || state.scope.kind !== "folder"
    || state.cursor.kind !== "outlook_delta_ref"
  ) {
    throw new RangeError("Outlook mailbox state is invalid");
  }
}

function providerId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || value !== value.trim()
    || !providerIdPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function opaqueRef(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || value !== value.trim()
    || !opaqueRefPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} is invalid`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new RangeError(`${label} must be canonical ISO time`);
  return canonical;
}

function eventId(...parts: string[]): string {
  const digest = fingerprintCanonicalRequest({ version: 1, parts })
    .slice("sha256:".length);
  return `outlook:${digest}`;
}

function frozenResult(
  input: OutlookMailboxReconciliationResult,
): OutlookMailboxReconciliationResult {
  return Object.freeze({
    ...input,
    observations: Object.freeze([...input.observations]),
  });
}
