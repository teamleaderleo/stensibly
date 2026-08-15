import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  compileWorkSelectionRecommendation,
  verifyWorkSelectionRecommendation,
} from "../src/work-selection-claim.ts";

const sourceFingerprint = fingerprintCanonicalRequest({
  github: "teamleaderleo/stensibly#1525",
  revision: "head-1",
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_claim_race",
    project: "stensibly",
    status: "ready" as const,
    version: 7,
    claimGeneration: 4,
    priority: 90,
    nextAction: "Take one bounded claim-race fixture.",
    ...overrides,
  };
}

describe("broad mail work recommendation", () => {
  test("binds exact current work while granting zero responsibility and zero authority", () => {
    const recommendation = compileWorkSelectionRecommendation({
      selectedHandle: "STN-HANDOFF:M7QK",
      item: item(),
      sourceFingerprint,
    });

    expect(recommendation).toMatchObject({
      itemId: "item_claim_race",
      itemVersion: 7,
      claimGeneration: 4,
      grantsResponsibility: false,
      grantsAuthority: false,
    });
    expect(recommendation.workFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(recommendation.recommendationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyWorkSelectionRecommendation(recommendation)).toEqual(recommendation);
  });

  test("rejects non-ready work and invalid review-independence metadata", () => {
    expect(() => compileWorkSelectionRecommendation({
      selectedHandle: "STN-HANDOFF:M7QK",
      item: item({ status: "active" }) as any,
      sourceFingerprint,
    })).toThrow("only ready work");

    expect(() => compileWorkSelectionRecommendation({
      selectedHandle: "STN-REVIEW:R7MK",
      item: item(),
      sourceFingerprint,
      responsibilityRole: "independent_review",
    })).toThrow("requires an independence key");
  });

  test("detects altered recommendation bytes", () => {
    const recommendation = compileWorkSelectionRecommendation({
      selectedHandle: "STN-REVIEW:R7MK",
      item: item(),
      sourceFingerprint,
      responsibilityRole: "independent_review",
      independenceKey: "github:teamleaderleo/stensibly:pr:1487:head:abc",
    });

    expect(() => verifyWorkSelectionRecommendation({
      ...recommendation,
      itemVersion: recommendation.itemVersion + 1,
    })).toThrow("recommendation fingerprint");
  });
});
