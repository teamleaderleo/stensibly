import { describe, expect, test } from "bun:test";
import { readProviderCapacity } from "../site/provider-capacity.js";

const scope = {
  repository: "teamleaderleo/stensibly",
  subjectLogin: "teamleaderleo",
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    capacity: {
      provider: "coderabbit",
      repository: scope.repository,
      subjectLogin: scope.subjectLogin,
      subjectBasis: "pull_request_author_proxy",
      state: "available",
      reason: null,
      remaining: null,
      limit: null,
      observedAt: "2026-07-29T15:00:00.000Z",
      receivedAt: "2026-07-29T15:00:01.000Z",
      staleAt: "2026-07-29T15:05:00.000Z",
      refillAt: null,
      nextAvailableAt: null,
      source: { pullRequestNumber: 439, commentId: "5110000000" },
      ...overrides,
    },
  };
}

describe("dashboard provider capacity receipt boundary", () => {
  test("rejects available or unavailable evidence received at or after expiry", () => {
    expect(() => readProviderCapacity(response({
      receivedAt: "2026-07-29T15:05:00.000Z",
    }), scope)).toThrow("receipt must precede its stale boundary");

    expect(() => readProviderCapacity(response({
      state: "unavailable",
      reason: "quota_exhausted",
      remaining: 0,
      limit: 1,
      receivedAt: "2026-07-29T16:00:00.000Z",
      staleAt: "2026-07-29T16:00:00.000Z",
      refillAt: "2026-07-29T16:00:00.000Z",
      nextAvailableAt: "2026-07-29T16:00:00.000Z",
    }), scope)).toThrow("receipt must precede its stale boundary");
  });

  test("keeps delayed evidence representable through explicit unknown states", () => {
    expect(readProviderCapacity(response({
      state: "unknown",
      reason: "observation_stale",
      receivedAt: "2026-07-29T15:10:00.000Z",
    }), scope)).toMatchObject({
      state: "unknown",
      reason: "observation_stale",
    });

    expect(readProviderCapacity(response({
      state: "unknown",
      reason: "refill_window_elapsed",
      receivedAt: "2026-07-29T16:10:00.000Z",
      staleAt: "2026-07-29T16:00:00.000Z",
      refillAt: "2026-07-29T16:00:00.000Z",
    }), scope)).toMatchObject({
      state: "unknown",
      reason: "refill_window_elapsed",
      nextAvailableAt: null,
    });
  });
});
