import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  EXECUTION_PATHS,
  createExecutionCertaintyReceipt,
  parseExecutionCertaintyReceipt,
  parseExecutionReconciliationRecord,
  reconcileExecutionCertainty,
  type ExecutionCertaintyInput,
  type ExecutionCertaintyReceipt,
  type ExecutionReconciliationInput,
} from "../src/execution-certainty.ts";

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function baseInput(
  overrides: Partial<ExecutionCertaintyInput> = {},
): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "certainty-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-review",
    requestFingerprint: hash("a"),
    authorityFingerprint: hash("b"),
    runGeneration: 2,
    observedAt: "2026-08-01T06:00:00.000Z",
    evidence: {
      dispatchState: "possibly_started",
      cancellationState: "requested_delivery_unknown",
      remoteResult: null,
      localFailureClass: "timeout",
    },
    ...overrides,
  };
}

function resolution(
  overrides: Partial<ExecutionReconciliationInput> = {},
): ExecutionReconciliationInput {
  return {
    resolvedAt: "2026-08-01T06:01:00.000Z",
    source: "provider_state",
    outcome: "effect_recorded",
    evidenceFingerprint: hash("c"),
    ...overrides,
  };
}

function cloneReceipt(receipt: ExecutionCertaintyReceipt): Record<string, unknown> {
  return JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
}

describe("execution certainty projection", () => {
  test("proves pre-dispatch failures did not execute through this path", () => {
    const receipt = createExecutionCertaintyReceipt(
      baseInput({
        evidence: {
          dispatchState: "not_started",
          cancellationState: "not_requested",
          remoteResult: null,
          localFailureClass: "policy_denied",
        },
      }),
    );

    expect(receipt.certainty).toEqual({
      state: "not_dispatched",
      effectCertainty: "not_executed_by_this_call_path",
      remoteResultReceived: false,
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    });
  });

  test("keeps received remote responses separate from local failures", () => {
    for (const outcome of ["success", "application_error"] as const) {
      const receipt = createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome,
              resultIdentity: `result-${outcome}`,
            },
            localFailureClass: null,
          },
        }),
      );

      expect(receipt.certainty).toEqual({
        state: "remote_result_received",
        effectCertainty: "remote_response_received",
        remoteResultReceived: true,
        reconciliationRequired: "none",
        replayAuthorization: "not_authorized",
        nextEvidence: "none",
      });
    }
  });

  test("keeps mutation timeouts uncertain even after cancellation delivery", () => {
    for (const cancellationState of [
      "requested_delivery_unknown",
      "delivered",
      "observed_by_remote",
    ] as const) {
      const receipt = createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState,
            remoteResult: null,
            localFailureClass: "timeout",
          },
        }),
      );

      expect(receipt.certainty.state).toBe("local_timeout_outcome_unknown");
      expect(receipt.certainty.effectCertainty).toBe(
        "may_still_run_or_may_have_committed",
      );
      expect(receipt.certainty.reconciliationRequired).toBe(
        "operation_receipt_or_provider_state",
      );
      expect(receipt.certainty.replayAuthorization).toBe("not_authorized");
    }
  });

  test("does not require effect reconciliation for a failed read", () => {
    const receipt = createExecutionCertaintyReceipt(
      baseInput({
        operationKind: "read",
        evidence: {
          dispatchState: "started",
          cancellationState: "not_requested",
          remoteResult: null,
          localFailureClass: "transport_failure",
        },
      }),
    );

    expect(receipt.certainty.state).toBe("local_failure_unclassified");
    expect(receipt.certainty.reconciliationRequired).toBe("none");
    expect(receipt.certainty.nextEvidence).toBe("none");
  });

  test("retains result-serialization uncertainty after dispatch", () => {
    const receipt = createExecutionCertaintyReceipt(
      baseInput({
        evidence: {
          dispatchState: "started",
          cancellationState: "not_requested",
          remoteResult: null,
          localFailureClass: "result_serialization_failed",
        },
      }),
    );

    expect(receipt.certainty.state).toBe("local_failure_unclassified");
    expect(receipt.certainty.reconciliationRequired).toBe(
      "operation_receipt_or_provider_state",
    );
  });

  test("projects the same certainty across execution paths", () => {
    const certainties = EXECUTION_PATHS.map((executionPath) =>
      createExecutionCertaintyReceipt(baseInput({ executionPath })).certainty
    );
    const expected = certainties[0]!;
    expect(certainties).toEqual([expected, expected, expected, expected]);
  });

  test("deep-freezes receipts and parses exact replay", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.evidence)).toBe(true);
    expect(Object.isFrozen(receipt.certainty)).toBe(true);
    expect(parseExecutionCertaintyReceipt(receipt)).toEqual(receipt);
    expect(parseExecutionCertaintyReceipt(cloneReceipt(receipt))).toEqual(receipt);
  });
});

