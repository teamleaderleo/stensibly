import {
  createMailboxObservation,
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";

export interface GmailPubSubNotification {
  readonly provider: "gmail";
  readonly mailboxBindingId: string;
  readonly notificationId: string;
  readonly targetHistoryId: string;
  readonly publishedAt: string;
  readonly receivedAt: string;
}

export interface GmailHistoryMessageRef {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: GmailHistoryMessageRef }>;
  messagesDeleted?: Array<{ message: GmailHistoryMessageRef }>;
  labelsAdded?: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
}

export interface GmailHistoryPage {
  historyId: string;
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
}

export interface GmailHistoryClient {
  listHistory(request: {
    startHistoryId: string;
    labelId: string;
    pageToken?: string;
  }): Promise<GmailHistoryPage>;
  renewWatch(request: {
    labelIds: string[];
    labelFilterBehavior: "include";
  }): Promise<{ historyId: string; expiration: string }>;
}

export class GmailHistoryCursorExpiredError extends Error {
  constructor() {
    super("Gmail history cursor expired");
    this.name = "GmailHistoryCursorExpiredError";
  }
}

export interface GmailMailboxReconciliationResult {
  readonly complete: boolean;
  readonly duplicateNotification: boolean;
  readonly state: MailboxSubscriptionState;
  readonly observations: readonly MailboxObservation[];
  readonly recoveryAction: "full_sync_required" | "renew_watch" | null;
}

export interface ReconcileGmailMailboxInput {
  state: MailboxSubscriptionState;
  notification: GmailPubSubNotification | null;
  client: GmailHistoryClient;
  now: string;
  knownOutboundProviderMessageIds?: ReadonlySet<string>;
  renewalWindowMs?: number;
}

const historyIdPattern = /^[1-9][0-9]{0,39}$/u;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;
const maximumPubSubDataBytes = 16 * 1024;
const maximumHistoryPages = 32;
const maximumHistoryRecordsPerPage = 500;
const maximumChangeItemsPerRecord = 500;
const defaultRenewalWindowMs = 24 * 60 * 60_000;

export function parseGmailPubSubNotification(
  value: unknown,
  input: {
    expectedMailboxAddress: string;
    expectedSubscription: string;
    mailboxBindingId: string;
    receivedAt: string;
  },
): GmailPubSubNotification {
  const envelope = record(value, "Gmail Pub/Sub envelope");
  const expectedSubscription = safeProviderId(
    input.expectedSubscription,
    "Gmail Pub/Sub expected subscription",
  );
  const observedSubscription = safeProviderId(
    envelope.subscription,
    "Gmail Pub/Sub subscription",
  );
  if (observedSubscription !== expectedSubscription) {
    throw new RangeError("Gmail Pub/Sub subscription binding mismatch");
  }
  const message = record(envelope.message, "Gmail Pub/Sub message");
  const data = exactText(
    message.data,
    "Gmail Pub/Sub data",
    maximumPubSubDataBytes * 2,
  );
  const decoded = decodeBase64Url(data);
  if (decoded.byteLength > maximumPubSubDataBytes) {
    throw new RangeError("Gmail Pub/Sub data exceeds the configured bound");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw new RangeError("Gmail Pub/Sub data must be UTF-8 JSON");
  }
  const body = record(payload, "Gmail Pub/Sub data");
  if (
    canonicalMailboxAddress(body.emailAddress)
    !== canonicalMailboxAddress(input.expectedMailboxAddress)
  ) {
    throw new RangeError("Gmail Pub/Sub mailbox binding mismatch");
  }

  const publishedAt = normalizedTimestamp(
    message.publishTime,
    "Gmail Pub/Sub publish time",
  );
  const receivedAt = normalizedTimestamp(
    input.receivedAt,
    "Gmail notification receipt time",
  );
  if (Date.parse(publishedAt) > Date.parse(receivedAt) + 5 * 60_000) {
    throw new RangeError("Gmail Pub/Sub publish time is too far in the future");
  }

  return Object.freeze({
    provider: "gmail" as const,
    mailboxBindingId: safeProviderId(input.mailboxBindingId, "Mailbox binding ID"),
    notificationId: safeProviderId(
      message.messageId,
      "Gmail Pub/Sub message ID",
    ),
    targetHistoryId: gmailHistoryId(
      body.historyId,
      "Gmail notification history ID",
    ),
    publishedAt,
    receivedAt,
  });
}

