import { describe, expect, test } from "bun:test";
import {
  requireRunnerTransitionAuthority,
  runAuthorityFence,
  runnerAuthorityCommands,
} from "../src/authority-fence.ts";
import { ConflictError } from "../src/store.ts";

const liveRun = {
  id: "run_test",
  status: "running" as const,
  leaseOwnerId: "agent:runner",
  leaseGeneration: 7,
  leaseExpiresAt: "2026-07-25T16:00:00.000Z",
};

describe("authority fences", () => {
  test("projects a run lease as an explicit authority fence", () => {
    expect(runAuthorityFence(liveRun)).toEqual({
      resource: "run:run_test",
      holderId: "agent:runner",
      generation: 7,
      expiresAt: "2026-07-25T16:00:00.000Z",
    });
    expect(runAuthorityFence({
      ...liveRun,
      leaseOwnerId: null,
      leaseExpiresAt: null,
    })).toBeNull();
  });

  test("keeps authority acquisition and cancellation off the runner transition surface", () => {
    expect(runnerAuthorityCommands).not.toContain("retry");
    expect(runnerAuthorityCommands).not.toContain("cancel");
    expect(runnerAuthorityCommands).toEqual([
      "start",
      "run",
      "wait",
      "block",
      "resume",
      "succeed",
      "fail",
    ]);
  });

  test("requires server-owned reassignment after a run releases its lease", () => {
    const blocked = { status: "blocked" as const };
    for (const command of ["resume", "succeed", "fail"] as const) {
      expect(() => requireRunnerTransitionAuthority(blocked, command))
        .toThrow(ConflictError);
      expect(() => requireRunnerTransitionAuthority(blocked, command))
        .toThrow("server-owned scheduling must reassign it");
    }

    expect(() => requireRunnerTransitionAuthority(blocked, "block")).not.toThrow();
    expect(() => requireRunnerTransitionAuthority({ status: "waiting" }, "resume")).not.toThrow();
    expect(() => requireRunnerTransitionAuthority({ status: "running" }, "succeed")).not.toThrow();
  });
});
