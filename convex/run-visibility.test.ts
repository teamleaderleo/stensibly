import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { publicItemRuns } from "./lib/runVisibility";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const alpha = { id: "alpha", name: "Alpha", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("item run visibility", () => {
  test("orders active runs first and caps retained history", () => {
    const runs = Array.from({ length: 24 }, (_, index) => rawRun(index, "succeeded"));
    runs.push(rawRun(100, "running"), rawRun(101, "waiting"));
    const visible = publicItemRuns(runs, "item_visible");

    expect(visible).toHaveLength(20);
    expect(visible.slice(0, 2).map((run) => run.status)).toEqual(["waiting", "running"]);
    expect(visible.every((run) => run.itemId === "item_visible")).toBe(true);
    expect(visible.some((run) => run.id === "run_0")).toBe(false);
  });

  test("projects heartbeat, counters, context, and terminal outcome through item detail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      const t = convexTest(schema, modules);
      const item = await t.mutation(convexApi.items.create, {
        serviceSecret: secret,
        workspace,
        project: "scrapbook",
        kind: "task",
        title: "Inspect agent runs",
        nextAction: "Watch the active run.",
        priority: 50,
        actor: leo,
      }) as any;

      const active = await t.mutation(convexApi.runs.start, {
        serviceSecret: secret,
        workspace,
        itemId: item.id,
        actor: alpha,
        harness: "codex",
        model: "gpt-5.6",
        externalRunId: "external-active",
        repository: "teamleaderleo/stensibly",
        branch: "feat/run-visibility",
        worktree: "/tmp/run-active",
      }) as any;
      await vi.advanceTimersByTimeAsync(1_000);
      await t.mutation(convexApi.runs.heartbeat, {
        serviceSecret: secret,
        workspace,
        id: active.id,
        actorId: alpha.id,
        status: "waiting",
        childAgentCount: 2,
        toolCallCount: 14,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const finished = await t.mutation(convexApi.runs.start, {
        serviceSecret: secret,
        workspace,
        itemId: item.id,
        actor: alpha,
        harness: "codex",
      }) as any;
      await vi.advanceTimersByTimeAsync(1_000);
      await t.mutation(convexApi.runs.finish, {
        serviceSecret: secret,
        workspace,
        id: finished.id,
        actorId: alpha.id,
        status: "succeeded",
        outcome: "Completed the bounded projection.",
        childAgentCount: 0,
        toolCallCount: 3,
      });

      const detail = await t.query(convexApi.items.get, {
        serviceSecret: secret,
        workspace,
        id: item.id,
      }) as any;
      expect(detail.runs).toHaveLength(2);
      expect(detail.runs[0]).toMatchObject({
        id: active.id,
        itemId: item.id,
        actorId: alpha.id,
        harness: "codex",
        model: "gpt-5.6",
        externalRunId: "external-active",
        repository: "teamleaderleo/stensibly",
        branch: "feat/run-visibility",
        worktree: "/tmp/run-active",
        status: "waiting",
        childAgentCount: 2,
        toolCallCount: 14,
        endedAt: null,
      });
      expect(detail.runs[1]).toMatchObject({
        id: finished.id,
        status: "succeeded",
        outcome: "Completed the bounded projection.",
        childAgentCount: 0,
        toolCallCount: 3,
      });
      expect(detail.runs[1].endedAt).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

function rawRun(index: number, status: "running" | "waiting" | "succeeded") {
  const startedAt = 1_000 + index * 100;
  const lastHeartbeatAt = startedAt + 50;
  return {
    externalId: `run_${index}`,
    itemId: `internal_item_${index}`,
    actorExternalId: `agent_${index}`,
    harness: "codex",
    status,
    startedAt,
    lastHeartbeatAt,
    ...(status === "succeeded" ? { endedAt: lastHeartbeatAt, outcome: `done ${index}` } : {}),
  };
}
