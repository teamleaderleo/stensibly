import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "./idempotency-request-fingerprint.js";
import {
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";
import {
  OutlookDeltaCursorExpiredError,
  reconcileOutlookMailbox,
  type OutlookDeltaChange,
  type OutlookDeltaPage,
  type OutlookMailboxClient,
  type OutlookMailboxNotification,
  type OutlookMailboxReconciliationResult,
} from "./outlook-mailbox-intake.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_API_ROOT = `${GRAPH_ORIGIN}/v1.0`;
const MICROSOFT_CONSUMER_TOKEN_URL =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const OFFICIAL_OUTLOOK_NOTIFICATION_URL =
  "https://api.stensibly.com/internal/outlook/notifications";
const MAXIMUM_NOTIFICATION_BYTES = 64 * 1024;
const MAXIMUM_NOTIFICATION_BATCH = 64;
const MAXIMUM_RECENT_OBSERVATIONS = 100;
const MAXIMUM_RECONCILIATION_OBSERVATIONS = 256;
const MAXIMUM_SUBSCRIPTION_LIST_PAGES = 8;
const MAXIMUM_SUBSCRIPTION_LIST_ENTRIES = 256;
const GRAPH_SUBSCRIPTION_LIFETIME_MS = 6 * 24 * 60 * 60_000;
const MAXIMUM_RECONCILIATION_ATTEMPTS = 3;

const mailboxInitializeRef = makeFunctionReference<"mutation">("mailboxIntake:initialize");
const mailboxCommitRef = makeFunctionReference<"mutation">("mailboxIntake:commitReconciliation");
const mailboxGetBindingRef = makeFunctionReference<"query">("mailboxIntake:getBinding");
const mailboxListRecentRef = makeFunctionReference<"query">("mailboxIntake:listRecentObservations");
const outboundByProviderMessageRef = makeFunctionReference<"query">(
  "mailOutbound:getEffectByProviderMessage",
);
const outlookGetAuthRef = makeFunctionReference<"query">("outlookRuntime:getAuth");
const outlookSetAuthRef = makeFunctionReference<"mutation">("outlookRuntime:setAuth");

export interface OutlookGraphBindings {
  CONVEX_URL: string;
  STENSIBLY_SERVICE_SECRET: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID: string;
  STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN: string;
  STENSIBLY_OUTLOOK_CLIENT_STATE: string;
  STENSIBLY_OUTLOOK_FOLDER_ID: string;
  STENSIBLY_OUTLOOK_MAILBOX: string;
  STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: string;
  STENSIBLY_OUTLOOK_NOTIFICATION_URL: string;
}

export interface StoredOutlookMailboxBinding {
  mailboxBindingId: string;
  provider: string;
  cursorValue: string;
  coverage: "continuous" | "unknown";
  lastNotificationId: string | null;
  lastSuccessfulReconciliationAt: string | null;
  subscription: {
    externalId: string | null;
    expiresAt: string | null;
    health: "healthy" | "degraded" | "recovering";
    recoveryReason: string | null;
  };
  scope: { kind: string; externalId: string };
  revision: number;
}

export interface StoredOutlookObservation {
  eventType: string;
  providerMessageId: string | null;
}

export interface StoredOutlookAuth {
  sealedRefreshToken: string;
  generation: number;
}

export interface OutlookRuntimeStore {
  getBinding(mailboxBindingId: string): Promise<StoredOutlookMailboxBinding | null>;
  initialize(state: MailboxSubscriptionState): Promise<void>;
  commit(input: {
    mailboxBindingId: string;
    reconciliationId: string;
    expectedRevision: number;
    expectedCursor: string;
    state: MailboxSubscriptionState;
    observations: readonly MailboxObservation[];
  }): Promise<void>;
  listRecentObservations(mailboxBindingId: string): Promise<readonly StoredOutlookObservation[]>;
  isKnownOutboundProviderMessage(
    mailboxBindingId: string,
    providerMessageId: string,
  ): Promise<boolean>;
  getAuth(mailboxBindingId: string): Promise<StoredOutlookAuth | null>;
  setAuth(input: {
    mailboxBindingId: string;
    expectedGeneration: number | null;
    sealedRefreshToken: string;
  }): Promise<void>;
}

export interface OutlookRuntimeDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  store?: OutlookRuntimeStore;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class OutlookRuntimeRecoverableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OutlookRuntimeRecoverableError";
    this.code = code;
  }
}

interface AdmittedNotificationBatch {
  response: Response | null;
  notifications: readonly OutlookMailboxNotification[];
}