describe("execution certainty evidence validation", () => {
  test("rejects contradictory remote-result evidence", () => {
    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "possibly_started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome: "success",
              resultIdentity: "result-1",
            },
            localFailureClass: null,
          },
        }),
      )
    ).toThrow("requires started dispatch");

    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome: "success",
              resultIdentity: "result-1",
            },
            localFailureClass: "transport_failure",
          },
        }),
      )
    ).toThrow("cannot carry a local failure");
  });

  test("rejects impossible pre-dispatch and serialization combinations", () => {
    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "not_started",
            cancellationState: "not_requested",
            remoteResult: null,
            localFailureClass: "timeout",
          },
        }),
      )
    ).toThrow("cannot report a tools-call timeout");

    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "not_started",
            cancellationState: "not_requested",
            remoteResult: null,
            localFailureClass: "result_serialization_failed",
          },
        }),
      )
    ).toThrow("requires completed local dispatch");

    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: null,
            localFailureClass: "policy_denied",
          },
        }),
      )
    ).toThrow("pre-dispatch failure cannot follow dispatch");

    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: null,
            localFailureClass: null,
          },
        }),
      )
    ).toThrow("requires a local failure class");
  });

  test("rejects cancellation overclaims before dispatch", () => {
    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "not_started",
            cancellationState: "delivered",
            remoteResult: null,
            localFailureClass: "policy_denied",
          },
        }),
      )
    ).toThrow("cannot report remote cancellation delivery");
  });

  test("rejects unknown creation fields and receipt-only fields", () => {
    expect(() =>
      createExecutionCertaintyReceipt({
        ...baseInput(),
        arguments: { secret: true },
      })
    ).toThrow("unknown field arguments");

    expect(() =>
      createExecutionCertaintyReceipt({
        ...baseInput(),
        certainty: { state: "not_dispatched" },
      })
    ).toThrow("unknown field certainty");
  });
});

