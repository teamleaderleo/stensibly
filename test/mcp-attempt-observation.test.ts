import { describe, expect, test } from "bun:test";
import {
  createMcpAttemptObservation,
  projectMcpAttemptObservations,
  type McpAttemptObservationInput,
  type McpAttemptObservationV1,
} from "../src/mcp-attempt-observation.ts";

const manifestFingerprint = `sha256:${"a".repeat(64)}`;
const operationIdentityDigest = `sha256:${"b".repeat(64)}`;
const baseInput = {
  attemptId: "attempt-490-a",
  requestId: "request-490-a",
  operationIdentityDigest,
  sessionClassification: "streamable_http_stateless",
  manifestFingerprint,
  settlement: "unsettled",
  delivery: "unknown",
} as const;

function observation(
  transition: McpAttemptObservationInput["transition"],
  occurredAt: string,
  overrides: Partial<McpAttemptObservationInput> = {},
): McpAttemptObservationV1 {
  return createMcpAttemptObservation({
    ...baseInput,
    transition,
    occurredAt,
    ...overrides,
  });
}

describe("MCP attempt observations", () => {
  test("creates deterministic immutable content-minimised events", () => {
    const first = observation(
      "request_accepted",
      "2026-07-31T02:00:00.000Z",
    );
    const second = observation(
      "request_accepted",
      "2026-07-31T02:00:00.000Z",
    );

    expect(first).toEqual(second);
    expect(first.observationId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.containsPrivateContent).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Bearer");
    expect(JSON.stringify(first)).not.toContain("private payload");

    expect(() => createMcpAttemptObservation({
      ...baseInput,
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
      token: "private payload",
    } as unknown as McpAttemptObservationInput)).toThrow(
      "MCP attempt observation input contains unknown fields",
    );

    const hostileField = "credential:github_pat_private123";
    let hostileAccessorReads = 0;
    const hostileRecord = {
      ...baseInput,
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
    } as unknown as McpAttemptObservationInput;
    Object.defineProperty(hostileRecord, hostileField, {
      enumerable: true,
      configurable: true,
      get() {
        hostileAccessorReads += 1;
        return "private payload";
      },
    });
    let hostileError: unknown;
    try {
      createMcpAttemptObservation(hostileRecord);
    } catch (error) {
      hostileError = error;
    }
    expect(hostileError).toBeInstanceOf(TypeError);
    expect((hostileError as Error).message).toBe(
      "MCP attempt observation input contains unknown fields",
    );
    expect((hostileError as Error).message).not.toContain(hostileField);
    expect(hostileAccessorReads).toBe(0);

    let accessorRead = false;
    const accessor = {
      ...baseInput,
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
    } as unknown as McpAttemptObservationInput;
    Object.defineProperty(accessor, "attemptId", {
      enumerable: true,
      configurable: true,
      get() {
        accessorRead = true;
        return "attempt-490-a";
      },
    });
    expect(() => createMcpAttemptObservation(accessor)).toThrow(
      "attemptId must be an enumerable data property",
    );
    expect(accessorRead).toBe(false);
  });

  test("projects server settlement separately from boundary and client delivery", () => {
    const events = [
      observation("request_accepted", "2026-07-31T02:00:00.000Z"),
      observation("authentication_completed", "2026-07-31T02:00:00.010Z"),
      observation("authorization_completed", "2026-07-31T02:00:00.020Z"),
      observation("server_constructed", "2026-07-31T02:00:00.030Z"),
      observation("transport_connected", "2026-07-31T02:00:00.040Z"),
      observation("execution_started", "2026-07-31T02:00:00.050Z"),
      observation("execution_settled", "2026-07-31T02:00:00.060Z", {
        settlement: "settled",
      }),
      observation("response_serialized", "2026-07-31T02:00:00.070Z", {
        settlement: "settled",
      }),
      observation("boundary_returned", "2026-07-31T02:00:00.080Z", {
        settlement: "settled",
        delivery: "boundary_returned",
      }),
      observation("client_acknowledged", "2026-07-31T02:00:00.090Z", {
        settlement: "settled",
        delivery: "client_acknowledged",
      }),
    ];

    const projection = projectMcpAttemptObservations(events);
    const replay = projectMcpAttemptObservations(events);

    expect(projection.projectionFingerprint).toBe(replay.projectionFingerprint);
    expect(projection).toMatchObject({
      eventCount: 10,
      acceptedAt: "2026-07-31T02:00:00.000Z",
      lastObservedAt: "2026-07-31T02:00:00.090Z",
      latestTransition: "client_acknowledged",
      settlement: "settled",
      delivery: "client_acknowledged",
      executionStartedAt: "2026-07-31T02:00:00.050Z",
      settledAt: "2026-07-31T02:00:00.060Z",
      responseSerializedAt: "2026-07-31T02:00:00.070Z",
      boundaryReturnedAt: "2026-07-31T02:00:00.080Z",
      clientAcknowledgedAt: "2026-07-31T02:00:00.090Z",
      reconciledAt: null,
      lastFailureStage: null,
      containsPrivateContent: false,
    });
    expect(projection.observationIds).toEqual(
      events.map((event) => event.observationId),
    );
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.observationIds)).toBe(true);
  });

  test("records known terminal failures and ambiguous reconciliation", () => {
    const rejected = projectMcpAttemptObservations([
      observation("request_accepted", "2026-07-31T02:01:00.000Z"),
      observation("failed", "2026-07-31T02:01:00.010Z", {
        failureStage: "authentication",
        settlement: "settled",
      }),
    ]);
    expect(rejected).toMatchObject({
      settlement: "settled",
      delivery: "unknown",
      settledAt: "2026-07-31T02:01:00.010Z",
      executionStartedAt: null,
      lastFailureStage: "authentication",
    });

    const reconciled = projectMcpAttemptObservations([
      observation("request_accepted", "2026-07-31T02:02:00.000Z"),
      observation("execution_started", "2026-07-31T02:02:00.010Z"),
      observation("failed", "2026-07-31T02:02:00.020Z", {
        failureStage: "request_execution",
        settlement: "ambiguous",
      }),
      observation("reconciled", "2026-07-31T02:02:00.030Z", {
        settlement: "reconciled",
      }),
    ]);
    expect(reconciled).toMatchObject({
      settlement: "reconciled",
      delivery: "unknown",
      settledAt: null,
      reconciledAt: "2026-07-31T02:02:00.030Z",
      lastFailureStage: "request_execution",
      boundaryReturnedAt: null,
      clientAcknowledgedAt: null,
    });
  });

  test("rejects non-canonical identities, timestamps, and event evidence", () => {
    expect(() => observation("request_accepted", "2026-07-31T02:00:00Z"))
      .toThrow("canonical UTC timestamp");
    expect(() => createMcpAttemptObservation({
      ...baseInput,
      requestId: " padded ",
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
    })).toThrow("MCP request ID is invalid");
    expect(() => createMcpAttemptObservation({
      ...baseInput,
      requestId: "github_pat_private123",
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
    })).toThrow("MCP request ID is invalid");
    expect(() => createMcpAttemptObservation({
      ...baseInput,
      manifestFingerprint: `sha256:${"A".repeat(64)}`,
      transition: "request_accepted",
      occurredAt: "2026-07-31T02:00:00.000Z",
    })).toThrow("lowercase SHA-256");
    expect(() => observation("failed", "2026-07-31T02:00:00.000Z"))
      .toThrow("requires a failure stage");
    expect(() => observation("execution_started", "2026-07-31T02:00:00.000Z", {
      failureStage: "request_execution",
    })).toThrow("allowed only on failed observations");
    expect(() => observation("request_accepted", "2026-07-31T02:00:00.000Z", {
      settlement: "settled",
    })).toThrow("must begin with unsettled");
    expect(() => observation("execution_settled", "2026-07-31T02:00:00.000Z"))
      .toThrow("requires settled knowledge");
    expect(() => observation("response_serialized", "2026-07-31T02:00:00.000Z", {
      settlement: "settled",
      delivery: "boundary_returned",
    })).toThrow("cannot claim delivery");
    expect(() => observation("boundary_returned", "2026-07-31T02:00:00.000Z", {
      settlement: "settled",
    })).toThrow("requires boundary-returned knowledge");
    expect(() => observation("client_acknowledged", "2026-07-31T02:00:00.000Z", {
      settlement: "settled",
      delivery: "boundary_returned",
    })).toThrow("requires client-acknowledged knowledge");
    expect(() => observation("reconciled", "2026-07-31T02:00:00.000Z"))
      .toThrow("requires reconciled knowledge");
  });

  test("rejects direct and namespaced credential-shaped identities on creation and re-admission", () => {
    const secretShapedIdentities = [
      "github_pat_private123",
      "attempt:github_pat_private123",
      "request:ghp_private123",
      "attempt:stn.tok_private123",
      "request:sk-proj-private123",
      "attempt:secret://private123",
      "request:xoxb-private123",
    ];
    for (const value of secretShapedIdentities) {
      expect(() => createMcpAttemptObservation({
        ...baseInput,
        requestId: value,
        transition: "request_accepted",
        occurredAt: "2026-07-31T02:00:00.000Z",
      })).toThrow("MCP request ID is invalid");
    }

    const accepted = observation(
      "request_accepted",
      "2026-07-31T02:00:00.000Z",
    );
    for (const requestId of secretShapedIdentities) {
      const replay = {
        ...accepted,
        requestId,
      } as unknown as McpAttemptObservationV1;
      let replayError: unknown;
      try {
        projectMcpAttemptObservations([replay]);
      } catch (error) {
        replayError = error;
      }
      expect(replayError).toBeInstanceOf(RangeError);
      expect((replayError as Error).message).toBe("MCP request ID is invalid");
      expect((replayError as Error).message).not.toContain(requestId);
    }
  });

  test("requires explicit transitions for knowledge advances", () => {
    const accepted = observation(
      "request_accepted",
      "2026-07-31T02:03:00.000Z",
    );
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("authentication_completed", "2026-07-31T02:03:00.010Z", {
        settlement: "ambiguous",
      }),
    ])).toThrow("ambiguous settlement requires a failed transition");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("authentication_completed", "2026-07-31T02:03:00.010Z", {
        settlement: "settled",
      }),
    ])).toThrow("settled knowledge requires settlement evidence");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("failed", "2026-07-31T02:03:00.010Z", {
        failureStage: "request_execution",
        settlement: "reconciled",
      }),
    ])).toThrow("reconciled knowledge requires a reconciled transition");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("failed", "2026-07-31T02:03:00.010Z", {
        failureStage: "request_execution",
        settlement: "ambiguous",
        delivery: "boundary_returned",
      }),
    ])).toThrow("requires a boundary-returned transition");

    const failed = observation("failed", "2026-07-31T02:03:00.010Z", {
      failureStage: "request_execution",
      settlement: "ambiguous",
    });
    const returned = observation(
      "boundary_returned",
      "2026-07-31T02:03:00.020Z",
      { settlement: "ambiguous", delivery: "boundary_returned" },
    );
    expect(() => projectMcpAttemptObservations([
      accepted,
      failed,
      returned,
      observation("failed", "2026-07-31T02:03:00.030Z", {
        failureStage: "request_execution",
        settlement: "ambiguous",
        delivery: "client_acknowledged",
      }),
    ])).toThrow("requires a client-acknowledged transition");
  });

  test("rejects mixed, regressing, repeated, and impossible projections", () => {
    const accepted = observation(
      "request_accepted",
      "2026-07-31T02:04:00.000Z",
    );
    const started = observation(
      "execution_started",
      "2026-07-31T02:04:00.010Z",
    );
    const settled = observation(
      "execution_settled",
      "2026-07-31T02:04:00.020Z",
      { settlement: "settled" },
    );
    const returned = observation(
      "boundary_returned",
      "2026-07-31T02:04:00.030Z",
      { settlement: "settled", delivery: "boundary_returned" },
    );

    expect(() => projectMcpAttemptObservations([])).toThrow("at least one");
    expect(() => projectMcpAttemptObservations([started])).toThrow(
      "must begin with request_accepted",
    );
    expect(() => projectMcpAttemptObservations([accepted, accepted])).toThrow(
      "duplicate observation",
    );
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("execution_started", "2026-07-31T02:04:00.010Z", {
        requestId: "request-490-b",
      }),
    ])).toThrow("mixes observation identities");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("execution_started", "2026-07-31T02:03:59.999Z"),
    ])).toThrow("time moved backwards");
    expect(() => projectMcpAttemptObservations([
      accepted,
      started,
      settled,
      observation("failed", "2026-07-31T02:04:00.030Z", {
        failureStage: "request_execution",
        settlement: "ambiguous",
      }),
    ])).toThrow("settlement knowledge regressed");
    expect(() => projectMcpAttemptObservations([
      accepted,
      started,
      settled,
      returned,
      observation("reconciled", "2026-07-31T02:04:00.040Z", {
        settlement: "reconciled",
        delivery: "unknown",
      }),
    ])).toThrow("delivery knowledge regressed");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("client_acknowledged", "2026-07-31T02:04:00.010Z", {
        delivery: "client_acknowledged",
      }),
    ])).toThrow("requires prior boundary-returned evidence");
    expect(() => projectMcpAttemptObservations([
      accepted,
      observation("execution_settled", "2026-07-31T02:04:00.010Z", {
        settlement: "settled",
      }),
    ])).toThrow("settled before execution started");
    expect(() => projectMcpAttemptObservations([
      accepted,
      started,
      observation("authentication_completed", "2026-07-31T02:04:00.020Z"),
    ])).toThrow("transition moved backwards");
    expect(() => projectMcpAttemptObservations([
      accepted,
      started,
      observation("execution_started", "2026-07-31T02:04:00.020Z"),
    ])).toThrow("repeats execution_started");
  });

  test("re-admits observations and rejects fingerprint or array decoration", () => {
    const accepted = observation(
      "request_accepted",
      "2026-07-31T02:05:00.000Z",
    );
    const altered = {
      ...accepted,
      requestId: "request-490-b",
    } as unknown as McpAttemptObservationV1;
    expect(() => projectMcpAttemptObservations([altered])).toThrow(
      "fingerprint does not match content",
    );

    const decorated = [accepted] as McpAttemptObservationV1[] & {
      privatePayload?: string;
    };
    decorated.privatePayload = "secret";
    expect(() => projectMcpAttemptObservations(decorated)).toThrow(
      "contains unsupported fields",
    );

    const outOfRangeData = [accepted];
    Object.defineProperty(outOfRangeData, "4294967295", {
      enumerable: false,
      configurable: true,
      value: "private payload",
    });
    expect(() => projectMcpAttemptObservations(outOfRangeData)).toThrow(
      "contains unsupported fields",
    );

    let outOfRangeAccessorReads = 0;
    const outOfRangeAccessor = [accepted];
    Object.defineProperty(outOfRangeAccessor, "4294967295", {
      enumerable: false,
      configurable: true,
      get() {
        outOfRangeAccessorReads += 1;
        return "private payload";
      },
    });
    expect(() => projectMcpAttemptObservations(outOfRangeAccessor)).toThrow(
      "contains unsupported fields",
    );
    expect(outOfRangeAccessorReads).toBe(0);

    const sparse = new Array<McpAttemptObservationV1>(2);
    sparse[1] = accepted;
    expect(() => projectMcpAttemptObservations(sparse)).toThrow(
      "dense data array",
    );
  });
});