export function requireOutlookGraphBindings(
  env: Record<string, string | undefined>,
): OutlookGraphBindings {
  const notificationUrl = requiredBinding(env, "STENSIBLY_OUTLOOK_NOTIFICATION_URL");
  let parsedNotificationUrl: URL;
  try {
    parsedNotificationUrl = new URL(notificationUrl);
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_NOTIFICATION_URL_INVALID");
  }
  if (
    notificationUrl !== OFFICIAL_OUTLOOK_NOTIFICATION_URL
    || parsedNotificationUrl.protocol !== "https:"
    || parsedNotificationUrl.username !== ""
    || parsedNotificationUrl.password !== ""
    || parsedNotificationUrl.pathname !== "/internal/outlook/notifications"
    || parsedNotificationUrl.search !== ""
    || parsedNotificationUrl.hash !== ""
  ) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_NOTIFICATION_URL_INVALID");
  }

  return {
    CONVEX_URL: requiredBinding(env, "CONVEX_URL"),
    STENSIBLY_SERVICE_SECRET: requiredBinding(env, "STENSIBLY_SERVICE_SECRET"),
    ...(env.STENSIBLY_WORKSPACE === undefined
      ? {}
      : { STENSIBLY_WORKSPACE: env.STENSIBLY_WORKSPACE }),
    STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID: requiredBinding(
      env,
      "STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID",
    ),
    STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN: requiredBinding(
      env,
      "STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN",
    ),
    STENSIBLY_OUTLOOK_CLIENT_STATE: requiredBinding(
      env,
      "STENSIBLY_OUTLOOK_CLIENT_STATE",
    ),
    STENSIBLY_OUTLOOK_FOLDER_ID: requiredBinding(env, "STENSIBLY_OUTLOOK_FOLDER_ID"),
    STENSIBLY_OUTLOOK_MAILBOX: requiredBinding(env, "STENSIBLY_OUTLOOK_MAILBOX"),
    STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: requiredBinding(
      env,
      "STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID",
    ),
    STENSIBLY_OUTLOOK_NOTIFICATION_URL: notificationUrl,
  };
}