describe("execution certainty exact admission", () => {
  test("rejects top-level and nested accessors without invocation", () => {
    let topLevelReads = 0;
    const topLevel = { ...baseInput() } as Record<string, unknown>;
    Object.defineProperty(topLevel, "workspace", {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return "default";
      },
    });
    expect(() => createExecutionCertaintyReceipt(topLevel)).toThrow(
      "only enumerable data properties",
    );
    expect(topLevelReads).toBe(0);

    let nestedReads = 0;
    const evidence = { ...baseInput().evidence } as Record<string, unknown>;
    Object.defineProperty(evidence, "dispatchState", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return "possibly_started";
      },
    });
    expect(() =>
      createExecutionCertaintyReceipt({ ...baseInput(), evidence })
    ).toThrow("only enumerable data properties");
    expect(nestedReads).toBe(0);
  });

  test("rejects inherited, hidden, and symbol-decorated records", () => {
    const inherited = Object.assign(
      Object.create({ escapedAdmission: true }),
      baseInput(),
    );
    expect(() => createExecutionCertaintyReceipt(inherited)).toThrow(
      "plain data object",
    );

    const hidden = { ...baseInput() } as Record<string, unknown>;
    Object.defineProperty(hidden, "escapedAdmission", {
      enumerable: false,
      value: true,
    });
    expect(() => createExecutionCertaintyReceipt(hidden)).toThrow(
      "only enumerable data properties",
    );

    const decorated = {
      ...baseInput(),
      [Symbol("escapedAdmission")]: true,
    };
    expect(() => createExecutionCertaintyReceipt(decorated)).toThrow(
      "only enumerable data properties",
    );
  });

  test("rejects normalized aliases and non-millisecond timestamps", () => {
    expect(() =>
      createExecutionCertaintyReceipt({
        ...baseInput(),
        workspace: " default",
      })
    ).toThrow("bounded lowercase slug");
    expect(() =>
      createExecutionCertaintyReceipt({
        ...baseInput(),
        operationRef: "operation-certainty-review ",
      })
    ).toThrow("is invalid");
    expect(() =>
      createExecutionCertaintyReceipt({
        ...baseInput(),
        observedAt: "2026-08-01T06:00:00Z",
      })
    ).toThrow("canonical UTC timestamp");
  });

  test("rejects realistic credential families and permits benign identifiers", () => {
    for (const candidate of [
      `ghp_${"a".repeat(24)}`,
      `github_pat_${"a".repeat(24)}`,
      `sk-${"a".repeat(24)}`,
      `sk-proj-${"a".repeat(24)}`,
      `stn.tok_${"a".repeat(24)}`,
      `xoxb-${"a".repeat(20)}`,
      `env://TOKEN_${"a".repeat(20)}`,
      `secret://token-${"a".repeat(20)}`,
      `eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(10)}`,
    ]) {
      expect(() =>
        createExecutionCertaintyReceipt({
          ...baseInput(),
          operationRef: candidate,
        })
      ).toThrow("is invalid");
    }

    expect(
      createExecutionCertaintyReceipt({
        ...baseInput(),
        operationRef: "task-sk-review",
      }).operationRef,
    ).toBe("task-sk-review");
  });
});

describe("execution certainty receipt integrity", () => {
  test("rejects derived projection and fingerprint tampering", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());

    const projectionTamper = cloneReceipt(receipt);
    projectionTamper.certainty = {
      ...(projectionTamper.certainty as Record<string, unknown>),
      reconciliationRequired: "none",
    };
    expect(() => parseExecutionCertaintyReceipt(projectionTamper)).toThrow(
      "projection does not match",
    );

    const fingerprintTamper = cloneReceipt(receipt);
    fingerprintTamper.receiptFingerprint = hash("f");
    expect(() => parseExecutionCertaintyReceipt(fingerprintTamper)).toThrow(
      "fingerprint does not match",
    );

    const boundFieldTamper = cloneReceipt(receipt);
    boundFieldTamper.runGeneration = 3;
    expect(() => parseExecutionCertaintyReceipt(boundFieldTamper)).toThrow(
      "fingerprint does not match",
    );
  });

  test("rejects hidden fields in parsed receipts", () => {
    const receipt = cloneReceipt(createExecutionCertaintyReceipt(baseInput()));
    Object.defineProperty(receipt, "escapedAdmission", {
      enumerable: false,
      value: true,
    });
    expect(() => parseExecutionCertaintyReceipt(receipt)).toThrow(
      "only enumerable data properties",
    );
  });
});

