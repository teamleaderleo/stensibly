import { describe, expect, test } from "bun:test";
import type {
  CodexAppServerConnection,
  CodexAppServerNotification,
} from "../src/codex-app-server-client.js";
import {
  CODEX_QUEUE_COMMAND_V1,
  codexQueueArgvV1,
  compileCompletionCallbackV1,
  completionCallbackFromAgyResultEventV1,
  completionCallbackMessageV1,
  deliverCompletionCallbackViaQueueV1,
  deliverCompletionCallbackV1,
  type CompletionCallbackReceiptV1,
} from "../src/completion-callback.js";

interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

class FakeConnection implements CodexAppServerConnection {
  readonly calls: RecordedCall[] = [];
  failResume = false;
  nextThread = 1;
  nextTurn = 1;

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.calls.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/start") {
      const id = `thread-${this.nextThread++}`;
      return { thread: { id, sessionId: id } } as Result;
    }
    if (method === "thread/resume") {
      if (this.failResume) throw new Error("Codex thread not found");
      const threadId = String((params as Record<string, unknown>).threadId);
      return { thread: { id: threadId, sessionId: threadId } } as Result;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}`, status: "inProgress" } } as Result;
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  notificationCursor(): number {
    return 0;
  }

  notificationsSince(): readonly CodexAppServerNotification[] {
    return [];
  }

  waitForNotification(): Promise<CodexAppServerNotification> {
    throw new Error("Not used by completion callback delivery");
  }

  async close(): Promise<void> {}
}

function baseInput() {
  return {
    taskId: "item_abc123",
    runId: "run_def456",
    claimGeneration: 3 as const,
    producer: "agy" as const,
    status: "completed" as const,
    summary: "All tests pass.",
    completedAt: "2026-09-05T07:00:00.000Z",
  };
}

describe("completion callback receipts", () => {
  test("compiles a stable idempotency key for exact replays", () => {
    const first = compileCompletionCallbackV1(baseInput());
    const second = compileCompletionCallbackV1(baseInput());
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey.startsWith("completion-callback/v1:")).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("a changed summary changes the key; replay of the same summary does not", () => {
    const first = compileCompletionCallbackV1(baseInput());
    const changed = compileCompletionCallbackV1({ ...baseInput(), summary: "Different outcome." });
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test("fails closed on invalid identities, generations, and oversized summaries", () => {
    expect(() => compileCompletionCallbackV1({ ...baseInput(), taskId: "" })).toThrow();
    expect(() => compileCompletionCallbackV1({ ...baseInput(), claimGeneration: -1 })).toThrow();
    expect(() => compileCompletionCallbackV1({ ...baseInput(), summary: "x".repeat(10_001) })).toThrow();
    expect(() => compileCompletionCallbackV1({ ...baseInput(), completedAt: "not-a-time" })).toThrow();
    expect(() =>
      compileCompletionCallbackV1({ ...baseInput(), producer: "slack" as never })
    ).toThrow();
  });

  test("renders a bounded message carrying the exact canonical IDs", () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const message = completionCallbackMessageV1(receipt);
    expect(message).toContain("item_abc123");
    expect(message).toContain("run_def456");
    expect(message).toContain(receipt.idempotencyKey);
    expect(message.length).toBeLessThanOrEqual(12_000);
  });

  test("compiles a documented agy stream-json terminal result event", () => {
    const receipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", result: { status: "success", text: "Done.", usage: {} } },
      sessionRef: "conv_789",
    });
    expect(receipt.producer).toBe("agy");
    expect(receipt.status).toBe("completed");
    expect(receipt.sessionRef).toBe("conv_789");
  });

  test("rejects non-terminal agy stream events instead of inventing completion", () => {
    expect(() =>
      completionCallbackFromAgyResultEventV1({
        taskId: "item_abc123",
        runId: "run_def456",
        claimGeneration: 3,
        event: { event: "step_update", step_update: { state: "DONE" } },
      })
    ).toThrow();
  });
});

describe("completion callback delivery", () => {
  test("standalone delivery starts an independent thread and delivers the receipt", async () => {
    const connection = new FakeConnection();
    const delivered = new Set<string>();
    const receipt = compileCompletionCallbackV1(baseInput());
    const outcome = await deliverCompletionCallbackV1({
      connection,
      receipt,
      target: { mode: "standalone" },
      policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
      deliveredKeys: delivered,
    });
    expect(outcome.delivered).toBe(true);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.threadId).toBe("thread-1");
    expect(outcome.turnId).toBe("turn-1");
    expect(connection.calls.map((call) => call.method)).toEqual(["thread/start", "turn/start"]);
    const turnParams = connection.calls[1]!.params;
    expect(turnParams.threadId).toBe("thread-1");
  });

  test("exact replay returns the stored duplicate outcome without new app-server calls", async () => {
    const connection = new FakeConnection();
    const delivered = new Set<string>();
    const receipt = compileCompletionCallbackV1(baseInput());
    const policy = { cwd: "/tmp", model: "gpt-5.6-sol" } as const;
    await deliverCompletionCallbackV1({
      connection,
      receipt,
      target: { mode: "standalone" },
      policy,
      deliveredKeys: delivered,
    });
    const replay = await deliverCompletionCallbackV1({
      connection,
      receipt,
      target: { mode: "standalone" },
      policy,
      deliveredKeys: delivered,
    });
    expect(replay).toEqual({
      delivered: false,
      idempotencyKey: receipt.idempotencyKey,
      threadId: null,
      turnId: null,
      duplicate: true,
    });
    expect(connection.calls).toHaveLength(2);
  });

  test("bound-thread delivery resumes the exact thread and fails closed on mismatch", async () => {
    const connection = new FakeConnection();
    const receipt: CompletionCallbackReceiptV1 = compileCompletionCallbackV1({
      ...baseInput(),
      producer: "opencode",
    });
    const outcome = await deliverCompletionCallbackV1({
      connection,
      receipt,
      target: { mode: "bound-thread", threadId: "thread-abc" },
      policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
      deliveredKeys: new Set<string>(),
    });
    expect(outcome.threadId).toBe("thread-abc");
    expect(connection.calls.map((call) => call.method)).toEqual(["thread/resume", "turn/start"]);

    const failing = new FakeConnection();
    failing.failResume = true;
    await expect(
      deliverCompletionCallbackV1({
        connection: failing,
        receipt,
        target: { mode: "bound-thread", threadId: "thread-missing" },
        policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
        deliveredKeys: new Set<string>(),
      }),
    ).rejects.toThrow();
    expect(failing.calls.map((call) => call.method)).toEqual(["thread/resume"]);
  });

  test("rejects tampered receipts whose key does not match their fields", async () => {
    const connection = new FakeConnection();
    const receipt = compileCompletionCallbackV1(baseInput());
    const tampered: CompletionCallbackReceiptV1 = { ...receipt, summary: "Rewritten summary." };
    await expect(
      deliverCompletionCallbackV1({
        connection,
        receipt: tampered,
        target: { mode: "standalone" },
        policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
        deliveredKeys: new Set<string>(),
      }),
    ).rejects.toThrow();
    expect(connection.calls).toHaveLength(0);
  });
});

describe("completion callback codex queue CLI transport", () => {
  const SYNTHETIC_THREAD = "11111111-2222-4333-8444-555555555555";

  test("builds the exact supported argv without spawning", () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const argv = codexQueueArgvV1({ receipt, threadId: SYNTHETIC_THREAD });
    expect(argv[0]).toBe("queue");
    expect(argv[1]).toBe("--thread");
    expect(argv[2]).toBe(SYNTHETIC_THREAD);
    expect(argv[3]).toBe("--message");
    expect(typeof argv[4]).toBe("string");
    expect(argv[4]!).toContain("item_abc123");
    expect(argv[4]!.length).toBeLessThanOrEqual(12_000);
    expect(CODEX_QUEUE_COMMAND_V1).toBe("codex");
  });

  test("queues to the fixed bound thread and dedups exact replays", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const seen: Array<{ command: string; argv: readonly string[] }> = [];
    const delivered = new Set<string>();
    const run = async (command: string, argv: readonly string[]) => {
      seen.push({ command, argv });
      return { exitCode: 0, stdout: "queued", stderr: "" };
    };
    const first = await deliverCompletionCallbackViaQueueV1({
      receipt,
      threadId: SYNTHETIC_THREAD,
      run,
      deliveredKeys: delivered,
    });
    expect(first.delivered).toBe(true);
    expect(first.transport).toBe("codex-queue-cli");
    expect(first.threadId).toBe(SYNTHETIC_THREAD);
    expect(first.duplicate).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("codex");
    expect(seen[0]!.argv.slice(0, 3)).toEqual(["queue", "--thread", SYNTHETIC_THREAD]);

    const replay = await deliverCompletionCallbackViaQueueV1({
      receipt,
      threadId: SYNTHETIC_THREAD,
      run,
      deliveredKeys: delivered,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.delivered).toBe(false);
    expect(seen).toHaveLength(1);
  });

  test("non-zero exit and ambiguous spawn failure do not mark delivered", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const delivered = new Set<string>();
    let calls = 0;
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: SYNTHETIC_THREAD,
        run: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr: "daemon unreachable" };
        },
        deliveredKeys: delivered,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(delivered.has(receipt.idempotencyKey)).toBe(false);

    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: SYNTHETIC_THREAD,
        run: async () => {
          calls += 1;
          throw new Error("spawn ENOENT (ambiguous: reconcile before retry)");
        },
        deliveredKeys: delivered,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    expect(delivered.has(receipt.idempotencyKey)).toBe(false);

    const recovered = await deliverCompletionCallbackViaQueueV1({
      receipt,
      threadId: SYNTHETIC_THREAD,
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      deliveredKeys: delivered,
    });
    expect(recovered.delivered).toBe(true);
    expect(calls).toBe(3);
  });

  test("rejects invalid bound thread binding without spawning", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    let calls = 0;
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: "",
        run: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        deliveredKeys: new Set<string>(),
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