export async function handleOutlookNotificationRequest(
  request: Request,
  bindings: OutlookGraphBindings,
  dependencies: OutlookRuntimeDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) {
    if (
      validationToken.length < 1
      || new TextEncoder().encode(validationToken).byteLength > 4_096
    ) {
      return new Response("Invalid validation token", { status: 400 });
    }
    return new Response(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  const store = dependencies.store ?? new ConvexOutlookRuntimeStore(bindings);
  let admitted: AdmittedNotificationBatch;
  try {
    admitted = await admitNotificationBatch(request, bindings, store);
  } catch (error) {
    if (error instanceof OutlookNotificationAdmissionError) {
      return new Response(error.status === 403 ? "Forbidden" : "Bad Request", {
        status: error.status,
      });
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  if (admitted.response) return admitted.response;

  const work = async () => {
    for (const notification of admitted.notifications) {
      await runOutlookReconciliation(bindings, notification, {
        ...dependencies,
        store,
      });
    }
  };

  if (dependencies.waitUntil) {
    dependencies.waitUntil(work());
    return new Response(null, { status: 202 });
  }

  try {
    await work();
    return new Response(null, { status: 202 });
  } catch {
    return new Response("Service Unavailable", { status: 503 });
  }
}

export async function runOutlookScheduledReconciliation(
  bindings: OutlookGraphBindings,
  dependencies: OutlookRuntimeDependencies = {},
): Promise<OutlookMailboxReconciliationResult> {
  return await runOutlookReconciliation(bindings, null, dependencies);
}

export async function runOutlookReconciliation(
  bindings: OutlookGraphBindings,
  notification: OutlookMailboxNotification | null,
  dependencies: OutlookRuntimeDependencies = {},
): Promise<OutlookMailboxReconciliationResult> {
  const store = dependencies.store ?? new ConvexOutlookRuntimeStore(bindings);
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = (dependencies.now ?? (() => new Date()))();
  const nowIso = canonicalNow(now);

  for (let attempt = 0; attempt < MAXIMUM_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const loaded = await loadOrInitializeMailboxState(store, bindings);
    const knownInScope = await loadKnownInScopeProviderMessageIds(
      store,
      bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
    );
    const knownOutbound = new Set<string>();
    const client = new MicrosoftGraphMailboxClient({
      bindings,
      store,
      fetchImpl,
      now,
      knownOutbound,
    });
    const effectiveNotification = notification
      ?? persistentRecoveryNotification(loaded.state, loaded.revision, nowIso);

    let result = await reconcileOutlookMailbox({
      state: loaded.state,
      notification: effectiveNotification,
      client,
      now: nowIso,
      knownOutboundProviderMessageIds: knownOutbound,
      knownInScopeProviderMessageIds: knownInScope,
    });

    if (!result.complete && result.recoveryAction === "full_sync_required") {
      const expiredResult = result;
      const resetState = createMailboxSubscriptionState({
        mailboxBindingId: expiredResult.state.mailboxBindingId,
        provider: "outlook",
        scope: expiredResult.state.scope,
        cursor: {
          kind: "outlook_delta_ref",
          value: initialDeltaRef(bindings.STENSIBLY_OUTLOOK_FOLDER_ID),
        },
        coverage: "unknown",
        subscription: expiredResult.state.subscription,
        lastNotificationId: effectiveNotification?.notificationId
          ?? expiredResult.state.lastNotificationId,
        lastSuccessfulReconciliationAt: expiredResult.state.lastSuccessfulReconciliationAt,
      });
      const recovered = await reconcileOutlookMailbox({
        state: resetState,
        notification: null,
        client,
        now: nowIso,
        knownOutboundProviderMessageIds: knownOutbound,
        knownInScopeProviderMessageIds: knownInScope,
      });
      const combinedObservations = Object.freeze([
        ...expiredResult.observations,
        ...recovered.observations,
      ]);
      if (recovered.complete) {
        result = Object.freeze({
          ...recovered,
          observations: combinedObservations,
        });
      } else {
        const preservedState = createMailboxSubscriptionState({
          mailboxBindingId: recovered.state.mailboxBindingId,
          provider: "outlook",
          scope: recovered.state.scope,
          cursor: expiredResult.state.cursor,
          coverage: "unknown",
          subscription: recovered.state.subscription,
          lastNotificationId: expiredResult.state.lastNotificationId,
          lastSuccessfulReconciliationAt: expiredResult.state.lastSuccessfulReconciliationAt,
        });
        result = Object.freeze({
          ...recovered,
          state: preservedState,
          observations: combinedObservations,
        });
      }
    }

    if (result.observations.length > MAXIMUM_RECONCILIATION_OBSERVATIONS) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_RECONCILIATION_BATCH_TOO_LARGE");
    }
    if (
      result.duplicateNotification
      && result.observations.length === 0
      && canonicalJsonString(result.state) === canonicalJsonString(loaded.state)
    ) {
      return result;
    }

    try {
      await store.commit({
        mailboxBindingId: bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
        reconciliationId: reconciliationId({
          notificationId: effectiveNotification?.notificationId ?? null,
          expectedRevision: loaded.revision,
          expectedCursor: loaded.state.cursor.value,
          now: nowIso,
        }),
        expectedRevision: loaded.revision,
        expectedCursor: loaded.state.cursor.value,
        state: result.state,
        observations: result.observations,
      });
      return result;
    } catch (error) {
      if (attempt + 1 < MAXIMUM_RECONCILIATION_ATTEMPTS && isMailboxCasConflict(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new OutlookRuntimeRecoverableError("OUTLOOK_RECONCILIATION_RETRY_EXHAUSTED");
}

class ConvexOutlookRuntimeStore implements OutlookRuntimeStore {
  private readonly client: ConvexHttpClient;
  private readonly serviceSecret: string;
  private readonly workspace: string;

  constructor(bindings: OutlookGraphBindings) {
    this.client = new ConvexHttpClient(bindings.CONVEX_URL);
    this.serviceSecret = bindings.STENSIBLY_SERVICE_SECRET;
    this.workspace = bindings.STENSIBLY_WORKSPACE ?? "default";
  }

  async getBinding(mailboxBindingId: string): Promise<StoredOutlookMailboxBinding | null> {
    return await this.client.query(mailboxGetBindingRef, this.args({ mailboxBindingId })) as
      StoredOutlookMailboxBinding | null;
  }

  async initialize(state: MailboxSubscriptionState): Promise<void> {
    await this.client.mutation(mailboxInitializeRef, this.args({
      stateJson: canonicalJsonString(state),
    }));
  }

  async commit(input: {
    mailboxBindingId: string;
    reconciliationId: string;
    expectedRevision: number;
    expectedCursor: string;
    state: MailboxSubscriptionState;
    observations: readonly MailboxObservation[];
  }): Promise<void> {
    await this.client.mutation(mailboxCommitRef, this.args({
      mailboxBindingId: input.mailboxBindingId,
      reconciliationId: input.reconciliationId,
      expectedRevision: input.expectedRevision,
      expectedCursor: input.expectedCursor,
      nextStateJson: canonicalJsonString(input.state),
      observationsJson: input.observations.map((entry) => canonicalJsonString(entry)),
    }));
  }

  async listRecentObservations(
    mailboxBindingId: string,
  ): Promise<readonly StoredOutlookObservation[]> {
    return await this.client.query(mailboxListRecentRef, this.args({
      mailboxBindingId,
      limit: MAXIMUM_RECENT_OBSERVATIONS,
    })) as StoredOutlookObservation[];
  }

  async isKnownOutboundProviderMessage(
    mailboxBindingId: string,
    providerMessageId: string,
  ): Promise<boolean> {
    const effect = await this.client.query(outboundByProviderMessageRef, this.args({
      provider: "outlook",
      accountBinding: mailboxBindingId,
      providerMessageId,
    }));
    return effect !== null;
  }

  async getAuth(mailboxBindingId: string): Promise<StoredOutlookAuth | null> {
    return await this.client.query(outlookGetAuthRef, this.args({ mailboxBindingId })) as
      StoredOutlookAuth | null;
  }

  async setAuth(input: {
    mailboxBindingId: string;
    expectedGeneration: number | null;
    sealedRefreshToken: string;
  }): Promise<void> {
    await this.client.mutation(outlookSetAuthRef, this.args(input));
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

class MicrosoftGraphMailboxClient implements OutlookMailboxClient {
  private readonly bindings: OutlookGraphBindings;
  private readonly store: OutlookRuntimeStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: Date;
  private readonly knownOutbound: Set<string>;
  private tokenPromise: Promise<string> | null = null;
  private mailboxVerifiedToken: string | null = null;

  constructor(input: {
    bindings: OutlookGraphBindings;
    store: OutlookRuntimeStore;
    fetchImpl: typeof fetch;
    now: Date;
    knownOutbound: Set<string>;
  }) {
    this.bindings = input.bindings;
    this.store = input.store;
    this.fetchImpl = input.fetchImpl;
    this.now = input.now;
    this.knownOutbound = input.knownOutbound;
  }

  async listDelta(request: {
    folderId: string;
    cursorRef: string;
    pageRef?: string;
  }): Promise<OutlookDeltaPage> {
    if (request.folderId !== this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_FOLDER_BINDING_MISMATCH");
    }
    const url = decodeGraphRef(
      request.pageRef ?? request.cursorRef,
      this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID,
    );
    const response = await this.graphFetch(url, {
      headers: { Prefer: 'IdType="ImmutableId"' },
    });
    if (response.status === 410) throw new OutlookDeltaCursorExpiredError();
    if (!response.ok) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_FAILED");
    }
    const payload = await jsonRecord(response, "OUTLOOK_GRAPH_DELTA_INVALID");
    if (!Array.isArray(payload.value)) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
    }
    const changes: OutlookDeltaChange[] = [];
    for (const raw of payload.value) {
      if (!isRecord(raw) || typeof raw.id !== "string") {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
      }
      const removed = isRecord(raw["@removed"]);
      const conversationId = raw.conversationId === undefined || raw.conversationId === null
        ? null
        : typeof raw.conversationId === "string"
          ? raw.conversationId
          : invalidDeltaConversation();
      changes.push(Object.freeze({
        immutableId: raw.id,
        conversationId,
        removed,
      }));
    }

    await Promise.all(changes.map(async (change) => {
      if (await this.store.isKnownOutboundProviderMessage(
        this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
        change.immutableId,
      )) {
        this.knownOutbound.add(change.immutableId);
      }
    }));

    const nextLink = payload["@odata.nextLink"];
    const deltaLink = payload["@odata.deltaLink"];
    if (nextLink !== undefined && typeof nextLink !== "string") {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
    }
    if (deltaLink !== undefined && typeof deltaLink !== "string") {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
    }
    if (nextLink !== undefined && deltaLink !== undefined) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
    }
    return Object.freeze({
      changes: Object.freeze(changes),
      ...(nextLink === undefined
        ? {}
        : { nextPageRef: encodeGraphRef(nextLink, this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID) }),
      ...(deltaLink === undefined
        ? {}
        : { deltaRef: encodeGraphRef(deltaLink, this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID) }),
    });
  }

  async recoverSubscription(request: {
    folderId: string;
    subscriptionId: string | null;
    reason:
      | "subscription_expired"
      | "subscription_renewal_due"
      | "reauthorization_required"
      | "subscription_removed";
  }): Promise<{ id: string; expiration: string }> {
    if (request.folderId !== this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_FOLDER_BINDING_MISMATCH");
    }
    if (request.subscriptionId === null || request.reason === "subscription_removed") {
      return await this.createSubscription();
    }

    const expirationDateTime = new Date(
      this.now.getTime() + GRAPH_SUBSCRIPTION_LIFETIME_MS,
    ).toISOString();
    const response = await this.graphFetch(
      `${GRAPH_API_ROOT}/subscriptions/${encodeURIComponent(request.subscriptionId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Prefer: 'IdType="ImmutableId"',
        },
        body: JSON.stringify({ expirationDateTime }),
      },
    );
    if ([400, 404, 410].includes(response.status)) return await this.createSubscription();
    if (!response.ok) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_RENEW_FAILED");
    }
    return subscriptionProjection(
      await jsonRecord(response, "OUTLOOK_GRAPH_SUBSCRIPTION_INVALID"),
    );
  }

  private async createSubscription(): Promise<{ id: string; expiration: string }> {
    const existing = await this.findExistingSubscription();
    if (existing) return existing;

    const expirationDateTime = new Date(
      this.now.getTime() + GRAPH_SUBSCRIPTION_LIFETIME_MS,
    ).toISOString();
    const response = await this.graphFetch(`${GRAPH_API_ROOT}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Prefer: 'IdType="ImmutableId"',
      },
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl: this.bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL,
        lifecycleNotificationUrl: this.bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL,
        resource: subscriptionResource(this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID),
        expirationDateTime,
        clientState: this.bindings.STENSIBLY_OUTLOOK_CLIENT_STATE,
      }),
    });
    if (response.status === 409) {
      const recovered = await this.findExistingSubscription();
      if (recovered) return recovered;
    }
    if (!response.ok) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_CREATE_FAILED");
    }
    return subscriptionProjection(
      await jsonRecord(response, "OUTLOOK_GRAPH_SUBSCRIPTION_INVALID"),
    );
  }

  private async findExistingSubscription(): Promise<{
    id: string;
    expiration: string;
  } | null> {
    const expectedResource = subscriptionResource(
      this.bindings.STENSIBLY_OUTLOOK_FOLDER_ID,
    );
    const matches: Array<{ id: string; expiration: string }> = [];
    let pageUrl: string | null = `${GRAPH_API_ROOT}/subscriptions`;
    let pages = 0;
    let entries = 0;

    while (pageUrl !== null) {
      pages += 1;
      if (pages > MAXIMUM_SUBSCRIPTION_LIST_PAGES) {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_TOO_LARGE");
      }
      const response = await this.graphFetch(pageUrl);
      if (!response.ok) {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_FAILED");
      }
      const payload = await jsonRecord(response, "OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
      if (!Array.isArray(payload.value)) {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
      }
      entries += payload.value.length;
      if (entries > MAXIMUM_SUBSCRIPTION_LIST_ENTRIES) {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_TOO_LARGE");
      }
      for (const raw of payload.value) {
        if (!isRecord(raw)) {
          throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
        }
        if (
          raw.applicationId === this.bindings.STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID
          && raw.changeType === "created,updated,deleted"
          && raw.resource === expectedResource
          && raw.notificationUrl === this.bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL
          && raw.lifecycleNotificationUrl === this.bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL
        ) {
          matches.push(subscriptionProjection(raw));
        }
      }

      const nextLink = payload["@odata.nextLink"];
      if (nextLink === undefined) {
        pageUrl = null;
      } else if (typeof nextLink === "string") {
        pageUrl = exactSubscriptionListUrl(nextLink).toString();
      } else {
        throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
      }
    }

    if (matches.length > 1) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_AMBIGUOUS");
    }
    return matches[0] ?? null;
  }

  private async graphFetch(input: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.accessToken();
    await this.verifyMailbox(token);
    let response = await this.fetchWithToken(input, init, token);
    if (response.status !== 401) return response;

    this.tokenPromise = null;
    this.mailboxVerifiedToken = null;
    token = await this.accessToken();
    await this.verifyMailbox(token);
    response = await this.fetchWithToken(input, init, token);
    return response;
  }

  private async fetchWithToken(
    input: string,
    init: RequestInit,
    token: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await this.fetchImpl(input, { ...init, headers });
  }

  private async verifyMailbox(token: string): Promise<void> {
    if (this.mailboxVerifiedToken === token) return;
    const response = await this.fetchWithToken(
      `${GRAPH_API_ROOT}/me?$select=mail,userPrincipalName`,
      {},
      token,
    );
    if (!response.ok) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_MAILBOX_LOOKUP_FAILED");
    }
    const payload = await jsonRecord(response, "OUTLOOK_GRAPH_MAILBOX_INVALID");
    const expected = this.bindings.STENSIBLY_OUTLOOK_MAILBOX.toLocaleLowerCase("en-US");
    const candidates = [payload.mail, payload.userPrincipalName]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.toLocaleLowerCase("en-US"));
    if (!candidates.includes(expected)) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_MAILBOX_BINDING_MISMATCH");
    }
    this.mailboxVerifiedToken = token;
  }

  private async accessToken(): Promise<string> {
    if (!this.tokenPromise) this.tokenPromise = this.refreshAccessToken();
    return await this.tokenPromise;
  }

  private async refreshAccessToken(): Promise<string> {
    const stored = await this.store.getAuth(
      this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
    );
    const refreshToken = stored
      ? await unsealRefreshToken(
        stored.sealedRefreshToken,
        this.bindings.STENSIBLY_SERVICE_SECRET,
        this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
      )
      : this.bindings.STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN;

    const body = new URLSearchParams({
      client_id: this.bindings.STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const response = await this.fetchImpl(MICROSOFT_CONSUMER_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_OAUTH_REFRESH_FAILED");
    }
    const payload = await jsonRecord(response, "OUTLOOK_OAUTH_REFRESH_INVALID");
    if (typeof payload.access_token !== "string" || payload.access_token.length < 1) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_OAUTH_REFRESH_INVALID");
    }

    if (
      typeof payload.refresh_token === "string"
      && payload.refresh_token.length > 0
      && payload.refresh_token !== refreshToken
    ) {
      const sealedRefreshToken = await sealRefreshToken(
        payload.refresh_token,
        this.bindings.STENSIBLY_SERVICE_SECRET,
        this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
      );
      try {
        await this.store.setAuth({
          mailboxBindingId: this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
          expectedGeneration: stored?.generation ?? null,
          sealedRefreshToken,
        });
      } catch (error) {
        if (!isOutlookAuthCasConflict(error)) throw error;
        const latest = await this.store.getAuth(
          this.bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
        );
        if (!latest) throw error;
      }
    }
    return payload.access_token;
  }
}

