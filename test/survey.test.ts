import { describe, expect, test } from "bun:test";
import { buildWorkspaceSurvey } from "../src/survey.ts";
import type { Item } from "../src/store.ts";

const baseTime = new Date("2026-07-25T12:00:00.000Z");

describe("workspace survey", () => {
  test("summarizes dispatch candidates, blockers, and lease urgency", () => {
    const survey = buildWorkspaceSurvey([
      item({ id: "ready-low", project: "renderprove", status: "ready", priority: 40 }),
      item({ id: "ready-high", project: "smolrunner", status: "ready", priority: 90 }),
      item({
        id: "active-expiring",
        project: "stensibly",
        status: "active",
        priority: 70,
        claimedBy: "chat-1",
        claimExpiresAt: "2026-07-25T12:05:00.000Z",
      }),
      item({
        id: "active-expired",
        project: "smolrunner",
        status: "active",
        priority: 80,
        claimedBy: "chat-2",
        claimExpiresAt: "2026-07-25T11:59:00.000Z",
      }),
      item({ id: "blocked", project: "stensibly", status: "blocked", priority: 60 }),
      item({ id: "done", project: "renderprove", status: "done", priority: 50 }),
    ], {
      now: baseTime,
      limit: 10,
      expiringWithinSeconds: 900,
    });

    expect(survey.counts).toEqual({
      total: 6,
      ready: 2,
      active: 2,
      blocked: 1,
      done: 1,
      archived: 0,
    });
    expect(survey.dispatchCandidates.map((entry) => entry.id)).toEqual([
      "ready-high",
      "ready-low",
    ]);
    expect(survey.attention.expiredClaims.map((entry) => entry.id)).toEqual([
      "active-expired",
    ]);
    expect(survey.attention.expiringClaims.map((entry) => entry.id)).toEqual([
      "active-expiring",
    ]);
    expect(survey.attention.urgent).toBe(true);
    expect(survey.notifyRecommended).toBe(true);
    expect(survey.projects.map((entry) => entry.project)).toEqual([
      "renderprove",
      "smolrunner",
      "stensibly",
    ]);
  });

  test("keeps fingerprints stable between checks until material urgency changes", () => {
    const items = [item({
      id: "active",
      project: "stensibly",
      status: "active",
      claimedBy: "chat-1",
      claimExpiresAt: "2026-07-25T12:30:00.000Z",
    })];

    const first = buildWorkspaceSurvey(items, {
      now: baseTime,
      expiringWithinSeconds: 900,
    });
    const unchanged = buildWorkspaceSurvey(items, {
      now: new Date("2026-07-25T12:00:30.000Z"),
      expiringWithinSeconds: 900,
      previousFingerprint: first.fingerprint,
    });
    expect(unchanged.fingerprint).toBe(first.fingerprint);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.notifyRecommended).toBe(false);

    const expiring = buildWorkspaceSurvey(items, {
      now: new Date("2026-07-25T12:20:00.000Z"),
      expiringWithinSeconds: 900,
      previousFingerprint: first.fingerprint,
    });
    expect(expiring.fingerprint).not.toBe(first.fingerprint);
    expect(expiring.changed).toBe(true);
    expect(expiring.attention.expiringClaims).toHaveLength(1);
    expect(expiring.notifyRecommended).toBe(true);
  });

  test("can restrict a survey to one project", () => {
    const survey = buildWorkspaceSurvey([
      item({ id: "one", project: "smolrunner", status: "ready" }),
      item({ id: "two", project: "renderprove", status: "blocked" }),
    ], {
      project: "smolrunner",
      now: baseTime,
    });

    expect(survey.scope.project).toBe("smolrunner");
    expect(survey.counts.total).toBe(1);
    expect(survey.projects.map((entry) => entry.project)).toEqual(["smolrunner"]);
    expect(survey.dispatchCandidates.map((entry) => entry.id)).toEqual(["one"]);
  });
});

function item(overrides: Partial<Item> & Pick<Item, "id" | "project" | "status">): Item {
  return {
    id: overrides.id,
    project: overrides.project,
    kind: overrides.kind ?? "task",
    title: overrides.title ?? overrides.id,
    summary: overrides.summary ?? null,
    status: overrides.status,
    priority: overrides.priority ?? 50,
    nextAction: overrides.nextAction ?? "Continue the work.",
    claimedBy: overrides.claimedBy ?? null,
    claimExpiresAt: overrides.claimExpiresAt ?? null,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? "2026-07-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-25T11:00:00.000Z",
  };
}