export async function reconcileGmailMailbox(
  input: ReconcileGmailMailboxInput,
): Promise<GmailMailboxReconciliationResult> {
  assertGmailState(input.state);
  const now = normalizedTimestamp(input.now, "Gmail reconciliation time");
  const notification = input.notification;
  if (notification && notification.mailboxBindingId !== input.state.mailboxBindingId) {
    throw new RangeError("Gmail notification mailbox binding mismatch");
  }

  const currentCursor = input.state.cursor.value;
  const duplicateNotification = notification?.notificationId
    === input.state.lastNotificationId;
  const notificationAlreadyCovered = notification !== null
    && compareHistoryIds(notification.targetHistoryId, currentCursor) <= 0;

  const renewalWindowMs = input.renewalWindowMs ?? defaultRenewalWindowMs;
  if (!Number.isSafeInteger(renewalWindowMs) || renewalWindowMs < 0) {
    throw new RangeError("Gmail watch renewal window is invalid");
  }

  const observations: MailboxObservation[] = [];
  let workingState = input.state;
  const expirationMs = workingState.subscription.expiresAt === null
    ? null
    : Date.parse(workingState.subscription.expiresAt);
  const nowMs = Date.parse(now);
  const expired = expirationMs !== null && expirationMs <= nowMs;
  const renewalDue = expirationMs === null || expirationMs - nowMs <= renewalWindowMs;
  let emitRecovered = workingState.subscription.health !== "healthy";
  let renewalAdvancedCursor = false;

  if (expired && workingState.subscription.health === "healthy") {
    observations.push(subscriptionObservation({
      state: workingState,
      eventType: "mail.subscription.degraded",
      sourceEventId: `watch-expired:${workingState.subscription.expiresAt ?? "unknown"}`,
      now,
    }));
    workingState = replaceState(workingState, {
      subscription: {
        ...workingState.subscription,
        health: "degraded",
        recoveryReason: "watch_expired",
      },
    });
    emitRecovered = true;
  }

  if (renewalDue) {
    let renewed: { historyId: string; expiration: string };
    try {
      renewed = await input.client.renewWatch({
        labelIds: [workingState.scope.externalId],
        labelFilterBehavior: "include",
      });
    } catch {
      const alreadyRenewalFailed = workingState.subscription.health === "degraded"
        && workingState.subscription.recoveryReason === "watch_renewal_failed";
      if (observations.length === 0 && !alreadyRenewalFailed) {
        observations.push(subscriptionObservation({
          state: workingState,
          eventType: "mail.subscription.degraded",
          sourceEventId: `watch-renewal-failed:${workingState.subscription.expiresAt ?? "unknown"}:${now}`,
          now,
        }));
      }
      const degradedState = replaceState(workingState, {
        subscription: {
          ...workingState.subscription,
          health: "degraded",
          recoveryReason: "watch_renewal_failed",
        },
      });
      return frozenResult({
        complete: false,
        duplicateNotification,
        state: degradedState,
        observations,
        recoveryAction: "renew_watch",
      });
    }

    const renewedHistoryId = gmailHistoryId(
      renewed.historyId,
      "Gmail renewed watch history ID",
    );
    if (compareHistoryIds(renewedHistoryId, currentCursor) < 0) {
      throw new RangeError("Gmail renewed watch cursor regressed");
    }
    renewalAdvancedCursor = compareHistoryIds(renewedHistoryId, currentCursor) > 0;
    workingState = replaceState(workingState, {
      subscription: {
        externalId: workingState.subscription.externalId,
        expiresAt: epochMillisToIso(
          renewed.expiration,
          "Gmail watch expiration",
        ),
        health: emitRecovered ? "recovering" : "healthy",
        recoveryReason: emitRecovered
          ? workingState.subscription.recoveryReason
          : null,
      },
    });
  }

  if (notificationAlreadyCovered && !renewalAdvancedCursor) {
    workingState = replaceState(workingState, {
      subscription: {
        ...workingState.subscription,
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: notification?.notificationId
        ?? workingState.lastNotificationId,
    });
    if (emitRecovered) {
      observations.push(subscriptionObservation({
        state: workingState,
        eventType: "mail.subscription.recovered",
        sourceEventId: `watch-recovered:${workingState.subscription.expiresAt ?? now}`,
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

  const admittedById = new Map<string, MailboxObservation>();
  let finalHistoryId = currentCursor;
  let pageToken: string | undefined;
  try {
    for (let pageIndex = 0; pageIndex < maximumHistoryPages; pageIndex += 1) {
      const page = await input.client.listHistory({
        startHistoryId: currentCursor,
        labelId: workingState.scope.externalId,
        ...(pageToken ? { pageToken } : {}),
      });
      const pageHistoryId = gmailHistoryId(
        page.historyId,
        "Gmail history page cursor",
      );
      if (compareHistoryIds(pageHistoryId, currentCursor) < 0) {
        throw new RangeError("Gmail history cursor regressed");
      }
      if (compareHistoryIds(pageHistoryId, finalHistoryId) > 0) {
        finalHistoryId = pageHistoryId;
      }

      for (const observation of mapHistoryPage({
        page,
        pageHistoryId,
        state: workingState,
        observedAt: notification?.publishedAt ?? now,
        receivedAt: notification?.receivedAt ?? now,
        knownOutboundProviderMessageIds:
          input.knownOutboundProviderMessageIds ?? emptyProviderIds,
      })) {
        admittedById.set(observation.observationId, observation);
      }

      pageToken = optionalPageToken(page.nextPageToken);
      if (!pageToken) break;
      if (pageIndex === maximumHistoryPages - 1) {
        throw new RangeError(
          "Gmail history reconciliation exceeded the page bound",
        );
      }
    }
  } catch (error) {
    if (error instanceof GmailHistoryCursorExpiredError) {
      const alreadyCursorExpired = input.state.subscription.health === "degraded"
        && input.state.subscription.recoveryReason === "history_cursor_expired";
      const degradedState = replaceState(workingState, {
        coverage: "unknown",
        subscription: {
          ...workingState.subscription,
          health: "degraded",
          recoveryReason: "history_cursor_expired",
        },
      });
      if (observations.length === 0 && !alreadyCursorExpired) {
        observations.push(subscriptionObservation({
          state: degradedState,
          eventType: "mail.subscription.degraded",
          sourceEventId: `history-cursor-expired:${currentCursor}`,
          now,
        }));
      }
      return frozenResult({
        complete: false,
        duplicateNotification: false,
        state: degradedState,
        observations,
        recoveryAction: "full_sync_required",
      });
    }
    throw error;
  }

  if (
    notification
    && compareHistoryIds(finalHistoryId, notification.targetHistoryId) < 0
  ) {
    throw new RangeError(
      "Gmail history reconciliation did not reach notification cursor",
    );
  }

  observations.push(...admittedById.values());
  workingState = replaceState(workingState, {
    cursor: { kind: "gmail_history_id", value: finalHistoryId },
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
      sourceEventId: `watch-recovered:${workingState.subscription.expiresAt ?? now}`,
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

const emptyProviderIds = new Set<string>();

function mapHistoryPage(input: {
  page: GmailHistoryPage;
  pageHistoryId: string;
  state: MailboxSubscriptionState;
  observedAt: string;
  receivedAt: string;
  knownOutboundProviderMessageIds: ReadonlySet<string>;
}): MailboxObservation[] {
  const records = boundedArray(
    input.page.history,
    maximumHistoryRecordsPerPage,
    "Gmail history records",
  );
  const observations: MailboxObservation[] = [];
  for (const entry of records) {
    const historyId = gmailHistoryId(entry.id, "Gmail history entry ID");
    if (compareHistoryIds(historyId, input.pageHistoryId) > 0) {
      throw new RangeError("Gmail history entry exceeds the page cursor");
    }

    for (const item of boundedArray(
      entry.messagesAdded,
      maximumChangeItemsPerRecord,
      "Gmail messages-added records",
    )) {
      if (!messageMatchesVerifiedScope(item.message, input.state.scope.externalId)) {
        continue;
      }
      observations.push(messageObservation({
        state: input.state,
        historyId,
        action: "messageAdded",
        eventType: "mail.message.created",
        message: item.message,
        observedAt: input.observedAt,
        receivedAt: input.receivedAt,
        knownOutboundProviderMessageIds: input.knownOutboundProviderMessageIds,
      }));
    }

    for (const item of boundedArray(
      entry.messagesDeleted,
      maximumChangeItemsPerRecord,
      "Gmail messages-deleted records",
    )) {
      if (!messageMatchesVerifiedScope(item.message, input.state.scope.externalId)) {
        continue;
      }
      observations.push(messageObservation({
        state: input.state,
        historyId,
        action: "messageDeleted",
        eventType: "mail.message.deleted",
        message: item.message,
        observedAt: input.observedAt,
        receivedAt: input.receivedAt,
        knownOutboundProviderMessageIds: input.knownOutboundProviderMessageIds,
      }));
    }

    for (const item of boundedArray(
      entry.labelsAdded,
      maximumChangeItemsPerRecord,
      "Gmail labels-added records",
    )) {
      if (!item.labelIds?.includes(input.state.scope.externalId)) continue;
      observations.push(labelObservation({
        state: input.state,
        historyId,
        action: "labelAdded",
        eventType: "mail.label.added",
        message: item.message,
        observedAt: input.observedAt,
        receivedAt: input.receivedAt,
        knownOutboundProviderMessageIds: input.knownOutboundProviderMessageIds,
      }));
    }

    for (const item of boundedArray(
      entry.labelsRemoved,
      maximumChangeItemsPerRecord,
      "Gmail labels-removed records",
    )) {
      if (!item.labelIds?.includes(input.state.scope.externalId)) continue;
      observations.push(labelObservation({
        state: input.state,
        historyId,
        action: "labelRemoved",
        eventType: "mail.label.removed",
        message: item.message,
        observedAt: input.observedAt,
        receivedAt: input.receivedAt,
        knownOutboundProviderMessageIds: input.knownOutboundProviderMessageIds,
      }));
    }
  }
  return observations;
}

function messageObservation(input: {
  state: MailboxSubscriptionState;
  historyId: string;
  action: "messageAdded" | "messageDeleted";
  eventType: "mail.message.created" | "mail.message.deleted";
  message: GmailHistoryMessageRef;
  observedAt: string;
  receivedAt: string;
  knownOutboundProviderMessageIds: ReadonlySet<string>;
}): MailboxObservation {
  const messageId = safeProviderId(input.message.id, "Gmail message ID");
  const loopDisposition = input.knownOutboundProviderMessageIds.has(messageId)
    ? "self_echo" as const
    : "ordinary" as const;
  return createMailboxObservation({
    provider: "gmail",
    mailboxBindingId: input.state.mailboxBindingId,
    sourceSchema: "gmail-history",
    sourceEventId: `${input.historyId}:${input.action}:${messageId}`,
    eventType: input.eventType,
    providerCursor: input.historyId,
    providerMessageId: messageId,
    providerThreadId: optionalProviderId(
      input.message.threadId,
      "Gmail thread ID",
    ),
    providerLabelId: null,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    wakeEligible: input.eventType === "mail.message.created"
      && loopDisposition === "ordinary",
    loopDisposition,
  });
}

function labelObservation(input: {
  state: MailboxSubscriptionState;
  historyId: string;
  action: "labelAdded" | "labelRemoved";
  eventType: "mail.label.added" | "mail.label.removed";
  message: GmailHistoryMessageRef;
  observedAt: string;
  receivedAt: string;
  knownOutboundProviderMessageIds: ReadonlySet<string>;
}): MailboxObservation {
  const messageId = safeProviderId(input.message.id, "Gmail message ID");
  const loopDisposition = input.knownOutboundProviderMessageIds.has(messageId)
    ? "self_echo" as const
    : "ordinary" as const;
  return createMailboxObservation({
    provider: "gmail",
    mailboxBindingId: input.state.mailboxBindingId,
    sourceSchema: "gmail-history",
    sourceEventId: `${input.historyId}:${input.action}:${messageId}:${input.state.scope.externalId}`,
    eventType: input.eventType,
    providerCursor: input.historyId,
    providerMessageId: messageId,
    providerThreadId: optionalProviderId(
      input.message.threadId,
      "Gmail thread ID",
    ),
    providerLabelId: input.state.scope.externalId,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    wakeEligible: input.eventType === "mail.label.added"
      && loopDisposition === "ordinary",
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
    provider: "gmail",
    mailboxBindingId: input.state.mailboxBindingId,
    sourceSchema: "gmail-subscription",
    sourceEventId: input.sourceEventId,
    eventType: input.eventType,
    providerCursor: input.state.cursor.value,
    providerMessageId: null,
    providerThreadId: null,
    providerLabelId: null,
    observedAt: input.now,
    receivedAt: input.now,
    wakeEligible: false,
    loopDisposition: "automatic",
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
    provider: "gmail",
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

function assertGmailState(state: MailboxSubscriptionState): void {
  if (
    state.version !== 1
    || state.provider !== "gmail"
    || state.scope.kind !== "label"
    || state.cursor.kind !== "gmail_history_id"
  ) {
    throw new RangeError(
      "Gmail reconciliation requires label-scoped Gmail state",
    );
  }
  gmailHistoryId(state.cursor.value, "Gmail history cursor");
}

function messageMatchesVerifiedScope(
  message: GmailHistoryMessageRef,
  labelId: string,
): boolean {
  if (message.labelIds === undefined) return true;
  if (!Array.isArray(message.labelIds)) {
    throw new RangeError("Gmail message label IDs are invalid");
  }
  return message.labelIds.includes(labelId);
}

function boundedArray<T>(
  value: T[] | undefined,
  maximumLength: number,
  label: string,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new RangeError(`${label} exceed the configured bound`);
  }
  return value;
}

function compareHistoryIds(left: string, right: string): number {
  const a = BigInt(gmailHistoryId(left, "Gmail history ID"));
  const b = BigInt(gmailHistoryId(right, "Gmail history ID"));
  return a < b ? -1 : a > b ? 1 : 0;
}

function gmailHistoryId(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive safe integer`);
    }
    return String(value);
  }
  return exactText(value, label, 40, historyIdPattern);
}

function safeProviderId(value: unknown, label: string): string {
  return exactText(value, label, 1_024, providerIdPattern);
}

function optionalProviderId(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : safeProviderId(value, label);
}

function optionalPageToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return exactText(value, "Gmail history page token", 4_096);
}

function canonicalMailboxAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("Gmail mailbox address is invalid");
  }
  const canonical = value.trim().toLowerCase();
  if (
    canonical.length < 3
    || canonical.length > 320
    || canonical.includes("\n")
    || canonical.includes("\r")
    || !canonical.includes("@")
  ) {
    throw new RangeError("Gmail mailbox address is invalid");
  }
  return canonical;
}

function exactText(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function normalizedTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function epochMillisToIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,16}$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${label} is invalid`);
  }
  return new Date(parsed).toISOString();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const remainder = normalized.length % 4;
  const padded = normalized
    + (remainder === 0 ? "" : "=".repeat(4 - remainder));
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new RangeError("Gmail Pub/Sub data must be base64url");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function frozenResult(
  value: GmailMailboxReconciliationResult,
): GmailMailboxReconciliationResult {
  Object.freeze(value.observations);
  return Object.freeze(value);
}