async function admitNotificationBatch(
  request: Request,
  bindings: OutlookGraphBindings,
  store: OutlookRuntimeStore,
): Promise<AdmittedNotificationBatch> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAXIMUM_NOTIFICATION_BYTES) {
      throw new OutlookNotificationAdmissionError(400);
    }
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new OutlookNotificationAdmissionError(400);
  }
  const text = await readBoundedRequestText(request, MAXIMUM_NOTIFICATION_BYTES);
  if (text.length < 2) {
    throw new OutlookNotificationAdmissionError(400);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new OutlookNotificationAdmissionError(400);
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.value)) {
    throw new OutlookNotificationAdmissionError(400);
  }
  if (decoded.value.length < 1 || decoded.value.length > MAXIMUM_NOTIFICATION_BATCH) {
    throw new OutlookNotificationAdmissionError(400);
  }

  const receivedAt = canonicalNow(new Date());
  const notifications: OutlookMailboxNotification[] = [];
  for (const raw of decoded.value) {
    if (!isRecord(raw)) throw new OutlookNotificationAdmissionError(400);
    if (
      typeof raw.subscriptionId !== "string"
      || raw.subscriptionId.length < 1
      || typeof raw.clientState !== "string"
    ) {
      throw new OutlookNotificationAdmissionError(400);
    }
    if (!await protectedEqual(raw.clientState, bindings.STENSIBLY_OUTLOOK_CLIENT_STATE)) {
      throw new OutlookNotificationAdmissionError(403);
    }
    const lifecycleEvent = raw.lifecycleEvent === undefined
      ? "change"
      : raw.lifecycleEvent;
    if (
      lifecycleEvent !== "change"
      && lifecycleEvent !== "missed"
      && lifecycleEvent !== "reauthorizationRequired"
      && lifecycleEvent !== "subscriptionRemoved"
    ) {
      throw new OutlookNotificationAdmissionError(400);
    }
    const redacted = { ...raw, clientState: true };
    notifications.push(Object.freeze({
      provider: "outlook" as const,
      mailboxBindingId: bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
      notificationId: `graph_${fingerprintCanonicalRequest(redacted).slice("sha256:".length)}`,
      subscriptionId: raw.subscriptionId,
      clientStateVerified: true,
      lifecycleEvent,
      observedAt: receivedAt,
      receivedAt,
    }));
  }

  const binding = await store.getBinding(bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID);
  if (!binding || binding.subscription.externalId === null) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_SUBSCRIPTION_STATE_UNAVAILABLE");
  }
  for (const notification of notifications) {
    if (notification.subscriptionId !== binding.subscription.externalId) {
      throw new OutlookNotificationAdmissionError(403);
    }
  }
  return { response: null, notifications: Object.freeze(notifications) };
}

