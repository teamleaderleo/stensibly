import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
} from "../src/mailbox-intake-contract";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mailbox-intake-service-secret";
const initializeRef = makeFunctionReference<"mutation">("mailboxIntake:initialize");
const commitRef = makeFunctionReference<"mutation">("mailboxIntake:commitReconciliation");
const getRef = makeFunctionReference<"query">("mailboxIntake:getBinding");
const recentRef = makeFunctionReference<"query">("mailboxIntake:listRecentObservations");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable mailbox intake", () => {
  test("advances cursor and observations atomically, then replays one reconciliation exactly", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const initial = state("100");
    const initialized = await t.mutation(initializeRef, {
      ...serviceArgs(),
      stateJson: canonicalJsonString(initial),
    }) as any;
    expect(initialized).toMatchObject({ duplicate: false, revision: 1 });

    const next = state("105", {
      lastNotificationId: "pubsub-1",
      lastSuccessfulReconciliationAt: "2026-08-15T12:01:02.000Z",
    });
    const observations = [
      observation("101", "m_1", "mail.message.created"),
      observation("102", "m_2", "mail.message.created"),
    ];
    const request = {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      reconciliationId: "gmail-pubsub:pubsub-1",
      expectedRevision: 1,
      expectedCursor: "100",
      nextStateJson: canonicalJsonString(next),
      observationsJson: observations.map(canonicalJsonString),
    };

    const committed = await t.mutation(commitRef, request) as any;
    expect(committed).toMatchObject({
      duplicate: false,
      revision: 2,
      insertedObservations: 2,
    });
    const replayed = await t.mutation(commitRef, request) as any;
    expect(replayed).toEqual({
      duplicate: true,
      revision: 2,
      insertedObservations: 2,
    });

    const binding = await t.query(getRef, {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
    }) as any;
    expect(binding).toMatchObject({
      revision: 2,
      cursorValue: "105",
      coverage: "continuous",
      lastNotificationId: "pubsub-1",
    });
    expect(JSON.stringify(binding)).not.toContain("operator@example.com");

    const recent = await t.query(recentRef, {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      limit: 10,
    }) as any[];
    expect(recent).toHaveLength(2);
    expect(recent.every((row) => row.grantsAuthority === false)).toBe(true);
  });

  test("rejects stale cursor commits without admitting their observations", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const initial = state("100");
    await t.mutation(initializeRef, {
      ...serviceArgs(),
      stateJson: canonicalJsonString(initial),
    });

    const next = state("105");
    await expect(t.mutation(commitRef, {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      reconciliationId: "periodic:stale",
      expectedRevision: 1,
      expectedCursor: "99",
      nextStateJson: canonicalJsonString(next),
      observationsJson: [canonicalJsonString(
        observation("101", "m_stale", "mail.message.created"),
      )],
    })).rejects.toThrow("MAILBOX_INTAKE_CURSOR_CONFLICT");

    const recent = await t.query(recentRef, {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      limit: 10,
    }) as any[];
    expect(recent).toEqual([]);
  });

  test("rejects changed content under one reconciliation or observation identity", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const initial = state("100");
    await t.mutation(initializeRef, {
      ...serviceArgs(),
      stateJson: canonicalJsonString(initial),
    });
    const next = state("105");
    const base = {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      reconciliationId: "periodic:1",
      expectedRevision: 1,
      expectedCursor: "100",
      nextStateJson: canonicalJsonString(next),
      observationsJson: [canonicalJsonString(
        observation("101", "m_1", "mail.message.created"),
      )],
    };
    await t.mutation(commitRef, base);

    await expect(t.mutation(commitRef, {
      ...base,
      observationsJson: [canonicalJsonString(
        observation("101", "m_2", "mail.message.created"),
      )],
    })).rejects.toThrow("MAILBOX_INTAKE_RECONCILIATION_CONFLICT");
  });

  test("rejects a forged authority-bearing observation before durable admission", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const initial = state("100");
    await t.mutation(initializeRef, {
      ...serviceArgs(),
      stateJson: canonicalJsonString(initial),
    });
    const forged = JSON.parse(canonicalJsonString(
      observation("101", "m_1", "mail.message.created"),
    ));
    forged.grantsAuthority = true;

    await expect(t.mutation(commitRef, {
      ...serviceArgs(),
      mailboxBindingId: initial.mailboxBindingId,
      reconciliationId: "periodic:forged",
      expectedRevision: 1,
      expectedCursor: "100",
      nextStateJson: canonicalJsonString(state("105")),
      observationsJson: [canonicalJsonString(forged)],
    })).rejects.toThrow("Mailbox observation identity is inconsistent");
  });
});

function state(
  cursor: string,
  overrides: {
    lastNotificationId?: string | null;
    lastSuccessfulReconciliationAt?: string | null;
  } = {},
) {
  return createMailboxSubscriptionState({
    mailboxBindingId: "mailbox_operator_primary",
    provider: "gmail",
    scope: { kind: "label", externalId: "Label_Stensibly" },
    cursor: { kind: "gmail_history_id", value: cursor },
    coverage: "continuous",
    subscription: {
      externalId: null,
      expiresAt: "2026-08-17T12:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: overrides.lastNotificationId ?? null,
    lastSuccessfulReconciliationAt:
      overrides.lastSuccessfulReconciliationAt ?? null,
  });
}

function observation(
  historyId: string,
  messageId: string,
  eventType: "mail.message.created" | "mail.message.deleted",
) {
  return createMailboxObservation({
    provider: "gmail",
    mailboxBindingId: "mailbox_operator_primary",
    sourceSchema: "gmail-history",
    sourceEventId: `${historyId}:message:${messageId}`,
    eventType,
    providerCursor: historyId,
    providerMessageId: messageId,
    providerThreadId: `thread_${messageId}`,
    providerLabelId: null,
    observedAt: "2026-08-15T12:01:00.000Z",
    receivedAt: "2026-08-15T12:01:02.000Z",
    wakeEligible: eventType === "mail.message.created",
    loopDisposition: "ordinary",
  });
}

function serviceArgs() {
  return {
    serviceSecret,
    workspace: "test",
  };
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: "test",
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
