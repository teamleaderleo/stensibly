import { describe, expect, test } from "bun:test";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
  mailboxObservationEventTypes,
} from "../src/mailbox-intake-contract.ts";

describe("mailbox intake contract", () => {
  test("keeps provider-neutral mailbox, cursor, scope, and authority facts explicit", () => {
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "outlook",
      scope: {
        kind: "folder",
        externalId: "folder_stensibly",
      },
      cursor: {
        kind: "outlook_delta_ref",
        value: "cursor_ref_delta_1",
      },
      coverage: "continuous",
      subscription: {
        externalId: "subscription_123",
        expiresAt: "2026-08-16T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: "2026-08-15T12:00:00.000Z",
    });

    expect(state).toEqual({
      version: 1,
      mailboxBindingId: "mailbox_operator_primary",
      provider: "outlook",
      scope: {
        kind: "folder",
        externalId: "folder_stensibly",
      },
      cursor: {
        kind: "outlook_delta_ref",
        value: "cursor_ref_delta_1",
      },
      coverage: "continuous",
      subscription: {
        externalId: "subscription_123",
        expiresAt: "2026-08-16T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: "2026-08-15T12:00:00.000Z",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(mailboxObservationEventTypes).toContain("mail.message.updated");
    expect(mailboxObservationEventTypes).toContain("mail.scope.added");
    expect(mailboxObservationEventTypes).not.toContain("mail.label.added" as never);
  });

  test("builds content-minimized observations that can never carry authority", () => {
    const observation = createMailboxObservation({
      provider: "gmail",
      mailboxBindingId: "mailbox_operator_primary",
      sourceSchema: "gmail-history",
      sourceEventId: "history:101:messageAdded:m_1",
      eventType: "mail.message.created",
      providerCursor: "101",
      providerMessageId: "m_1",
      providerThreadId: "t_1",
      providerScopeId: null,
      observedAt: "2026-08-15T12:01:00.000Z",
      receivedAt: "2026-08-15T12:01:01.000Z",
      wakeEligible: true,
      loopDisposition: "ordinary",
    });

    expect(observation).toMatchObject({
      version: 1,
      provider: "gmail",
      mailboxBindingId: "mailbox_operator_primary",
      sourceSchema: "gmail-history",
      eventType: "mail.message.created",
      providerMessageId: "m_1",
      providerThreadId: "t_1",
      providerScopeId: null,
      providerCursor: "101",
      wakeEligible: true,
      loopDisposition: "ordinary",
      containsRawContent: false,
      grantsAuthority: false,
    });
    expect(observation.observationId).toMatch(/^mail:gmail:/);
    expect(observation.semanticFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(observation)).not.toContain("subject");
    expect(JSON.stringify(observation)).not.toContain("body");
    expect(JSON.stringify(observation)).not.toContain("providerLabelId");
    expect(Object.isFrozen(observation)).toBe(true);
  });

  test("canonicalizes Gmail label events into provider-neutral scope events", () => {
    const observation = createMailboxObservation({
      provider: "gmail",
      mailboxBindingId: "mailbox_operator_primary",
      sourceSchema: "gmail-history",
      sourceEventId: "history:102:labelAdded:m_2:Label_5",
      eventType: "mail.label.added",
      providerCursor: "102",
      providerMessageId: "m_2",
      providerThreadId: "t_2",
      providerLabelId: "Label_5",
      observedAt: "2026-08-15T12:01:00.000Z",
      receivedAt: "2026-08-15T12:01:01.000Z",
      wakeEligible: true,
      loopDisposition: "ordinary",
    });

    expect(observation).toMatchObject({
      eventType: "mail.scope.added",
      providerScopeId: "Label_5",
    });
    expect(JSON.stringify(observation)).not.toContain("mail.label.added");
    expect(JSON.stringify(observation)).not.toContain("providerLabelId");
  });

  test("rejects mailbox state that crosses provider and scope contracts", () => {
    expect(() => createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "gmail",
      scope: { kind: "folder", externalId: "folder_1" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: null,
        expiresAt: "2026-08-16T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    })).toThrow("Gmail mailbox scope must be a label");

    expect(() => createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "outlook",
      scope: { kind: "folder", externalId: "folder_1" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: "subscription_1",
        expiresAt: "2026-08-16T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    })).toThrow("Outlook mailbox cursor must be a delta reference");
  });
});