async function loadOrInitializeMailboxState(
  store: OutlookRuntimeStore,
  bindings: OutlookGraphBindings,
): Promise<{ state: MailboxSubscriptionState; revision: number }> {
  let binding = await store.getBinding(bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID);
  if (!binding) {
    const initial = createMailboxSubscriptionState({
      mailboxBindingId: bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
      provider: "outlook",
      scope: { kind: "folder", externalId: bindings.STENSIBLY_OUTLOOK_FOLDER_ID },
      cursor: {
        kind: "outlook_delta_ref",
        value: initialDeltaRef(bindings.STENSIBLY_OUTLOOK_FOLDER_ID),
      },
      coverage: "unknown",
      subscription: {
        externalId: null,
        expiresAt: null,
        health: "recovering",
        recoveryReason: "initial_sync",
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });
    try {
      await store.initialize(initial);
    } catch (error) {
      if (!String(error).includes("MAILBOX_INTAKE_BINDING_CONFLICT")) throw error;
    }
    binding = await store.getBinding(bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID);
    if (!binding) {
      throw new OutlookRuntimeRecoverableError("OUTLOOK_MAILBOX_STATE_INITIALIZATION_FAILED");
    }
  }

  const state = createMailboxSubscriptionState({
    mailboxBindingId: binding.mailboxBindingId,
    provider: binding.provider as "outlook",
    scope: binding.scope as { kind: "folder"; externalId: string },
    cursor: { kind: "outlook_delta_ref", value: binding.cursorValue },
    coverage: binding.coverage,
    subscription: binding.subscription,
    lastNotificationId: binding.lastNotificationId,
    lastSuccessfulReconciliationAt: binding.lastSuccessfulReconciliationAt,
  });
  if (
    state.provider !== "outlook"
    || state.scope.kind !== "folder"
    || state.scope.externalId !== bindings.STENSIBLY_OUTLOOK_FOLDER_ID
    || state.mailboxBindingId !== bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID
  ) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_MAILBOX_STATE_BINDING_MISMATCH");
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_MAILBOX_STATE_REVISION_INVALID");
  }
  return { state, revision: binding.revision };
}

