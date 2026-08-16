import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
} from "../src/mailbox-intake-contract";
import { createMailThreadRecord } from "../src/mail-thread-contract";
import type { MailProviderProjection } from "../src/mail-provider";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mail-correspondence-service-secret";
const listRef = makeFunctionReference<"query">("mailCorrespondence:listProjectSources");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted project correspondence source", () => {
  test("joins one project thread to provider, mailbox, effect, and observation evidence", async () => {
    const t = convexTest(schema, modules);
    await seedFixture(t);

    const result = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 12,
    }) as any;

    expect(result.rows).toHaveLength(1);
    expect(result).toMatchObject({
      threadsWithoutProviderProjection: 0,
      providerViewsWithoutMailboxState: 0,
      truncated: false,
    });
    expect(JSON.parse(result.rows[0].threadJson)).toMatchObject({
      project: "stensibly",
      handle: "STN-HANDOFF:GMA2",
    });
    expect(JSON.parse(result.rows[0].projectionJson)).toMatchObject({
      provider: "gmail",
      accountBinding: "gmail_operator_primary",
      providerThreadId: "gmail_thread_1",
    });
    expect(result.rows[0].effects).toEqual([expect.objectContaining({
      outboundEffectId: "effect_gmail",
      state: "sent",
    })]);
    expect(result.rows[0].observations).toEqual([expect.objectContaining({
      providerMessageId: "gmail_message_latest",
      providerThreadId: "gmail_thread_1",
      eventType: "mail.message.created",
    })]);
  });

  test("does not cross the selected project boundary", async () => {
    const t = convexTest(schema, modules);
    await seedFixture(t);

    const result = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "secret",
      limit: 12,
    }) as any;

    expect(result.rows).toEqual([]);
    expect(result.threadsWithoutProviderProjection).toBe(0);
  });
});

async function seedFixture(t: ReturnType<typeof convexTest>) {
  const state = createMailboxSubscriptionState({
    mailboxBindingId: "gmail_operator_primary",
    provider: "gmail",
    scope: { kind: "label", externalId: "Label_5" },
    cursor: { kind: "gmail_history_id", value: "105" },
    coverage: "continuous",
    subscription: {
      externalId: "gmail_subscription",
      expiresAt: "2026-08-17T05:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-16T04:32:00.000Z",
  });
  const observation = createMailboxObservation({
    provider: "gmail",
    mailboxBindingId: "gmail_operator_primary",
    sourceSchema: "gmail-history",
    sourceEventId: "105:message:gmail_message_latest",
    eventType: "mail.message.created",
    providerCursor: "105",
    providerMessageId: "gmail_message_latest",
    providerThreadId: "gmail_thread_1",
    providerScopeId: "Label_5",
    observedAt: "2026-08-16T04:32:00.000Z",
    receivedAt: "2026-08-16T04:32:02.000Z",
    wakeEligible: true,
    loopDisposition: "ordinary",
  });
  const thread = createMailThreadRecord({
    threadId: "mail_thread_gmail",
    handle: "STN-HANDOFF:GMA2",
    workspace: "test",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: "Continue correspondence dogfood",
    sourceIdentity: "github:teamleaderleo/stensibly#1582",
    resolutionCondition: "Render one authenticated project read.",
    createdAt: "2026-08-16T04:00:00.000Z",
  });
  const projection: MailProviderProjection = {
    version: 1,
    threadId: thread.threadId,
    provider: "gmail",
    accountBinding: "gmail_operator_primary",
    mailboxAddress: "operator@gmail.invalid",
    providerThreadId: "gmail_thread_1",
    rootProviderMessageId: "gmail_message_root",
    latestProviderMessageId: "gmail_message_latest",
    rootRfcMessageId: null,
    latestRfcMessageId: null,
    latestSentFingerprint: `sha256:${"a".repeat(64)}`,
    lastVerifiedSubject: "Continue correspondence dogfood",
    lastVerifiedReferences: [],
    verifiedAt: "2026-08-16T04:31:00.000Z",
  };

  await t.run(async (ctx: any) => {
    const now = Date.parse("2026-08-16T04:33:00.000Z");
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: "test",
      name: "Test",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("mailOutboundThreads", {
      workspaceId,
      threadId: thread.threadId,
      handle: thread.handle,
      project: thread.project,
      sourceIdentity: thread.sourceIdentity,
      threadJson: JSON.stringify(thread),
      createdAt: Date.parse(thread.createdAt),
      updatedAt: Date.parse(thread.updatedAt),
    });
    await ctx.db.insert("mailOutboundProviderProjections", {
      workspaceId,
      threadId: thread.threadId,
      provider: "gmail",
      accountBinding: "gmail_operator_primary",
      mailboxAddress: projection.mailboxAddress,
      providerThreadId: projection.providerThreadId,
      projectionJson: JSON.stringify(projection),
      createdAt: Date.parse(projection.verifiedAt),
      updatedAt: Date.parse(projection.verifiedAt),
    });
    await ctx.db.insert("mailOutboundEffects", {
      workspaceId,
      outboundEffectId: "effect_gmail",
      threadId: thread.threadId,
      provider: "gmail",
      accountBinding: "gmail_operator_primary",
      mailboxAddress: projection.mailboxAddress,
      contentFingerprint: `sha256:${"a".repeat(64)}`,
      attemptNumber: 1,
      state: "sent",
      effectJson: "{}",
      createdAt: Date.parse("2026-08-16T04:30:00.000Z"),
      updatedAt: Date.parse("2026-08-16T04:31:00.000Z"),
    });
    await ctx.db.insert("mailboxIntakeBindings", {
      workspaceId,
      mailboxBindingId: state.mailboxBindingId,
      provider: state.provider,
      cursorValue: state.cursor.value,
      coverage: state.coverage,
      stateJson: canonicalJsonString(state),
      revision: 2,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("mailboxIntakeObservations", {
      workspaceId,
      mailboxBindingId: observation.mailboxBindingId,
      observationId: observation.observationId,
      semanticFingerprint: observation.semanticFingerprint,
      provider: observation.provider,
      eventType: observation.eventType,
      providerCursor: observation.providerCursor,
      observedAt: Date.parse(observation.observedAt),
      receivedAt: Date.parse(observation.receivedAt),
      observationJson: canonicalJsonString(observation),
      createdAt: now,
    });
  });
}
