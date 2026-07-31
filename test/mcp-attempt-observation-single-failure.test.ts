import { describe, expect, test } from "bun:test";
import {
  createMcpAttemptObservation,
  projectMcpAttemptObservations,
  type McpAttemptObservationInput,
  type McpAttemptObservationV1,
} from "../src/mcp-attempt-observation.ts";

const manifestFingerprint = `sha256:${"a".repeat(64)}`;
const baseInput = {
  attemptId: "attempt-490-single-failure",
  requestId: "request-490-single-failure",
  sessionClassification: "streamable_http_stateless",
  manifestFingerprint,
  settlement: "unsettled",
  delivery: "unknown",
} as const;
type FailureStage = NonNullable<McpAttemptObservationInput["failureStage"]>;
type Transition = McpAttemptObservationInput["transition"];

const validFailureStageHistories = {
  method_validation: [],
  origin_validation: [],
  host_validation: [],
  token_authority: [],
  authentication: [],
  payload_parse: ["authentication_completed"],
  authorization: ["authentication_completed"],
  request_validation: ["authentication_completed"],
  server_construction: [
    "authentication_completed",
    "authorization_completed",
  ],
  transport_connection: [
    "authentication_completed",
    "authorization_completed",
    "server_constructed",
  ],
  request_execution: [
    "authentication_completed",
    "authorization_completed",
    "server_constructed",
    "transport_connected",
    "execution_started",
  ],
} as const satisfies Record<FailureStage, readonly Transition[]>;

function event(
  transition: McpAttemptObservationInput["transition"],
  at: string,
  overrides: Partial<McpAttemptObservationInput> = {},
) {
  return createMcpAttemptObservation({
    ...baseInput,
    transition,
    occurredAt: at,
    ...overrides,
  });
}

function accepted(at: string) {
  return event("request_accepted", at);
}

function failed(
  at: string,
  stage: FailureStage,
  settlement: McpAttemptObservationInput["settlement"] =
    stage === "request_execution" ? "ambiguous" : "settled",
) {
  return event("failed", at, {
    failureStage: stage,
    settlement,
  });
}

function timestamp(offset: number): string {
  return `2026-07-31T03:00:00.${String(offset).padStart(3, "0")}Z`;
}

function historyEndingInFailure(
  stage: FailureStage,
  priorTransitions: readonly McpAttemptObservationInput["transition"][],
): McpAttemptObservationV1[] {
  return [
    accepted(timestamp(0)),
    ...priorTransitions.map((transition, index) =>
      event(transition, timestamp(index + 1))
    ),
    failed(timestamp(priorTransitions.length + 1), stage),
  ];
}