async function loadKnownInScopeProviderMessageIds(
  store: OutlookRuntimeStore,
  mailboxBindingId: string,
): Promise<ReadonlySet<string>> {
  const observations = await store.listRecentObservations(mailboxBindingId);
  if (observations.length >= MAXIMUM_RECENT_OBSERVATIONS) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_KNOWN_SCOPE_HISTORY_SATURATED");
  }
  const known = new Set<string>();
  for (const observation of [...observations].reverse()) {
    const id = observation.providerMessageId;
    if (id === null) continue;
    if (
      observation.eventType === "mail.scope.removed"
      || observation.eventType === "mail.message.deleted"
    ) {
      known.delete(id);
      continue;
    }
    if (
      observation.eventType === "mail.scope.added"
      || observation.eventType === "mail.message.created"
      || observation.eventType === "mail.message.updated"
    ) {
      known.add(id);
    }
  }
  return known;
}

function persistentRecoveryNotification(
  state: MailboxSubscriptionState,
  revision: number,
  now: string,
): OutlookMailboxNotification | null {
  const reason = state.subscription.recoveryReason ?? "";
  const lifecycleEvent = reason.startsWith("subscription_removed")
    ? "subscriptionRemoved" as const
    : reason.startsWith("reauthorization_required")
      ? "reauthorizationRequired" as const
      : null;
  if (lifecycleEvent === null || state.subscription.externalId === null) return null;
  return Object.freeze({
    provider: "outlook" as const,
    mailboxBindingId: state.mailboxBindingId,
    notificationId: `runtime_${fingerprintCanonicalRequest({
      version: 1,
      lifecycleEvent,
      revision,
      subscriptionId: state.subscription.externalId,
    }).slice("sha256:".length)}`,
    subscriptionId: state.subscription.externalId,
    clientStateVerified: true,
    lifecycleEvent,
    observedAt: now,
    receivedAt: now,
  });
}

