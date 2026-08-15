import { describe, expect, test } from "bun:test";
import {
  measureMailSelectionRun,
  selectMailContinuation,
  type MailCurrentDisposition,
  type MailSelectionCheckpoint,
  type MailValueTier,
} from "../src/mail-ux-selection.ts";

function checkpoint(
  handle: string,
  overrides: Partial<MailSelectionCheckpoint> = {},
): MailSelectionCheckpoint {
  return {
    handle,
    attentionClass: handle.startsWith("STN-REVIEW:") ? "review" : "handoff",
    providerMessageId: `gmail-${handle}`,
    providerThreadId: `thread-${handle}`,
    subject: `[${handle}] dogfood checkpoint`,
    surface: "stensibly_label",
    messageAt: "2026-08-15T06:00:00.000Z",
    actionableAt: "2026-08-15T06:00:00.000Z",
    bodyFetched: false,
    bodyBytes: 0,
    sourceReadback: readback("actionable"),
    ...overrides,
  };
}

function readback(
  disposition: MailCurrentDisposition,
  valueTier: MailValueTier = "normal",
) {
  return {
    sourceRef: "github:teamleaderleo/stensibly#1493",
    checkedAt: "2026-08-15T06:50:00.000Z",
    githubCheckedAt: "2026-08-15T06:49:00.000Z",
    disposition,
    valueTier,
    currentRevision: "37c0175f45774c65bc8f62acf90b469e0f064044",
    currentAction: disposition === "actionable"
      ? "Take one executable current-source action."
      : "Preserve the current disposition.",
    reason: `Current evidence classifies this checkpoint as ${disposition}.`,
  } as const;
}

function liveDogfoodCheckpoints(): MailSelectionCheckpoint[] {
  return [
    checkpoint("STN-HANDOFF:K8R4", {
      providerMessageId: "1a00403dd88eacc5",
      providerThreadId: "1a00403dd88eacc5",
      messageAt: "2026-08-15T06:02:37.000Z",
      actionableAt: "2026-08-15T06:02:37.000Z",
      sourceReadback: null,
    }),
    checkpoint("STN-HANDOFF:K8R4", {
      providerMessageId: "1a00412764828bd6",
      providerThreadId: "1a00403dd88eacc5",
      messageAt: "2026-08-15T06:18:33.000Z",
      actionableAt: "2026-08-15T06:18:33.000Z",
      sourceReadback: {
        ...readback("waiting", "low"),
        sourceRef: "github:teamleaderleo/stensibly#1489",
        currentRevision: "5300905149",
        currentAction: "Wait for a real GitHub notification in the canonical Gmail mailbox.",
        reason: "The source-first fresh-chat relay is accepted; native email reply dogfood still lacks an authentic GitHub notification message.",
      },
    }),
    checkpoint("STN-HANDOFF:Q7MP", {
      providerMessageId: "1a0040bf0fe54516",
      messageAt: "2026-08-15T06:11:26.000Z",
      actionableAt: "2026-08-15T06:11:26.000Z",
      sourceReadback: null,
    }),
    checkpoint("STN-HANDOFF:Q7MP", {
      providerMessageId: "1a004128c4ccf71b",
      messageAt: "2026-08-15T06:18:39.000Z",
      actionableAt: "2026-08-15T06:18:39.000Z",
      sourceReadback: {
        ...readback("superseded"),
        sourceRef: "github:teamleaderleo/stensibly#1493",
        currentRevision: "c3f16ab0f45b431b0e1fea00bdb7c4d3b647e61f",
        currentAction: "Use the broader-entrypoint selector lane instead of replaying the old exact-handle experiment.",
        reason: "The compact mail UX slice merged and exact-handle continuation moved on to broader selection dogfood.",
      },
    }),
    checkpoint("STN-REVIEW:7K3R", {
      providerMessageId: "1a00423443f3004a",
      providerThreadId: "1a0042223b3ee855",
      surface: "inbox",
      messageAt: "2026-08-15T06:36:55.000Z",
      actionableAt: "2026-08-15T06:35:41.000Z",
      sourceReadback: {
        ...readback("resolved"),
        sourceRef: "github:teamleaderleo/stensibly#1491",
        currentRevision: "5300972398",
        currentAction: "Keep the exact projected comment quiet after provider readback.",
        reason: "GitHub already contains the exact repository-facing comment proposed by the Gmail message.",
      },
    }),
    checkpoint("STN-REVIEW:R7MK", {
      providerMessageId: "1a00425848c3e8a3",
      providerThreadId: "1a00425848c3e8a3",
      surface: "inbox",
      messageAt: "2026-08-15T06:39:22.000Z",
      actionableAt: "2026-08-15T06:39:22.000Z",
      sourceReadback: {
        ...readback("actionable", "high"),
        sourceRef: "github:teamleaderleo/stensibly#1487",
        currentRevision: "11273c03a9726ed67be392ebe72763b4453cd2af",
        currentAction: "Inspect the failing Bun-test evidence, then repair/rebase the exact candidate before any land decision.",
        reason: "PR #1487 is open and diverged 10 commits ahead / 4 behind refreshed main; exact-head CI failed in the Bun test step, so repair work is executable now.",
      },
    }),
    checkpoint("STN-HANDOFF:6X7N", {
      providerMessageId: "1a0042906fe7ad02",
      providerThreadId: "1a0042906fe7ad02",
      surface: "inbox",
      messageAt: "2026-08-15T06:43:12.000Z",
      actionableAt: "2026-08-15T06:43:12.000Z",
      sourceReadback: null,
    }),
    checkpoint("STN-HANDOFF:6X7N", {
      providerMessageId: "1a00429f4d9b7a37",
      providerThreadId: "1a0042906fe7ad02",
      surface: "inbox",
      messageAt: "2026-08-15T06:44:13.000Z",
      actionableAt: "2026-08-15T06:44:13.000Z",
      sourceReadback: {
        ...readback("resolved", "normal"),
        sourceRef: "gmail:thread:1a0042906fe7ad02",
        currentRevision: "6efc06ac7e4aa8aa3b9daec8f5da897f4c63f3b8",
        currentAction: "No further handoff action; exact-handle search verified root plus material update in one Gmail thread.",
        reason: "The raced Inbox handoff was selected after refreshing #1492/PR #1497; Gmail then proved both material messages share the same provider thread, satisfying its resolution condition.",
      },
    }),
  ];
}

