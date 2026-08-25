import { describe, expect, test } from "bun:test";
import type {
  CodexAppServerConnection,
  CodexAppServerNotification,
} from "../src/codex-app-server-client.js";
import {
  CODEX_APP_SERVER_ADAPTER_ID,
  CodexRootHarness,
  codexChildSlotBackpressureV1,
  codexRootMissionRevision,
  codexRootProfileVersion,
  type CodexRootMissionV1,
  type CodexRootProfileV1,
} from "../src/codex-root-harness.js";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance.js";

interface FakeThread {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
}

interface FakeGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

interface FakeCall {
  readonly connection: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

class FakeCodexBackend {
  nextThread = 1;
  nextTurn = 1;
  terminalGoalBeforeTurnSettlement = false;
  readonly threads = new Map<string, FakeThread>();
  readonly goals = new Map<string, FakeGoal>();
  readonly turns = new Map<string, Array<Record<string, unknown>>>();
  readonly calls: FakeCall[] = [];
}

class FakeCodexConnection implements CodexAppServerConnection {
  readonly #backend: FakeCodexBackend;
  readonly #name: string;
  readonly #notifications: CodexAppServerNotification[] = [];
  #sequence = 0;

  constructor(backend: FakeCodexBackend, name: string) {
    this.#backend = backend;
    this.#name = name;
  }

  async request<Result>(method: string, paramsValue: unknown): Promise<Result> {
    const params = paramsValue as Record<string, unknown>;
    this.#backend.calls.push({ connection: this.#name, method, params });
    if (method === "thread/start") {
      const id = `0198f00d-0000-7000-8000-${String(this.#backend.nextThread++).padStart(12, "0")}`;
      const thread: FakeThread = {
        id,
        sessionId: id,
        cwd: String(params.cwd),
        model: String(params.model),
      };
      this.#backend.threads.set(id, thread);
      return this.#threadResponse(thread) as Result;
    }
    if (method === "thread/resume") {
      const thread = this.#thread(String(params.threadId));
      return this.#threadResponse(thread) as Result;
    }
    if (method === "thread/goal/set") {
      const threadId = String(params.threadId);
      this.#thread(threadId);
      const prior = this.#backend.goals.get(threadId);
      const activatesTerminalGoal = prior !== undefined
        && prior.status !== "active"
        && params.status === "active";
      const goal: FakeGoal = {
        threadId,
        objective: params.objective === undefined ? (prior?.objective ?? "") : String(params.objective),
        status: params.status === undefined ? (prior?.status ?? "paused") : String(params.status),
        tokenBudget: params.tokenBudget === undefined
          ? (prior?.tokenBudget ?? null)
          : params.tokenBudget === null ? null : Number(params.tokenBudget),
        tokensUsed: prior?.tokensUsed ?? 0,
        timeUsedSeconds: prior?.timeUsedSeconds ?? 0,
        createdAt: prior?.createdAt ?? 1,
        updatedAt: (prior?.updatedAt ?? 0) + 1,
      };
      this.#backend.goals.set(threadId, goal);
      if (activatesTerminalGoal) {
        const turnId = `runtime-turn-${this.#backend.nextTurn++}`;
        queueMicrotask(() => this.#emit("turn/started", {
          threadId,
          turn: { id: turnId, status: "inProgress", items: [], error: null },
        }));
      }
      return { goal: structuredClone(goal) } as Result;
    }
    if (method === "thread/goal/get") {
      const goal = this.#backend.goals.get(String(params.threadId));
      return { goal: goal ? structuredClone(goal) : null } as Result;
    }
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      this.#thread(threadId);
      const turnNumber = this.#backend.nextTurn++;
      const turnId = `runtime-turn-${turnNumber}`;
      queueMicrotask(() => this.#completeTurn(threadId, turnId));
      return { turn: { id: `orchestration-turn-${turnNumber}`, status: "inProgress" } } as Result;
    }
    if (method === "thread/settings/update") return {} as Result;
    if (method === "turn/steer") {
      const threadId = String(params.threadId);
      const turnId = String(params.expectedTurnId);
      queueMicrotask(() => this.#completeTurn(threadId, turnId));
      return { turnId } as Result;
    }
    if (method === "thread/turns/list") {
      return { data: structuredClone(this.#backend.turns.get(String(params.threadId)) ?? []) } as Result;
    }
    throw new Error(`Unexpected fake Codex method: ${method}`);
  }

  notificationCursor(): number {
    return this.#sequence;
  }

  notificationsSince(cursor: number): readonly CodexAppServerNotification[] {
    return this.#notifications.filter((notification) => notification.sequence > cursor);
  }

  async waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    afterCursor: number,
  ): Promise<CodexAppServerNotification> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = this.#notifications.find((notification) =>
        notification.sequence > afterCursor
        && notification.method === method
        && predicate(notification.params)
      );
      if (found) return found;
      await Promise.resolve();
    }
    throw new Error(`Fake notification not observed: ${method}`);
  }

  async close(): Promise<void> {}

  #thread(threadId: string): FakeThread {
    const thread = this.#backend.threads.get(threadId);
    if (!thread) throw new Error(`Unknown fake thread: ${threadId}`);
    return thread;
  }

  #threadResponse(thread: FakeThread): Record<string, unknown> {
    return {
      thread: {
        id: thread.id,
        sessionId: thread.sessionId,
        forkedFromId: null,
        parentThreadId: null,
      },
      model: thread.model,
      modelProvider: "openai",
      reasoningEffort: "high",
      cwd: thread.cwd,
    };
  }

  #emit(method: string, params: unknown): void {
    this.#notifications.push(Object.freeze({ sequence: ++this.#sequence, method, params }));
  }

  #completeTurn(threadId: string, turnId: string): void {
    const turn = { id: turnId, status: "completed", items: [], error: null };
    const goal = this.#backend.goals.get(threadId);
    if (goal) {
      goal.tokensUsed += 23;
      goal.timeUsedSeconds += 1;
      goal.updatedAt += 1;
      goal.status = "complete";
    }
    this.#backend.turns.set(threadId, [turn, ...(this.#backend.turns.get(threadId) ?? [])]);
    this.#emit("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        total: {
          totalTokens: 23,
          inputTokens: 15,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          outputTokens: 8,
          reasoningOutputTokens: 3,
        },
        last: {
          totalTokens: 23,
          inputTokens: 15,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          outputTokens: 8,
          reasoningOutputTokens: 3,
        },
        modelContextWindow: 200_000,
      },
    });
    const emitCompleted = () => this.#emit("turn/completed", { threadId, turn });
    const emitTerminalGoal = () => this.#emit("thread/goal/updated", {
      threadId,
      turnId,
      goal: structuredClone(goal),
    });
    if (this.#backend.terminalGoalBeforeTurnSettlement) {
      emitTerminalGoal();
      queueMicrotask(emitCompleted);
    } else {
      emitCompleted();
      emitTerminalGoal();
    }
  }
}