describe("execution certainty reconciliation", () => {
  test("records effect-present and effect-absent outcomes without authorizing replay", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());

    const recorded = reconcileExecutionCertainty(receipt, resolution());
    expect(recorded.resolution).toEqual({
      effect: "effect_recorded",
      status: "resolved",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    });

    const absent = reconcileExecutionCertainty(
      receipt,
      resolution({ outcome: "effect_absent" }),
    );
    expect(absent.resolution.effect).toBe(
      "effect_absent_after_exact_reconciliation",
    );
    expect(absent.resolution.replayAuthorization).toBe("not_authorized");
  });

  test("records recovered results and continued uncertainty", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());

    const recovered = reconcileExecutionCertainty(
      receipt,
      resolution({
        source: "remote_result",
        outcome: "remote_result_recovered",
      }),
    );
    expect(recovered.resolution.effect).toBe("remote_response_received");
    expect(recovered.resolution.status).toBe("resolved");

    const unknown = reconcileExecutionCertainty(
      receipt,
      resolution({ outcome: "still_unknown" }),
    );
    expect(unknown.resolution).toEqual({
      effect: "unknown",
      status: "required",
      replayAuthorization: "not_authorized",
      nextEvidence: "continue_reconciliation",
    });
  });

  test("rejects reconciliation for certain receipts, chronology drift, and source mismatch", () => {
    const certain = createExecutionCertaintyReceipt(
      baseInput({
        evidence: {
          dispatchState: "not_started",
          cancellationState: "not_requested",
          remoteResult: null,
          localFailureClass: "policy_denied",
        },
      }),
    );
    expect(() => reconcileExecutionCertainty(certain, resolution())).toThrow(
      "does not require reconciliation",
    );

    const uncertain = createExecutionCertaintyReceipt(baseInput());
    expect(() =>
      reconcileExecutionCertainty(
        uncertain,
        resolution({ resolvedAt: "2026-08-01T05:59:59.999Z" }),
      )
    ).toThrow("cannot precede");

    expect(
      reconcileExecutionCertainty(
        uncertain,
        resolution({ resolvedAt: "2026-08-01T06:00:00.000Z" }),
      ).resolvedAt,
    ).toBe("2026-08-01T06:00:00.000Z");

    expect(() =>
      reconcileExecutionCertainty(
        uncertain,
        resolution({
          source: "provider_state",
          outcome: "remote_result_recovered",
        }),
      )
    ).toThrow("require remote-result evidence");

    expect(() =>
      reconcileExecutionCertainty(
        uncertain,
        resolution({
          source: "remote_result",
          outcome: "effect_recorded",
        }),
      )
    ).toThrow("must resolve as a recovered remote result");
  });

  test("applies descriptor-safe admission to reconciliation inputs", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());
    let reads = 0;
    const hostile = { ...resolution() } as Record<string, unknown>;
    Object.defineProperty(hostile, "source", {
      enumerable: true,
      get() {
        reads += 1;
        return "provider_state";
      },
    });
    expect(() => reconcileExecutionCertainty(receipt, hostile)).toThrow(
      "only enumerable data properties",
    );
    expect(reads).toBe(0);
  });

  test("parses exact reconciliation records and rejects tampering", () => {
    const receipt = createExecutionCertaintyReceipt(baseInput());
    const record = reconcileExecutionCertainty(receipt, resolution());

    expect(parseExecutionReconciliationRecord(record)).toEqual(record);
    expect(
      parseExecutionReconciliationRecord(
        JSON.parse(JSON.stringify(record)),
        cloneReceipt(receipt),
      ),
    ).toEqual(record);

    const wrongReceipt = createExecutionCertaintyReceipt(
      baseInput({ operationRef: "operation-certainty-other" }),
    );
    expect(() =>
      parseExecutionReconciliationRecord(record, wrongReceipt)
    ).toThrow("bound to a different receipt");

    const chronologyTamper = JSON.parse(JSON.stringify(record)) as Record<
      string,
      unknown
    >;
    chronologyTamper.resolvedAt = "2026-08-01T05:59:59.999Z";
    const {
      reconciliationFingerprint: _ignoredFingerprint,
      ...chronologyUnsigned
    } = chronologyTamper;
    chronologyTamper.reconciliationFingerprint =
      fingerprintCanonicalRequest(chronologyUnsigned);
    expect(() =>
      parseExecutionReconciliationRecord(chronologyTamper, receipt)
    ).toThrow("cannot precede");

    const projectionTamper = JSON.parse(JSON.stringify(record)) as Record<
      string,
      unknown
    >;
    projectionTamper.resolution = {
      ...(projectionTamper.resolution as Record<string, unknown>),
      effect: "unknown",
    };
    expect(() =>
      parseExecutionReconciliationRecord(projectionTamper)
    ).toThrow("projection does not match");

    const fingerprintTamper = JSON.parse(JSON.stringify(record)) as Record<
      string,
      unknown
    >;
    fingerprintTamper.reconciliationFingerprint = hash("e");
    expect(() =>
      parseExecutionReconciliationRecord(fingerprintTamper)
    ).toThrow("fingerprint does not match");
  });
});