function withSelectedReviewBody(
  checkpoints: MailSelectionCheckpoint[],
  bodyBytes: number,
): MailSelectionCheckpoint[] {
  return checkpoints.map((item) => item.providerMessageId === "1a00425848c3e8a3"
    ? { ...item, bodyFetched: true, bodyBytes }
    : item);
}

describe("mail UX broad-entrypoint selection", () => {
  test("highest-value review picks current executable work before fetching any body", () => {
    const result = selectMailContinuation(
      liveDogfoodCheckpoints(),
      "highest_value_eligible_review",
    );

    expect(result.selected?.handle).toBe("STN-REVIEW:R7MK");
    expect(result.selected?.sourceReadback?.currentAction).toContain("repair/rebase");
    expect(result.selectedNeedsBodyFetch).toBe(true);
    expect(result.readyForAction).toBe(false);
    expect(result.bodyMessagesFetched).toBe(0);
    expect(result.bodyContextBytes).toBe(0);
    expect(result.currentSourceReads).toBe(2);
    expect(result.rejectedByCurrentSource).toBe(1);
    expect(result.rejections).toContainEqual({
      handle: "STN-REVIEW:7K3R",
      providerMessageId: "1a00423443f3004a",
      reason: "resolved",
    });
    expect(result.authorizesOperation).toBe(false);
    expect(result.authorizesMutation).toBe(false);
  });

  test("fetches only the selected review body before action", () => {
    const result = selectMailContinuation(
      withSelectedReviewBody(liveDogfoodCheckpoints(), 1_318),
      "highest_value_eligible_review",
    );

    expect(result.selected?.handle).toBe("STN-REVIEW:R7MK");
    expect(result.selectedNeedsBodyFetch).toBe(false);
    expect(result.readyForAction).toBe(true);
    expect(result.bodyMessagesFetched).toBe(1);
    expect(result.bodyContextBytes).toBe(1_318);
  });

  test("oldest actionable handoff is empty after the raced Inbox handoff is resolved", () => {
    const result = selectMailContinuation(
      liveDogfoodCheckpoints(),
      "oldest_actionable_handoff",
    );

    expect(result.selected).toBeNull();
    expect(result.bodyMessagesFetched).toBe(0);
    expect(result.bodyContextBytes).toBe(0);
    expect(result.currentSourceReads).toBe(3);
    expect(result.rejectedByCurrentSource).toBe(3);
    expect(result.rejections.some((item) =>
      item.handle === "STN-HANDOFF:K8R4" && item.reason === "waiting"
    )).toBe(true);
    expect(result.rejections.some((item) =>
      item.handle === "STN-HANDOFF:Q7MP" && item.reason === "superseded"
    )).toBe(true);
    expect(result.rejections.some((item) =>
      item.handle === "STN-HANDOFF:6X7N" && item.reason === "resolved"
    )).toBe(true);
    expect(result.rejections.filter((item) => item.reason === "older_checkpoint")).toHaveLength(3);
  });

  test("useful-lane fallback picks the same repair from current checkpoint metadata", () => {
    const result = selectMailContinuation(liveDogfoodCheckpoints(), "useful_lane");

    expect(result.selected?.handle).toBe("STN-REVIEW:R7MK");
    expect(result.selectedNeedsBodyFetch).toBe(true);
    expect(result.latestHandlesSeen).toBe(5);
    expect(result.bodyMessagesFetched).toBe(0);
    expect(result.bodyContextBytes).toBe(0);
    expect(result.currentSourceReads).toBe(5);
    expect(result.rejectedByCurrentSource).toBe(4);
  });

  test("stranded work remains eligible and outranks equally valued fresh work", () => {
    const result = selectMailContinuation([
      checkpoint("STN-REVIEW:ABCD", {
        actionableAt: "2026-08-15T06:30:00.000Z",
        sourceReadback: readback("actionable", "high"),
      }),
      checkpoint("STN-REVIEW:BCDE", {
        actionableAt: "2026-08-14T06:30:00.000Z",
        sourceReadback: readback("stranded", "high"),
      }),
    ], "highest_value_eligible_review");

    expect(result.selected?.handle).toBe("STN-REVIEW:BCDE");
  });

  test("refuses stale disposition evidence", () => {
    const result = selectMailContinuation([
      checkpoint("STN-REVIEW:ABCD", {
        messageAt: "2026-08-15T06:40:00.000Z",
        sourceReadback: {
          ...readback("actionable", "urgent"),
          checkedAt: "2026-08-15T06:39:59.000Z",
        },
      }),
    ], "highest_value_eligible_review");

    expect(result.selected).toBeNull();
    expect(result.rejections[0]?.reason).toBe("stale_source_readback");
  });

  test("requires a GitHub reread newer than the mail even when other evidence is current", () => {
    const result = selectMailContinuation([
      checkpoint("STN-REVIEW:ABCD", {
        messageAt: "2026-08-15T06:40:00.000Z",
        sourceReadback: {
          ...readback("actionable", "urgent"),
          checkedAt: "2026-08-15T06:41:00.000Z",
          githubCheckedAt: "2026-08-15T06:39:59.000Z",
        },
      }),
    ], "highest_value_eligible_review");

    expect(result.selected).toBeNull();
    expect(result.rejections[0]?.reason).toBe("stale_github_readback");
  });

  test("measures useful-action body cost and wrong selections explicitly", () => {
    expect(measureMailSelectionRun({
      messagesFetched: 1,
      contextBytes: 1_318,
      turnsToUsefulAction: 1,
      selectedHandle: "STN-REVIEW:R7MK",
      expectedHandle: "STN-REVIEW:R7MK",
    })).toEqual({
      messagesFetched: 1,
      contextBytes: 1_318,
      turnsToUsefulAction: 1,
      wrongSelections: 0,
    });

    expect(measureMailSelectionRun({
      messagesFetched: 1,
      contextBytes: 1_665,
      turnsToUsefulAction: 1,
      selectedHandle: "STN-HANDOFF:6X7N",
      expectedHandle: "STN-HANDOFF:6X7N",
    }).wrongSelections).toBe(0);

    expect(measureMailSelectionRun({
      messagesFetched: 1,
      contextBytes: 709,
      turnsToUsefulAction: 1,
      selectedHandle: "STN-REVIEW:7K3R",
      expectedHandle: "STN-REVIEW:R7MK",
    }).wrongSelections).toBe(1);
  });
});