function mission(name: string, brief = `Execute current brief for ${name}.`): CodexRootMissionV1 {
  const objective = `Complete durable mission ${name}`;
  return {
    version: 1,
    missionRef: `github:teamleaderleo/stensibly#${name}`,
    responsibilityGeneration: 1,
    revisionDigest: codexRootMissionRevision({ name, objective }),
    objective,
    launchBrief: brief,
  };
}

function profile(cwd: string, model = "gpt-5.6-sol", goalTokenBudget = 20_000): CodexRootProfileV1 {
  const effort = "high" as const;
  const sandbox = "read-only" as const;
  const approvalPolicy = "never" as const;
  return {
    version: 1,
    provenance: runnerProfileProvenanceV1(
      `codex-root:${model}`,
      codexRootProfileVersion({
        model,
        effort,
        sandbox,
        networkAccess: false,
        approvalPolicy,
        cwd,
        appServerVersion: "0.146.0",
      }),
    ),
    model,
    effort,
    cwd,
    sandbox,
    networkAccess: false,
    approvalPolicy,
    goalTokenBudget,
  };
}

describe("Codex root harness", () => {
  test("starts two independent mission roots and continues one without touching its peer", async () => {
    const backend = new FakeCodexBackend();
    const connection = new FakeCodexConnection(backend, "controller-1");
    const harness = new CodexRootHarness(connection, {
      clock: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const missionA = mission("1695-a");
    const missionB = mission("1695-b");
    const [rootA, rootB] = await Promise.all([
      harness.start(missionA, profile("/tmp/codex-root-a")),
      harness.start(missionB, profile("/tmp/codex-root-b", "gpt-5.6-luna")),
    ]);

    expect(rootA.binding.runtime.threadId).not.toBe(rootB.binding.runtime.threadId);
    expect(rootA.binding.runtime.sessionId).toBe(rootA.binding.runtime.threadId);
    expect(rootB.binding.runtime.sessionId).toBe(rootB.binding.runtime.threadId);
    expect(rootA.binding.rootRef.adapterId).toBe(CODEX_APP_SERVER_ADAPTER_ID);
    expect(rootA.binding.rootRef.containsPrivateContent).toBeFalse();
    expect(rootA.binding.rootRef.containsCredentials).toBeFalse();
    expect(rootA.observation.goal.objectiveDigest).toBe(rootA.binding.objectiveDigest);
    expect(rootA.observation.tokenUsage?.totalTokens).toBe(23);

    const peerCallsBefore = backend.calls.filter((call) =>
      call.params.threadId === rootB.binding.runtime.threadId
    ).length;
    const continued = await harness.continue(rootA.binding, {
      ...missionA,
      launchBrief: "Continue A from durable mission truth.",
    }, profile("/tmp/codex-root-a"));

    expect(continued.observation.disposition).toBe("hot_continuation");
    expect(continued.binding.runtime.threadId).toBe(rootA.binding.runtime.threadId);
    expect(backend.calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
    expect(backend.calls.filter((call) =>
      call.params.threadId === rootB.binding.runtime.threadId
    )).toHaveLength(peerCallsBefore);
  });

  test("reconstructs the controller, reconciles a stale goal, and resumes the same root", async () => {
    const backend = new FakeCodexBackend();
    const first = new CodexRootHarness(new FakeCodexConnection(backend, "before-restart"));
    const durableMission = mission("1695-restart");
    const durableProfile = profile("/tmp/codex-root-restart");
    const started = await first.start(durableMission, durableProfile);
    const goal = backend.goals.get(started.binding.runtime.threadId)!;
    goal.objective = "stale private runtime goal";
    goal.status = "blocked";

    const reconstructed = new CodexRootHarness(new FakeCodexConnection(backend, "after-restart"));
    const resumed = await reconstructed.continue(started.binding, {
      ...durableMission,
      launchBrief: "Resume only from this current durable brief.",
    }, durableProfile);

    expect(resumed.observation.disposition).toBe("resumed_after_controller_restart");
    expect(resumed.binding.runtime.threadId).toBe(started.binding.runtime.threadId);
    expect(resumed.observation.goal.reconciled).toBeTrue();
    expect(resumed.observation.goal.objectiveDigest).toBe(started.binding.objectiveDigest);
    expect(backend.calls.filter((call) =>
      call.connection === "after-restart" && call.method === "thread/resume"
    )).toHaveLength(1);
    expect(backend.goals.get(started.binding.runtime.threadId)?.objective).toBe(durableMission.objective);
  });

  test("uses a fresh independent successor when mission or profile truth changes", async () => {
    const backend = new FakeCodexBackend();
    const connection = new FakeCodexConnection(backend, "controller");
    const harness = new CodexRootHarness(connection);
    const oldPrivateTranscript = "DO-NOT-COPY-OLD-TRANSCRIPT";
    const initialMission = mission("1695-rollover", oldPrivateTranscript);
    const initial = await harness.start(initialMission, profile("/tmp/codex-root-rollover"));
    const currentBrief = "Execute successor from this self-contained current handoff.";
    const changedMission: CodexRootMissionV1 = {
      ...mission("1695-rollover", currentBrief),
      responsibilityGeneration: 2,
      revisionDigest: codexRootMissionRevision({ generation: 2, currentBrief }),
    };
    const before = backend.calls.length;
    const successor = await harness.continue(
      initial.binding,
      changedMission,
      profile("/tmp/codex-root-rollover", "gpt-5.6-luna"),
    );
    const successorCalls = backend.calls.slice(before);

    expect(successor.observation.disposition).toBe("fresh_successor_root");
    expect(successor.binding.runtime.threadId).not.toBe(initial.binding.runtime.threadId);
    expect(successor.binding.runtime.sessionId).toBe(successor.binding.runtime.threadId);
    expect(successor.binding.predecessorRootRef?.externalId).toBe(initial.binding.runtime.threadId);
    expect(successorCalls.some((call) => call.method === "thread/start")).toBeTrue();
    expect(successorCalls.some((call) => call.method === "thread/fork")).toBeFalse();
    expect(successorCalls.some((call) => call.method === "thread/resume")).toBeFalse();
    const turnStart = successorCalls.find((call) => call.method === "turn/start")!;
    expect(JSON.stringify(turnStart.params)).toContain(currentBrief);
    expect(JSON.stringify(turnStart.params)).not.toContain(oldPrivateTranscript);
    expect(backend.goals.get(initial.binding.runtime.threadId)?.objective).toBe(initialMission.objective);
  });

  test("carries the exact workspace root into a workspace-write turn", async () => {
    const backend = new FakeCodexBackend();
    const connection = new FakeCodexConnection(backend, "workspace-write");
    const cwd = "/tmp/codex-root-writable";
    const writableProfile: CodexRootProfileV1 = {
      ...profile(cwd),
      sandbox: "workspace-write",
    };
    await new CodexRootHarness(connection).start(mission("1695-writable"), writableProfile);
    const turnStart = backend.calls.find((call) => call.method === "turn/start")!;
    expect(turnStart.params.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  test("models loopback-capable network access independently from filesystem authority", async () => {
    const backend = new FakeCodexBackend();
    const connection = new FakeCodexConnection(backend, "network-readonly");
    const cwd = "/tmp/codex-root-network-readonly";
    const base = profile(cwd);
    const networkProfile: CodexRootProfileV1 = {
      ...base,
      provenance: runnerProfileProvenanceV1(
        base.provenance.profileId,
        codexRootProfileVersion({
          model: base.model,
          effort: base.effort,
          sandbox: "read-only",
          networkAccess: true,
          approvalPolicy: base.approvalPolicy,
          cwd,
          appServerVersion: "0.146.0",
        }),
      ),
      networkAccess: true,
    };
    const result = await new CodexRootHarness(connection).start(
      mission("1695-loopback"),
      networkProfile,
    );
    const turnStart = backend.calls.find((call) => call.method === "turn/start")!;
    expect(turnStart.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: true });
    expect(result.observation.sandbox).toBe("read-only");
    expect(result.observation.networkAccess).toBeTrue();
    expect(networkProfile.provenance.profileVersion).not.toBe(base.provenance.profileVersion);
  });

  test("waits for runtime turn settlement after the goal becomes terminal", async () => {
    const backend = new FakeCodexBackend();
    backend.terminalGoalBeforeTurnSettlement = true;
    const harness = new CodexRootHarness(new FakeCodexConnection(backend, "goal-first"));
    const result = await harness.start(
      mission("1695-settlement"),
      profile("/tmp/codex-root-settlement"),
    );

    expect(result.observation.turnId).toStartWith("runtime-turn-");
    expect(result.observation.turnStatus).toBe("completed");
    const methods = backend.calls.map((call) => call.method);
    expect(methods).not.toContain("turn/interrupt");
  });

  test("refuses an exhausted cumulative goal budget and resumes only after an explicit increase", async () => {
    const backend = new FakeCodexBackend();
    const durableMission = mission("1695-budget");
    const cwd = "/tmp/codex-root-budget";
    const first = new CodexRootHarness(new FakeCodexConnection(backend, "budget-start"));
    const started = await first.start(durableMission, profile(cwd));
    const goal = backend.goals.get(started.binding.runtime.threadId)!;
    goal.status = "budgetLimited";
    goal.tokensUsed = 25_000;
    const turnsBefore = backend.calls.filter((call) => call.method === "turn/start").length;

    const exhausted = new CodexRootHarness(new FakeCodexConnection(backend, "budget-exhausted"));
    await expect(exhausted.continue(started.binding, durableMission, profile(cwd)))
      .rejects.toThrow("durable goalTokenBudget must increase");
    expect(backend.calls.filter((call) => call.method === "turn/start")).toHaveLength(turnsBefore);

    const increased = new CodexRootHarness(new FakeCodexConnection(backend, "budget-increased"));
    const resumed = await increased.continue(
      started.binding,
      durableMission,
      profile(cwd, "gpt-5.6-sol", 40_000),
    );
    expect(resumed.observation.disposition).toBe("resumed_after_controller_restart");
    expect(resumed.binding.runtime.threadId).toBe(started.binding.runtime.threadId);
    expect(resumed.binding.goalTokenBudget).toBe(40_000);
  });

  test("rejects a native child or fork in place of an independent root", async () => {
    const backend = new FakeCodexBackend();
    class ChildConnection extends FakeCodexConnection {
      override async request<Result>(method: string, params: unknown): Promise<Result> {
        const result = await super.request<Record<string, unknown>>(method, params);
        if (method === "thread/start") {
          const thread = result.thread as Record<string, unknown>;
          thread.parentThreadId = "parent-thread";
        }
        return result as Result;
      }
    }
    const harness = new CodexRootHarness(new ChildConnection(backend, "child"));
    await expect(harness.start(mission("1695-child"), profile("/tmp/codex-root-child")))
      .rejects.toThrow("not an independent root session");
  });

  test("classifies native child-slot exhaustion as local backpressure without creating work", () => {
    const backend = new FakeCodexBackend();
    const before = backend.calls.length;
    const observation = codexChildSlotBackpressureV1({
      threadId: "0198f00d-0000-7000-8000-000000000001",
      turnId: "runtime-turn-7",
      error: new Error("maximum concurrent agent threads reached for this session"),
    });

    expect(observation).toEqual({
      version: 1,
      kind: "native_child_slot_capacity",
      scope: "codex_session_tree",
      retryable: true,
      threadId: "0198f00d-0000-7000-8000-000000000001",
      turnId: "runtime-turn-7",
      detailDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(observation)).not.toContain("maximum concurrent");
    expect(backend.calls).toHaveLength(before);
    expect(codexChildSlotBackpressureV1({
      threadId: "0198f00d-0000-7000-8000-000000000001",
      error: new Error("model response failed"),
    })).toBeNull();
  });
});
