import { GmailMailboxApiClient } from "./gmail-mailbox-api.js";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailMailboxReconciliationResult,
} from "./gmail-mailbox-intake.js";
import { HostedMailboxIntakeService } from "./mailbox-intake-convex-service.js";
import {
  createMailboxSubscriptionState,
  type MailboxObservation,
} from "./mailbox-intake-contract.js";

export interface GmailMaterialObservationSink {
  admitMaterialObservations(input: {
    readonly observations: readonly MailboxObservation[];
    readonly mailboxBindingId: string;
  }): Promise<void>;
}

export interface GmailUnattendedRuntimeOptions {
  mailboxAddress: string;
  mailboxBindingId: string;
  labelId: string;
  pubsubSubscription: string;
  gmail: GmailMailboxApiClient;
  intake: HostedMailboxIntakeService;
  materialSink?: GmailMaterialObservationSink;
  knownOutboundProviderMessageIds?: () => Promise<ReadonlySet<string>>;
  now?: () => string;
}

export interface GmailUnattendedResult {
  readonly duplicate: boolean;
  readonly revision: number;
  readonly cursor: string;
  readonly admittedObservations: number;
  readonly materialObservations: number;
  readonly recoveryAction: GmailMailboxReconciliationResult["recoveryAction"];
}

export class GmailUnattendedRuntime {
  readonly #mailboxAddress: string;
  readonly #mailboxBindingId: string;
  readonly #labelId: string;
  readonly #pubsubSubscription: string;
  readonly #gmail: GmailMailboxApiClient;
  readonly #intake: HostedMailboxIntakeService;
  readonly #materialSink: GmailMaterialObservationSink | undefined;
  readonly #knownOutbound: (() => Promise<ReadonlySet<string>>) | undefined;
  readonly #now: () => string;

  constructor(options: GmailUnattendedRuntimeOptions) {
    this.#mailboxAddress = email(options.mailboxAddress);
    this.#mailboxBindingId = identity(options.mailboxBindingId, "Gmail mailbox binding ID");
    this.#labelId = identity(options.labelId, "Gmail watched label ID");
    this.#pubsubSubscription = identity(options.pubsubSubscription, "Gmail Pub/Sub subscription");
    this.#gmail = options.gmail;
    this.#intake = options.intake;
    this.#materialSink = options.materialSink;
    this.#knownOutbound = options.knownOutboundProviderMessageIds;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async bootstrapOrCatchUp(): Promise<GmailUnattendedResult> {
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
      return freezeResult(snapshot.revision, state.cursor.value, 0, 0, false, null);
    }
    return await this.#reconcile(snapshot, null, `gmail-periodic:${snapshot.state.cursor.value}:${this.#now()}`);
  }

  async receivePubSubEnvelope(envelope: unknown): Promise<GmailUnattendedResult> {
    const receivedAt = this.#now();
    const notification = parseGmailPubSubNotification(envelope, {
      expectedMailboxAddress: this.#mailboxAddress,
      expectedSubscription: this.#pubsubSubscription,
      mailboxBindingId: this.#mailboxBindingId,
      receivedAt,
    });
    const snapshot = await this.#intake.get(this.#mailboxBindingId);
    if (!snapshot) {
      throw new Error("Gmail mailbox binding must be bootstrapped before push delivery");
    }
    return await this.#reconcile(
      snapshot,
      notification,
      `gmail-push:${notification.notificationId}`,
    );
  }

  async #reconcile(
    snapshot: NonNullable<Awaited<ReturnType<HostedMailboxIntakeService["get"]>>>,
    notification: ReturnType<typeof parseGmailPubSubNotification> | null,
    reconciliationId: string,
  ): Promise<GmailUnattendedResult> {
    const knownOutboundProviderMessageIds = this.#knownOutbound
      ? await this.#knownOutbound()
      : undefined;
    const result = await reconcileGmailMailbox({
      state: snapshot.state,
      notification,
      client: this.#gmail,
      now: this.#now(),
      ...(knownOutboundProviderMessageIds ? { knownOutboundProviderMessageIds } : {}),
    });
    if (
      result.duplicateNotification
      && result.observations.length === 0
      && canonicalState(result.state) === canonicalState(snapshot.state)
    ) {
      return freezeResult(
        snapshot.revision,
        snapshot.state.cursor.value,
        0,
        0,
        true,
        result.recoveryAction,
      );
    }
    const committed = await this.#intake.commit({
      previous: snapshot,
      nextState: result.state,
      observations: result.observations,
      reconciliationId,
    });
    const material = result.observations.filter((observation) =>
      observation.wakeEligible && observation.loopDisposition === "ordinary"
    );
    if (material.length > 0 && this.#materialSink) {
      await this.#materialSink.admitMaterialObservations({
        observations: Object.freeze([...material]),
        mailboxBindingId: this.#mailboxBindingId,
      });
    }
    return freezeResult(
      committed.revision,
      committed.state.cursor.value,
      result.observations.length,
      material.length,
      result.duplicateNotification,
      result.recoveryAction,
    );
  }
}

function freezeResult(
  revision: number,
  cursor: string,
  admittedObservations: number,
  materialObservations: number,
  duplicate: boolean,
  recoveryAction: GmailUnattendedResult["recoveryAction"],
): GmailUnattendedResult {
  return Object.freeze({
    duplicate,
    revision,
    cursor,
    admittedObservations,
    materialObservations,
    recoveryAction,
  });
}

function canonicalState(value: unknown): string {
  return JSON.stringify(value);
}

function epochMillisToIso(value: string): string {
  if (!/^[1-9][0-9]{10,16}$/u.test(value)) throw new RangeError("Gmail watch expiration is invalid");
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new RangeError("Gmail watch expiration is invalid");
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
  if (typeof value !== "string" || value.trim() !== value || value.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
    throw new RangeError("Gmail mailbox address is invalid");
  }
  return value.toLowerCase();
}
