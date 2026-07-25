import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { publicItemRuns } from "./lib/runVisibility";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-run-visibility-secret";
const workspace = "test";
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const alpha = { id: "alpha", name: "Alpha", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("item run visibility", () => {
  test("orders active runs first and caps retained history", () => {
    const runs = Array.from({ length: 24 }, (_, index) => rawRun(index, "succeeded"));
    runs.push(rawRun(100, "running"), rawRun(101, "waiting"));

    const visible = publicItemRuns(runs as any, "item_visible");

    expect(visible).toHaveLength(20);
    expect(visible.slice(0, 2).map((run) => run.status)).toEqual(["waiting", "running"]);
    expect(visible.every((run) => run.itemId === "item_visible")).toBe(true);
    expect(visible.some((run) => run.id === "run_0")).toBe(false);
  });

  test("projects execution metadata and terminal outcome through the dedicated query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      const t = convexTest(schema, modules);
      const item = await t.mutation(convexApi.items.create, {
        serviceSecret,
        workspace,
        project: "scrapbook",
        kind: "task",
        title: "Inspect agent runs",
        nextAction: "Watch the active run.",
        priority: 50,
        actor: leo,
      }) as any;

      const active = await t.mutation(convexApi.runs.start, {
        serviceSecret,
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
        serviceSecret,
        workspace,
        id: active.id,
        actorId: alpha.id,
        status: "waiting",
        childAgentCount: 2,
        toolCallCount: 14,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const finished = await t.mutation(convexApi.runs.start, {
        serviceSecret,
        workspace,
        itemId: item.id,
        actor: alpha,
        harness: "codex",
      }) as any;
      await vi.advanceTimersByTimeAsync(1_000);
      await t.mutation(convexApi.runs.finish, {
        serviceSecret,
        workspace,
        id: finished.id,
        actorId: alpha.id,
        status: "succeeded",
        outcome: "Completed the bounded projection.",
        childAgentCount: 0,
        toolCallCount: 3,
      });

      const runs = await t.query(convexApi.itemRuns.list, {
        serviceSecret,
        workspace,
        itemId: item.id,
        limit: 20,
      }) as any[];

      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({
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
      expect(runs[1]).toMatchObject({
        id: finished.id,
        itemId: item.id,
        status: "succeeded",
        outcome: "Completed the bounded projection.",
        childAgentCount: 0,
        toolCallCount: 3,
      });
      expect(runs[1].endedAt).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects limits outside the public retention boundary", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret,
      workspace,
      project: "scrapbook",
      kind: "task",
      title: "Validate run limits",
      nextAction: "Reject oversized projections.",
      priority: 50,
      actor: leo,
    }) as any;

    await expect(t.query(convexApi.itemRuns.list, {
      serviceSecret,
      workspace,
      itemId: item.id,
      limit: 21,
    })).rejects.toThrow("Item run limit must be between 1 and 20");
  });
});

function rawRun(index: number, status: "running" | "waiting" | "succeeded") {
  const startedAt = 1_000 + index * 100;
  const lastHeartbeatAt = startedAt + 50;
  return {
    _id: `internal_run_${index}`,
    _creationTime: startedAt,
    workspaceId: "internal_workspace",
    projectId: "internal_project",
    itemId: `internal_item_${index}`,
    externalId: `run_${index}`,
    actorId: "internal_actor",
    actorExternalId: `agent_${index}`,
    harness: "codex",
    status,
    startedAt,
    lastHeartbeatAt,
    ...(status === "succeeded"
      ? { endedAt: lastHeartbeatAt, outcome: `done ${index}` }
      : {}),
  };
}