function initialDeltaRef(folderId: string): string {
  const url = `${GRAPH_API_ROOT}/me/mailFolders/${encodeURIComponent(folderId)}`
    + "/messages/delta?$select=id,conversationId&$top=64";
  return encodeGraphRef(url, folderId);
}

function encodeGraphRef(value: string, folderId: string): string {
  const url = exactGraphUrl(value, folderId);
  const bytes = new TextEncoder().encode(url.toString());
  const encoded = bytesToBase64Url(bytes);
  if (encoded.length > 4_096) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_REFERENCE_TOO_LARGE");
  }
  return encoded;
}

function decodeGraphRef(value: string, folderId: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(base64UrlToBytes(value));
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_REFERENCE_INVALID");
  }
  return exactGraphUrl(decoded, folderId).toString();
}

function exactGraphUrl(value: string, folderId: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_REFERENCE_INVALID");
  }
  const prefix = "/v1.0/me/mailFolders/";
  const suffix = "/messages/delta";
  let decodedFolderId: string;
  try {
    decodedFolderId = decodeURIComponent(
      url.pathname.slice(prefix.length, url.pathname.length - suffix.length),
    );
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_REFERENCE_INVALID");
  }
  if (
    url.origin !== GRAPH_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || !url.pathname.startsWith(prefix)
    || !url.pathname.endsWith(suffix)
    || decodedFolderId !== folderId
  ) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_REFERENCE_INVALID");
  }
  return url;
}

function exactSubscriptionListUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
  }
  if (
    url.origin !== GRAPH_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/v1.0/subscriptions"
  ) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_LIST_INVALID");
  }
  return url;
}

function subscriptionResource(folderId: string): string {
  return `me/mailFolders/${encodeURIComponent(folderId)}/messages`;
}

async function readBoundedRequestText(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  if (request.bodyUsed) throw new OutlookNotificationAdmissionError(400);
  if (!request.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw new OutlookNotificationAdmissionError(400);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        try {
          await reader.cancel("Outlook notification exceeds the configured bound");
        } catch {
          // The stream may already be closed or errored.
        }
        throw new OutlookNotificationAdmissionError(400);
      }
      chunks.push(next.value.slice());
    }
  } catch (error) {
    if (error instanceof OutlookNotificationAdmissionError) throw error;
    try {
      await reader.cancel("Outlook notification could not be read");
    } catch {
      // The stream may already be closed or errored.
    }
    throw new OutlookNotificationAdmissionError(400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OutlookNotificationAdmissionError(400);
  }
}

async function sealRefreshToken(
  value: string,
  serviceSecret: string,
  mailboxBindingId: string,
): Promise<string> {
  const key = await refreshTokenKey(serviceSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: cryptoBuffer(iv),
    additionalData: cryptoBuffer(refreshTokenAad(mailboxBindingId)),
  }, key, cryptoBuffer(new TextEncoder().encode(value)));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function unsealRefreshToken(
  value: string,
  serviceSecret: string,
  mailboxBindingId: string,
): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_STORED_REFRESH_TOKEN_INVALID");
  }
  try {
    const key = await refreshTokenKey(serviceSecret);
    const decrypted = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: cryptoBuffer(base64UrlToBytes(parts[1]!)),
      additionalData: cryptoBuffer(refreshTokenAad(mailboxBindingId)),
    }, key, cryptoBuffer(base64UrlToBytes(parts[2]!)));
    const token = new TextDecoder().decode(decrypted);
    if (token.length < 1) throw new Error("empty");
    return token;
  } catch {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_STORED_REFRESH_TOKEN_INVALID");
  }
}

async function refreshTokenKey(serviceSecret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(
    `stensibly/outlook-refresh-token/v1\u0000${serviceSecret}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", material);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function refreshTokenAad(mailboxBindingId: string): Uint8Array {
  return new TextEncoder().encode(
    `stensibly/outlook-refresh-token/v1:${mailboxBindingId}`,
  );
}

function cryptoBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function protectedEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function subscriptionProjection(
  payload: Record<string, unknown>,
): { id: string; expiration: string } {
  if (
    typeof payload.id !== "string"
    || payload.id.length < 1
    || typeof payload.expirationDateTime !== "string"
    || !Number.isFinite(Date.parse(payload.expirationDateTime))
  ) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_SUBSCRIPTION_INVALID");
  }
  return { id: payload.id, expiration: new Date(payload.expirationDateTime).toISOString() };
}

function invalidDeltaConversation(): never {
  throw new OutlookRuntimeRecoverableError("OUTLOOK_GRAPH_DELTA_INVALID");
}

async function jsonRecord(
  response: Response,
  code: string,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OutlookRuntimeRecoverableError(code);
  }
  if (!isRecord(payload)) throw new OutlookRuntimeRecoverableError(code);
  return payload;
}

function reconciliationId(input: {
  notificationId: string | null;
  expectedRevision: number;
  expectedCursor: string;
  now: string;
}): string {
  const scheduledHour = input.notificationId === null ? input.now.slice(0, 13) : null;
  return `outlook_${fingerprintCanonicalRequest({
    version: 1,
    notificationId: input.notificationId,
    scheduledHour,
    expectedRevision: input.expectedRevision,
    expectedCursor: input.expectedCursor,
  }).slice("sha256:".length)}`;
}

function canonicalNow(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new OutlookRuntimeRecoverableError("OUTLOOK_RUNTIME_CLOCK_INVALID");
  }
  return value.toISOString();
}

function requiredBinding(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length < 1) {
    throw new OutlookRuntimeRecoverableError(`OUTLOOK_BINDING_MISSING_${name}`);
  }
  return value;
}

function isMailboxCasConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("MAILBOX_INTAKE_REVISION_CONFLICT")
    || message.includes("MAILBOX_INTAKE_CURSOR_CONFLICT");
}

function isOutlookAuthCasConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OUTLOOK_RUNTIME_AUTH_REVISION_CONFLICT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class OutlookNotificationAdmissionError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403) {
    super(status === 403 ? "OUTLOOK_NOTIFICATION_FORBIDDEN" : "OUTLOOK_NOTIFICATION_INVALID");
    this.name = "OutlookNotificationAdmissionError";
    this.status = status;
  }
}