describe("MCP attempt terminal transitions", () => {
  test("requires a new attempt identity for a second failure", () => {
    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:01:00.000Z"),
      failed("2026-07-31T03:01:00.010Z", "authentication"),
      failed("2026-07-31T03:01:00.020Z", "request_execution"),
    ])).toThrow("repeats failed");
  });

  test("rejects ordinary lifecycle progress after failure", () => {
    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:02:00.000Z"),
      failed("2026-07-31T03:02:00.010Z", "authentication"),
      event("authentication_completed", "2026-07-31T03:02:00.020Z"),
    ])).toThrow("cannot resume ordinary lifecycle progress after failure");

    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:03:00.000Z"),
      event("execution_started", "2026-07-31T03:03:00.010Z"),
      failed("2026-07-31T03:03:00.020Z", "request_execution"),
      event("execution_settled", "2026-07-31T03:03:00.030Z", {
        settlement: "settled",
      }),
    ])).toThrow("cannot resume ordinary lifecycle progress after failure");
  });

  test("admits serialized failure evidence before delivery or reconciliation", () => {
    const settled = projectMcpAttemptObservations([
      accepted("2026-07-31T03:03:10.000Z"),
      failed("2026-07-31T03:03:10.010Z", "authentication"),
      event("response_serialized", "2026-07-31T03:03:10.020Z", {
        settlement: "settled",
      }),
    ]);
    expect(settled).toMatchObject({
      latestTransition: "response_serialized",
      settlement: "settled",
      delivery: "unknown",
      settledAt: "2026-07-31T03:03:10.010Z",
      responseSerializedAt: "2026-07-31T03:03:10.020Z",
      boundaryReturnedAt: null,
      clientAcknowledgedAt: null,
      lastFailureStage: "authentication",
    });

    const reconciled = projectMcpAttemptObservations([
      accepted("2026-07-31T03:03:20.000Z"),
      event("authentication_completed", "2026-07-31T03:03:20.010Z"),
      event("authorization_completed", "2026-07-31T03:03:20.020Z"),
      event("server_constructed", "2026-07-31T03:03:20.030Z"),
      event("transport_connected", "2026-07-31T03:03:20.040Z"),
      event("execution_started", "2026-07-31T03:03:20.050Z"),
      failed("2026-07-31T03:03:20.060Z", "request_execution"),
      event("response_serialized", "2026-07-31T03:03:20.070Z", {
        settlement: "ambiguous",
      }),
      event("reconciled", "2026-07-31T03:03:20.080Z", {
        settlement: "reconciled",
      }),
    ]);
    expect(reconciled).toMatchObject({
      latestTransition: "reconciled",
      settlement: "reconciled",
      delivery: "unknown",
      responseSerializedAt: "2026-07-31T03:03:20.070Z",
      reconciledAt: "2026-07-31T03:03:20.080Z",
      lastFailureStage: "request_execution",
    });

    const returned = event("boundary_returned", "2026-07-31T03:03:30.020Z", {
      settlement: "settled",
      delivery: "boundary_returned",
    });
    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:03:30.000Z"),
      failed("2026-07-31T03:03:30.010Z", "authentication"),
      returned,
      event("response_serialized", "2026-07-31T03:03:30.030Z", {
        settlement: "settled",
      }),
    ])).toThrow("delivery knowledge regressed");

    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:03:40.000Z"),
      failed("2026-07-31T03:03:40.010Z", "authentication"),
      event("response_serialized", "2026-07-31T03:03:40.020Z", {
        settlement: "settled",
      }),
      event("response_serialized", "2026-07-31T03:03:40.030Z", {
        settlement: "settled",
      }),
    ])).toThrow("repeats response_serialized");
  });

  test("admits every failure stage only inside its hosted lifecycle window", () => {
    for (const stage of Object.keys(validFailureStageHistories) as FailureStage[]) {
      const projection = projectMcpAttemptObservations(
        historyEndingInFailure(stage, validFailureStageHistories[stage]),
      );
      expect(projection.latestTransition).toBe("failed");
      expect(projection.lastFailureStage).toBe(stage);
      expect(projection.settlement).toBe(
        stage === "request_execution" ? "ambiguous" : "settled",
      );
    }

    const lateValidation = projectMcpAttemptObservations(
      historyEndingInFailure("request_validation", [
        "authentication_completed",
        "authorization_completed",
      ]),
    );
    expect(lateValidation.lastFailureStage).toBe("request_validation");
  });

  test("rejects failure stages before their prerequisite evidence", () => {
    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("payload_parse", []),
    )).toThrow("payload_parse is not yet reachable");

    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("request_validation", []),
    )).toThrow("request_validation is not yet reachable");

    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("request_execution", ["transport_connected"]),
    )).toThrow("request_execution is not yet reachable");
  });

  test("rejects failure stages after their completion boundary", () => {
    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("authentication", ["authentication_completed"]),
    )).toThrow("authentication occurred after its lifecycle interval");

    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("payload_parse", [
        "authentication_completed",
        "authorization_completed",
      ]),
    )).toThrow("payload_parse occurred after its lifecycle interval");

    expect(() => projectMcpAttemptObservations(
      historyEndingInFailure("request_validation", [
        "authentication_completed",
        "authorization_completed",
        "server_constructed",
      ]),
    )).toThrow("request_validation occurred after its lifecycle interval");

    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:04:00.000Z"),
      event("authentication_completed", "2026-07-31T03:04:00.010Z"),
      event("authorization_completed", "2026-07-31T03:04:00.020Z"),
      event("server_constructed", "2026-07-31T03:04:00.030Z"),
      event("transport_connected", "2026-07-31T03:04:00.040Z"),
      event("execution_started", "2026-07-31T03:04:00.050Z"),
      event("execution_settled", "2026-07-31T03:04:00.060Z", {
        settlement: "settled",
      }),
      failed(
        "2026-07-31T03:04:00.070Z",
        "request_execution",
        "settled",
      ),
    ])).toThrow("request_execution occurred after its lifecycle interval");
  });

  test("rejects post-acknowledgement failure evidence", () => {
    expect(() => projectMcpAttemptObservations([
      accepted("2026-07-31T03:04:10.000Z"),
      event("authentication_completed", "2026-07-31T03:04:10.010Z"),
      event("authorization_completed", "2026-07-31T03:04:10.020Z"),
      event("server_constructed", "2026-07-31T03:04:10.030Z"),
      event("transport_connected", "2026-07-31T03:04:10.040Z"),
      event("execution_started", "2026-07-31T03:04:10.050Z"),
      event("execution_settled", "2026-07-31T03:04:10.060Z", {
        settlement: "settled",
      }),
      event("boundary_returned", "2026-07-31T03:04:10.070Z", {
        settlement: "settled",
        delivery: "boundary_returned",
      }),
      event("client_acknowledged", "2026-07-31T03:04:10.080Z", {
        settlement: "settled",
        delivery: "client_acknowledged",
      }),
      failed(
        "2026-07-31T03:04:10.090Z",
        "request_execution",
        "settled",
      ),
    ])).toThrow("delivery knowledge regressed");
  });

  test("admits explicit late delivery and reconciliation evidence", () => {
    const delivered = projectMcpAttemptObservations([
      accepted("2026-07-31T03:05:00.000Z"),
      failed("2026-07-31T03:05:00.010Z", "authentication"),
      event("boundary_returned", "2026-07-31T03:05:00.020Z", {
        settlement: "settled",
        delivery: "boundary_returned",
      }),
      event("client_acknowledged", "2026-07-31T03:05:00.030Z", {
        settlement: "settled",
        delivery: "client_acknowledged",
      }),
    ]);
    expect(delivered).toMatchObject({
      latestTransition: "client_acknowledged",
      settlement: "settled",
      delivery: "client_acknowledged",
      settledAt: "2026-07-31T03:05:00.010Z",
      boundaryReturnedAt: "2026-07-31T03:05:00.020Z",
      clientAcknowledgedAt: "2026-07-31T03:05:00.030Z",
      lastFailureStage: "authentication",
    });

    const reconciled = projectMcpAttemptObservations([
      accepted("2026-07-31T03:06:00.000Z"),
      event("authentication_completed", "2026-07-31T03:06:00.010Z"),
      event("authorization_completed", "2026-07-31T03:06:00.020Z"),
      event("server_constructed", "2026-07-31T03:06:00.030Z"),
      event("transport_connected", "2026-07-31T03:06:00.040Z"),
      event("execution_started", "2026-07-31T03:06:00.050Z"),
      failed("2026-07-31T03:06:00.060Z", "request_execution"),
      event("reconciled", "2026-07-31T03:06:00.070Z", {
        settlement: "reconciled",
      }),
    ]);
    expect(reconciled).toMatchObject({
      latestTransition: "reconciled",
      settlement: "reconciled",
      delivery: "unknown",
      reconciledAt: "2026-07-31T03:06:00.070Z",
      lastFailureStage: "request_execution",
    });
  });

  test("requires terminal settlement and unknown delivery on failed events", () => {
    expect(() => event("failed", "2026-07-31T03:07:00.000Z", {
      failureStage: "authentication",
    })).toThrow("requires settled or ambiguous knowledge");

    expect(() => event("failed", "2026-07-31T03:07:00.005Z", {
      failureStage: "authentication",
      settlement: "ambiguous",
    })).toThrow("Pre-execution MCP failure requires settled knowledge");

    expect(() => event("failed", "2026-07-31T03:07:00.010Z", {
      failureStage: "authentication",
      settlement: "settled",
      delivery: "boundary_returned",
    })).toThrow("requires a boundary-returned transition");
  });

  test("rejects an oversized history before reading any slot", () => {
    let slotReads = 0;
    const oversized = new Array<McpAttemptObservationV1>(129);
    Object.defineProperty(oversized, "0", {
      enumerable: true,
      configurable: true,
      get() {
        slotReads += 1;
        return accepted("2026-07-31T03:08:00.000Z");
      },
    });

    expect(() => projectMcpAttemptObservations(oversized)).toThrow(
      "exceeds 128 observations",
    );
    expect(slotReads).toBe(0);
  });
});
