import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  describeProviderCapacity,
  readProviderCapacity,
  validateProviderCapacityScope,
} from "../site/provider-capacity.js";

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
      observedAt: "2026-07-28T13:00:00.000Z",
      receivedAt: "2026-07-28T13:00:01.000Z",
      staleAt: "2026-07-28T13:05:00.000Z",
      refillAt: null,
      nextAvailableAt: null,
      source: { pullRequestNumber: 421, commentId: "5104466293" },
      ...overrides,
    },
  };
}

function unobservedResponse(overrides: Record<string, unknown> = {}) {
  return response({
    state: "unknown",
    reason: "not_observed",
    remaining: null,
    limit: null,
    observedAt: null,
    receivedAt: null,
    staleAt: null,
    refillAt: null,
    nextAvailableAt: null,
    source: null,
    ...overrides,
  });
}

describe("dashboard provider capacity reader", () => {
  test("preserves status-only availability and its explicit scope", () => {
    const value = readProviderCapacity(response(), scope);
    expect(value).toMatchObject({
      state: "available",
      remaining: null,
      subjectBasis: "pull_request_author_proxy",
    });
    expect(describeProviderCapacity(value, Date.parse("2026-07-28T13:02:00.000Z")))
      .toMatchObject({
        statusLabel: "available",
        scope: "teamleaderleo/stensibly · teamleaderleo · PR-author proxy",
        sourceHref: "https://github.com/teamleaderleo/stensibly/pull/421#issuecomment-5104466293",
      });
  });

  test("accepts a bounded bot pull-request author proxy", () => {
    const botScope = validateProviderCapacityScope({
      repository: "teamleaderleo/stensibly",
      subjectLogin: "dependabot[bot]",
    });
    expect(readProviderCapacity(response({ subjectLogin: "dependabot[bot]" }), botScope))
      .toMatchObject({
        subjectLogin: "dependabot[bot]",
        subjectBasis: "pull_request_author_proxy",
      });
  });

  test("renders counted exhaustion and stale observations without upgrading them", () => {
    const unavailable = readProviderCapacity(response({
      state: "unavailable",
      reason: "quota_exhausted",
      remaining: 0,
      limit: 1,
      staleAt: "2026-07-28T14:00:00.000Z",
      refillAt: "2026-07-28T14:00:00.000Z",
      nextAvailableAt: "2026-07-28T14:00:00.000Z",
    }), scope);
    expect(describeProviderCapacity(unavailable).quota).toBe("0 of 1 review remaining.");

    const unknown = readProviderCapacity(response({
      state: "unknown",
      reason: "observation_stale",
    }), scope);
    expect(unknown.state).toBe("unknown");
    expect(describeProviderCapacity(unknown).timing).toContain("expired");

    expect(readProviderCapacity(unobservedResponse(), scope)).toMatchObject({
      state: "unknown",
      reason: "not_observed",
      remaining: null,
      source: null,
    });
  });

  test("rejects mismatched scope, unsafe identifiers, and contradictory evidence", () => {
    expect(() => validateProviderCapacityScope({
      repository: "teamleaderleo/stensibly\u202e",
      subjectLogin: "teamleaderleo",
    })).toThrow("Repository is invalid");
    expect(() => readProviderCapacity(response({ repository: "other/repo" }), scope))
      .toThrow("does not match");
    expect(() => readProviderCapacity(response({ remaining: 0, limit: 1 }), scope))
      .toThrow("Available capacity cannot report zero");
    expect(() => readProviderCapacity(unobservedResponse({ remaining: 1, limit: 1 }), scope))
      .toThrow("must not claim provider evidence");
    expect(() => readProviderCapacity(response({
      state: "unknown",
      reason: "observation_stale",
      nextAvailableAt: "2026-07-28T14:00:00.000Z",
    }), scope)).toThrow("must not claim a next available time");
    expect(() => readProviderCapacity(response({
      state: "unknown",
      reason: "refill_window_elapsed",
      refillAt: null,
    }), scope)).toThrow("requires the prior refill evidence");
    expect(() => readProviderCapacity(response({
      staleAt: "2026-07-28T13:00:00.000Z",
    }), scope)).toThrow("timing is inconsistent");
    expect(() => readProviderCapacity(response({
      staleAt: "2026-07-28T13:05:00.000Z",
      refillAt: "2026-07-28T13:04:00.000Z",
    }), scope)).toThrow("refill timing is inconsistent");
  });
});

describe("dashboard provider capacity wiring", () => {
  test("installs one scoped read-only card through the pre-app bridge", async () => {
    const [bridge, entry, controller, css] = await Promise.all([
      readFile("site/hosted-session-bridge.js", "utf8"),
      readFile("site/provider-capacity-entry.js", "utf8"),
      readFile("site/provider-capacity-controller.js", "utf8"),
      readFile("site/provider-capacity.css", "utf8"),
    ]);
    expect(bridge).toContain("installProviderCapacityCard()");
    expect(entry).toContain('id=\"provider-capacity-panel\"');
    expect(entry).toContain('name=\"repository\"');
    expect(entry).toContain('name=\"subject\"');
    expect(entry).toContain("MutationObserver");
    expect(entry).toContain("/provider-capacity.css");
    expect(controller).toContain("/api/v1/provider-capacities/coderabbit?");
    expect(controller).toContain("localStorage.setItem(STORAGE_KEY");
    expect(controller).not.toContain("@coderabbitai");
    expect(css).toContain('.provider-capacity[data-state="unavailable"]');
  });
});
