import { describe, expect, test } from "bun:test";
import {
  createMailboxSubscriptionState,
  type MailboxProvider,
} from "../src/mailbox-intake-contract.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import type { MailProviderProjection } from "../src/mail-provider.ts";
import {
  assembleProjectCorrespondenceV1,
  type ProjectCorrespondenceSourceCandidateV1,
  type ProjectCorrespondenceSourceV1,
} from "../src/project-correspondence.ts";

const asOf = "2026-08-16T05:20:00.000Z";

function candidate(
  provider: MailboxProvider,
  handle: string,
  updatedAt: string,
  options: { effectState?: "sent" | "ambiguous"; coverage?: "continuous" | "unknown" } = {},
): ProjectCorrespondenceSourceCandidateV1 {
  const accountBinding = `${provider}_operator_primary`;
  const threadId = `mail_thread_${provider}`;
  const created = createMailThreadRecord({
    threadId,
    handle,
    workspace: "default",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: `${provider} continuation`,
    sourceIdentity: `github:teamleaderleo/stensibly#${provider === "gmail" ? "1582" : "1586"}`,
    resolutionCondition: "Land the next bounded correspondence slice.",
    createdAt: "2026-08-16T04:00:00.000Z",
  });
  const thread = Object.freeze({ ...created, updatedAt });
  const providerProjection: MailProviderProjection = Object.freeze({
    version: 1,
    threadId,
    provider,
    accountBinding,
    mailboxAddress: provider === "gmail" ? "operator@gmail.invalid" : "operator@outlook.invalid",
    providerThreadId: `${provider}_thread_1`,
    rootProviderMessageId: `${provider}_message_root`,
    latestProviderMessageId: `${provider}_message_latest`,
    rootRfcMessageId: null,
    latestRfcMessageId: null,
    latestSentFingerprint: `sha256:${"a".repeat(64)}`,
    lastVerifiedSubject: `${provider} continuation`,
    lastVerifiedReferences: [],
    verifiedAt: updatedAt,
  });
  const mailboxState = createMailboxSubscriptionState({
    mailboxBindingId: accountBinding,
    provider,
    scope: provider === "gmail"
      ? { kind: "label", externalId: "Label_5" }
      : { kind: "folder", externalId: "folder_stensibly" },
    cursor: provider === "gmail"
      ? { kind: "gmail_history_id", value: "105" }
      : { kind: "outlook_delta_ref", value: "delta:105" },
    coverage: options.coverage ?? "continuous",
    subscription: {
      externalId: `${provider}_subscription`,
      expiresAt: "2026-08-17T05:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-16T05:10:00.000Z",
  });
  const effectState = options.effectState ?? "sent";
  return Object.freeze({
    thread,
    providerProjection,
    mailboxState,
    effects: Object.freeze([Object.freeze({
      outboundEffectId: `effect_${provider}`,
      state: effectState,
      reservedAt: "2026-08-16T04:30:00.000Z",
      settledAt: "2026-08-16T04:31:00.000Z",
    })]),
    observations: Object.freeze([Object.freeze({
      observationId: `observation_${provider}`,
      eventType: "mail.message.created",
      providerMessageId: `${provider}_message_latest`,
      providerThreadId: `${provider}_thread_1`,
      observedAt: "2026-08-16T04:32:00.000Z",
    })]),
    truncated: false,
  });
}

describe("project correspondence assembly", () => {
  test("projects Gmail and Outlook through one bounded read model", async () => {
    const requests: unknown[] = [];
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject(request) {
        requests.push(request);
        return {
          candidates: [
            candidate("gmail", "STN-HANDOFF:GMA2", "2026-08-16T04:50:00.000Z"),
            candidate("outlook", "STN-HANDOFF:VUT2", "2026-08-16T05:00:00.000Z"),
          ],
          threadsWithoutProviderProjection: 1,
          providerViewsWithoutMailboxState: 1,
          truncated: false,
        };
      },
    };

    const result = await assembleProjectCorrespondenceV1(source, {
      project: "stensibly",
      limit: 12,
      asOf,
    });

    expect(requests).toEqual([{ project: "stensibly", limit: 12, asOf }]);
    expect(result.rows.map((row) => row.provider)).toEqual(["outlook", "gmail"]);
    expect(result.rows.every((row) => row.authorizesMutation === false)).toBe(true);
    expect(result.rows.every((row) => row.grantsAuthority === false)).toBe(true);
    expect(result.rows[0]?.joins.map((join) => join.kind)).toEqual([
      "provider_message",
      "provider_thread",
    ]);
    expect(result.completeness).toEqual({
      truncated: false,
      threadsWithoutProviderProjection: 1,
      providerViewsWithoutMailboxState: 1,
      rejectedCandidates: 0,
    });
  });

  test("keeps ambiguity and partial mailbox coverage visible", async () => {
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject() {
        return {
          candidates: [candidate(
            "gmail",
            "STN-HANDOFF:AMB2",
            "2026-08-16T05:00:00.000Z",
            { effectState: "ambiguous", coverage: "unknown" },
          )],
          threadsWithoutProviderProjection: 0,
          providerViewsWithoutMailboxState: 0,
          truncated: false,
        };
      },
    };

    const result = await assembleProjectCorrespondenceV1(source, {
      project: "stensibly",
      limit: 12,
      asOf,
    });
    expect(result.rows[0]?.freshness.currentness).toBe("partial");
    expect(result.rows[0]?.materialPreview.current).toContain("requires reconciliation");
    expect(result.rows[0]?.stages.map((stage) => stage.kind)).toContain("outbound_reserved");
    expect(result.rows[0]?.stages.map((stage) => stage.kind)).not.toContain("provider_send_accepted");
  });

  test("rejects a source row that escapes the requested project", async () => {
    const foreign = candidate("gmail", "STN-HANDOFF:FRGN", "2026-08-16T05:00:00.000Z");
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject() {
        return {
          candidates: [Object.freeze({
            ...foreign,
            thread: Object.freeze({ ...foreign.thread, project: "scrapbook" }),
          })],
          threadsWithoutProviderProjection: 0,
          providerViewsWithoutMailboxState: 0,
          truncated: false,
        };
      },
    };

    await expect(assembleProjectCorrespondenceV1(source, {
      project: "stensibly",
      limit: 12,
      asOf,
    })).rejects.toThrow("escaped project scope");
  });
});
