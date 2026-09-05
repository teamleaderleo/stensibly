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
  reconcileCompletionCallbackDeliveryV1,
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

  test("compiles official agy stream-json SUCCESS event with response and conversation_id", () => {
    const receipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Git rebase rewritten.",
          conversation_id: "agy-conv-official-42",
          duration_seconds: 6.88,
          num_turns: 1,
          usage: { input_tokens: 10418, output_tokens: 589 },
        },
      },
    });
    expect(receipt.producer).toBe("agy");
    expect(receipt.status).toBe("completed");
    expect(receipt.summary).toBe("Git rebase rewritten.");
    expect(receipt.sessionRef).toBe("agy-conv-official-42");
  });

  test("compiles official agy stream-json ERROR event into failed status and error summary", () => {
    const receipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: {
        event: "result",
        result: {
          conversation_id: "agy-conv-err-1",
          status: "ERROR",
          response: "",
          error: "Model quota exceeded for Gemini 3.8 Flash",
          duration_seconds: 0,
          num_turns: 0,
        },
      },
    });
    expect(receipt.producer).toBe("agy");
    expect(receipt.status).toBe("failed");
    expect(receipt.summary).toBe("Model quota exceeded for Gemini 3.8 Flash");
    expect(receipt.sessionRef).toBe("agy-conv-err-1");
  });

  test("synthetic negative controls: maps non-success statuses to failed closed", () => {
    // Negative control: literal failed
    const failedReceipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", result: { status: "failed", error: "Explicit failure" } },
    });
    expect(failedReceipt.status).toBe("failed");
    expect(failedReceipt.summary).toBe("Explicit failure");

    // Negative control: ERROR status (coordinator bug fix: was mapped to completed)
    const errorReceipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", result: { status: "ERROR", error: "System fault" } },
    });
    expect(errorReceipt.status).toBe("failed");

    // Negative control: missing status field
    const missingStatusReceipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", result: { response: "Finished without status field" } },
    });
    expect(missingStatusReceipt.status).toBe("failed");

    // Negative control: unknown/arbitrary status string
    const unknownStatusReceipt = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", result: { status: "MYSTERY_STATUS" } },
    });
    expect(unknownStatusReceipt.status).toBe("failed");
  });

  test("handles both nested result and top-level result payloads with response/text precedence", () => {
    // Top-level status envelope
    const topLevelSuccess = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { event: "result", status: "SUCCESS", response: "Top-level success payload" },
    });
    expect(topLevelSuccess.status).toBe("completed");
    expect(topLevelSuccess.summary).toBe("Top-level success payload");

    // Top-level error envelope
    const topLevelError = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: { status: "ERROR", error: "Top-level error payload" },
    });
    expect(topLevelError.status).toBe("failed");
    expect(topLevelError.summary).toBe("Top-level error payload");

    // Response takes precedence over text
    const precedence = completionCallbackFromAgyResultEventV1({
      taskId: "item_abc123",
      runId: "run_def456",
      claimGeneration: 3,
      event: {
        event: "result",
        result: { status: "SUCCESS", response: "Preferred response", text: "Legacy fallback" },
      },
    });
    expect(precedence.summary).toBe("Preferred response");
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

  test("bound-thread delivery fails closed when Codex resumes a different thread ID", async () => {
    const connection = new FakeConnection();
    const originalRequest = connection.request.bind(connection);
    connection.request = async (method, params) => {
      connection.calls.push({ method, params: params as Record<string, unknown> });
      if (method === "thread/resume") {
        return { thread: { id: "thread-different", sessionId: "thread-different" } } as any;
      }
      return originalRequest(method, params);
    };
    const receipt = compileCompletionCallbackV1(baseInput());
    await expect(
      deliverCompletionCallbackV1({
        connection,
        receipt,
        target: { mode: "bound-thread", threadId: "thread-target" },
        policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
        deliveredKeys: new Set<string>(),
      }),
    ).rejects.toThrow("Codex resumed a different thread than the bound completion target");
    expect(connection.calls.map((c) => c.method)).toEqual(["thread/resume"]);
  });

  test("concurrent duplicate sends on app-server are deduplicated without double thread/turn dispatch", async () => {
    const connection = new FakeConnection();
    const delivered = new Set<string>();
    const receipt = compileCompletionCallbackV1(baseInput());
    const [first, second] = await Promise.all([
      deliverCompletionCallbackV1({
        connection,
        receipt,
        target: { mode: "standalone" },
        policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
        deliveredKeys: delivered,
      }),
      deliverCompletionCallbackV1({
        connection,
        receipt,
        target: { mode: "standalone" },
        policy: { cwd: "/tmp", model: "gpt-5.6-sol" },
        deliveredKeys: delivered,
      }),
    ]);
    expect(first.delivered).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.delivered).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(connection.calls).toHaveLength(2);
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

  test("concurrent duplicate sends spawn subprocess exactly once and dedup concurrent caller", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const seen: Array<{ command: string; argv: readonly string[] }> = [];
    const delivered = new Set<string>();
    const run = async (command: string, argv: readonly string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      seen.push({ command, argv });
      return { exitCode: 0, stdout: "queued", stderr: "" };
    };
    const [first, second] = await Promise.all([
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: SYNTHETIC_THREAD,
        run,
        deliveredKeys: delivered,
      }),
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: SYNTHETIC_THREAD,
        run,
        deliveredKeys: delivered,
      }),
    ]);
    expect(seen).toHaveLength(1);
    expect(first.delivered).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.delivered).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(delivered.has(receipt.idempotencyKey)).toBe(true);
  });

  test("binding mismatches fail closed without spawning", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    let spawns = 0;
    const run = async () => {
      spawns++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // Standalone target mode is rejected for CLI queue transport
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        target: { mode: "standalone" },
        run,
      }),
    ).rejects.toThrow("bound-thread");

    // Mismatch between explicit threadId and target.threadId
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: "11111111-1111-1111-1111-111111111111",
        target: { mode: "bound-thread", threadId: "22222222-2222-2222-2222-222222222222" },
        run,
      }),
    ).rejects.toThrow("mismatch");

    // Runner returns mismatched threadId
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt,
        threadId: SYNTHETIC_THREAD,
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", threadId: "wrong-thread-from-runner" }),
      }),
    ).rejects.toThrow("thread binding mismatch");

    // codexQueueArgvV1 also enforces binding match and rejects standalone target
    expect(() =>
      codexQueueArgvV1({
        receipt,
        target: { mode: "standalone" },
      }),
    ).toThrow("bound-thread");

    expect(() =>
      codexQueueArgvV1({
        receipt,
        threadId: "11111111-1111-1111-1111-111111111111",
        target: { mode: "bound-thread", threadId: "22222222-2222-2222-2222-222222222222" },
      }),
    ).toThrow("mismatch");

    expect(spawns).toBe(0);
  });

  test("ambiguous accepted-but-timeout delivery can reconcile as accepted or fail closed", async () => {
    const receipt = compileCompletionCallbackV1(baseInput());
    const delivered = new Set<string>();

    // Case 1: Timeout where reconcile confirms message was accepted by daemon
    let attempts = 0;
    const reconciledDelivery = await deliverCompletionCallbackViaQueueV1({
      receipt,
      threadId: SYNTHETIC_THREAD,
      run: async () => {
        attempts++;
        throw new Error("ETIMEDOUT waiting for codex queue child process");
      },
      deliveredKeys: delivered,
      reconcile: async (rec, thread, err) => {
        expect(rec.idempotencyKey).toBe(receipt.idempotencyKey);
        expect(thread).toBe(SYNTHETIC_THREAD);
        expect(String(err)).toContain("ETIMEDOUT");
        return true;
      },
    });
    expect(attempts).toBe(1);
    expect(reconciledDelivery.delivered).toBe(true);
    expect(reconciledDelivery.recovered).toBe(true);
    expect(delivered.has(receipt.idempotencyKey)).toBe(true);

    // Subsequent replay dedups immediately without spawning
    const replay = await deliverCompletionCallbackViaQueueV1({
      receipt,
      threadId: SYNTHETIC_THREAD,
      run: async () => {
        attempts++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      deliveredKeys: delivered,
    });
    expect(replay.duplicate).toBe(true);
    expect(attempts).toBe(1);

    // Case 2: Timeout where reconcile confirms message was NOT accepted
    const unacceptedReceipt = compileCompletionCallbackV1({ ...baseInput(), taskId: "item_unaccepted" });
    const unacceptedDelivered = new Set<string>();
    let unacceptedAttempts = 0;
    await expect(
      deliverCompletionCallbackViaQueueV1({
        receipt: unacceptedReceipt,
        threadId: SYNTHETIC_THREAD,
        run: async () => {
          unacceptedAttempts++;
          throw new Error("ETIMEDOUT");
        },
        deliveredKeys: unacceptedDelivered,
        reconcile: async () => false,
      }),
    ).rejects.toThrow("ETIMEDOUT");
    expect(unacceptedAttempts).toBe(1);
    expect(unacceptedDelivered.has(unacceptedReceipt.idempotencyKey)).toBe(false);

    // Helper reconcileCompletionCallbackDeliveryV1 tests
    expect(
      reconcileCompletionCallbackDeliveryV1({
        receipt: unacceptedReceipt,
        deliveredKeys: unacceptedDelivered,
        accepted: true,
      }),
    ).toBe(true);
    expect(unacceptedDelivered.has(unacceptedReceipt.idempotencyKey)).toBe(true);

    expect(
      reconcileCompletionCallbackDeliveryV1({
        receipt: unacceptedReceipt,
        deliveredKeys: new Set<string>(),
        accepted: false,
      }),
    ).toBe(false);
  });
});
