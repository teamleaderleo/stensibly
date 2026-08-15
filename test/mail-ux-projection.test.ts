import { describe, expect, test } from "bun:test";
import {
  classifyMailThreadTemperature,
  compileMailDigest,
  gmailMailboxDisposition,
  gmailViewLabel,
  relayContextReduction,
  renderMaterialMailMessage,
  type MailThreadSnapshot,
} from "../src/mail-ux-projection.ts";

const asOf = "2026-08-15T06:30:00.000Z";

function thread(
  handle: string,
  overrides: Partial<MailThreadSnapshot> = {},
): MailThreadSnapshot {
  return {
    handle,
    attentionClass: "handoff",
    operatorAttentionRequired: false,
    title: "Continue bounded mail UX dogfood",
    changed: "Compact continuation fixture is ready for a fresh-source reread.",
    current: "github:teamleaderleo/stensibly#1493 at main ba5c571c8550",
    nextAction: "Read the newest material message and inspect the exact current GitHub source.",
    resolution: "Record one measured successor result on #1493.",
    strongestSource: "github:teamleaderleo/stensibly#1493",
    state: "active",
    updatedAt: "2026-08-15T06:00:00.000Z",
    actionableAt: "2026-08-15T06:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

describe("mail UX projection", () => {
  test("puts the copy-ready launch line first and keeps one material message compact", () => {
    const message = renderMaterialMailMessage(thread("STN-HANDOFF:Q7MP"));

    expect(message.launchLine).toBe("Continue STN-HANDOFF:Q7MP.");
    expect(message.body.split("\n")[0]).toBe(message.launchLine);
    expect(message.body).toContain("Current: github:teamleaderleo/stensibly#1493 at main ba5c571c8550");
    expect(message.body).toContain("Next: Read the newest material message and inspect the exact current GitHub source.");
    expect(message.bodyBytes).toBeLessThan(600);
    expect(message.authorizesOperation).toBe(false);
    expect(message.authorizesMutation).toBe(false);
  });

  test("keeps thread temperature in the projection while Gmail starts with one view", () => {
    const hot = thread("STN-REVIEW:AAAA", {
      attentionClass: "review",
    });
    const waiting = thread("STN-HANDOFF:BBBB", {
      state: "waiting",
    });
    const stranded = thread("STN-HANDOFF:CCCC", {
      updatedAt: "2026-08-13T00:00:00.000Z",
      actionableAt: "2026-08-13T00:00:00.000Z",
    });
    const resolved = thread("STN-HANDOFF:DDDD", {
      state: "resolved",
      resolvedAt: "2026-08-15T05:30:00.000Z",
    });

    expect(classifyMailThreadTemperature(hot, asOf)).toBe("hot");
    expect(classifyMailThreadTemperature(waiting, asOf)).toBe("waiting");
    expect(classifyMailThreadTemperature(stranded, asOf)).toBe("stranded");
    expect(classifyMailThreadTemperature(resolved, asOf)).toBe("resolved");

    expect(gmailViewLabel("hot")).toBe("Stensibly");
    expect(gmailViewLabel("active")).toBe("Stensibly");
    expect(gmailViewLabel("stranded")).toBe("Stensibly");
    expect(gmailViewLabel("waiting")).toBe("Stensibly");
    expect(gmailViewLabel("resolved")).toBe("Stensibly");
  });

  test("archives routine mail and preserves only unresolved explicit operator attention", () => {
    const routineReview = thread("STN-REVIEW:REV2", {
      attentionClass: "review",
      operatorAttentionRequired: false,
    });
    const routineDecision = thread("STN-DECISION:D7C3", {
      attentionClass: "decision",
      operatorAttentionRequired: false,
    });
    const routineIncident = thread("STN-INCIDENT:C7D3", {
      attentionClass: "incident",
      operatorAttentionRequired: false,
    });
    const humanDecision = thread("STN-DECISION:DEC3", {
      attentionClass: "decision",
      operatorAttentionRequired: true,
    });
    const waitingHuman = thread("STN-REVIEW:WAXT", {
      attentionClass: "review",
      operatorAttentionRequired: true,
      state: "waiting",
    });
    const resolvedIncident = thread("STN-INCIDENT:FX22", {
      attentionClass: "incident",
      operatorAttentionRequired: true,
      state: "resolved",
      resolvedAt: "2026-08-15T06:10:00.000Z",
    });

    expect(gmailMailboxDisposition(routineReview)).toEqual({
      label: "Stensibly",
      archive: true,
      markRead: true,
      reason: "routine",
    });
    expect(gmailMailboxDisposition(routineDecision)).toEqual({
      label: "Stensibly",
      archive: true,
      markRead: true,
      reason: "routine",
    });
    expect(gmailMailboxDisposition(routineIncident)).toEqual({
      label: "Stensibly",
      archive: true,
      markRead: true,
      reason: "routine",
    });
    expect(gmailMailboxDisposition(humanDecision)).toEqual({
      label: "Stensibly",
      archive: false,
      markRead: false,
      reason: "operator_attention",
    });
    expect(gmailMailboxDisposition(waitingHuman)).toEqual({
      label: "Stensibly",
      archive: true,
      markRead: true,
      reason: "waiting",
    });
    expect(gmailMailboxDisposition(resolvedIncident)).toEqual({
      label: "Stensibly",
      archive: true,
      markRead: true,
      reason: "resolved",
    });
  });

  test("digest keeps urgent and stranded work ahead of routine continuation", () => {
    const digest = compileMailDigest([
      thread("STN-HANDOFF:ACT2", {
        title: "Routine continuation",
        updatedAt: "2026-08-15T06:15:00.000Z",
        actionableAt: "2026-08-15T06:15:00.000Z",
      }),
      thread("STN-HANDOFF:XGD2", {
        title: "Stranded continuation",
        updatedAt: "2026-08-13T00:00:00.000Z",
        actionableAt: "2026-08-13T00:00:00.000Z",
      }),
      thread("STN-REVIEW:REV2", {
        attentionClass: "review",
        title: "Old review",
        updatedAt: "2026-08-15T05:00:00.000Z",
        actionableAt: "2026-08-15T04:00:00.000Z",
      }),
      thread("STN-DECISION:DEC3", {
        attentionClass: "decision",
        title: "New decision",
        updatedAt: "2026-08-15T06:00:00.000Z",
        actionableAt: "2026-08-15T05:30:00.000Z",
      }),
      thread("STN-HANDOFF:DNE4", {
        title: "Resolved handoff",
        state: "resolved",
        updatedAt: "2026-08-15T05:45:00.000Z",
        actionableAt: "2026-08-15T05:00:00.000Z",
        resolvedAt: "2026-08-15T05:45:00.000Z",
      }),
    ], asOf);

    expect(digest.rows.map((row) => row.handle)).toEqual([
      "STN-REVIEW:REV2",
      "STN-DECISION:DEC3",
      "STN-HANDOFF:XGD2",
      "STN-HANDOFF:ACT2",
      "STN-HANDOFF:DNE4",
    ]);
    expect(digest.counts).toEqual({
      hot: 2,
      active: 1,
      waiting: 0,
      resolved: 1,
      stranded: 1,
    });
    expect(digest.authorizesOperation).toBe(false);
    expect(digest.authorizesMutation).toBe(false);
  });

  test("records relay context cost and whether isolation was a real fresh chat", () => {
    const measurement = {
      workerIsolation: "same_chat_protocol_replay" as const,
      operatorTaps: 4,
      turnsToUsefulAction: 1,
      mailMessagesFetched: 1,
      mailContextBytes: 480,
      sourcesExpanded: 2,
      staleFactsDiscovered: 1,
      oldTranscriptNeeded: false,
      successorSucceeded: true,
      thirdWorkerSucceeded: null,
    };
    const reduction = relayContextReduction(18_000, measurement);

    expect(measurement.workerIsolation).toBe("same_chat_protocol_replay");
    expect(reduction.savedBytes).toBe(17_520);
    expect(reduction.reductionRatio).toBeCloseTo(0.9733, 4);
  });

  test("rejects eye-confusing handles and inconsistent resolution state", () => {
    expect(() => renderMaterialMailMessage(thread("STN-HANDOFF:O0O0")))
      .toThrow("mail handle must be a canonical STN handle");
    expect(() => renderMaterialMailMessage(thread("handoff:q7mp")))
      .toThrow("mail handle must be a canonical STN handle");
    expect(() => renderMaterialMailMessage(thread("STN-HANDOFF:Q7MP", {
      state: "resolved",
      resolvedAt: null,
    }))).toThrow("resolved threads require resolvedAt");
  });
});
