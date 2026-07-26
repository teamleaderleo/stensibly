import { describe, expect, test } from "bun:test";
import {
  buildWorkerEnrolmentRequest,
  type WorkerEnrolmentRequestInput,
} from "../src/worker-enrolment.ts";

const completeInput: WorkerEnrolmentRequestInput = {
  adapter: " Generic-MCP ",
  profile: "Codex-Default",
  workerSessionId: " session_ABC-01 ",
  callsign: "  Nightjar  ",
  capabilities: ["repository-read", "Pull-Request-Review"],
  toolAllowlist: ["github.review", "GitHub.Fetch"],
  projectScope: ["stensibly", "SmolRunner"],
  preferredStances: ["integration", "Independent-Review"],
  startedAt: "2026-07-27T00:00:00Z",
  expiresAt: "2026-07-27T02:00:00.000Z",
  heartbeatSeconds: 300,
  correlationId: " corr_01 ",
  causationId: " cause_01 ",
};

describe("worker enrolment request contract", () => {
  test("builds one deterministic canonical request and replay fingerprint", () => {
    expect(buildWorkerEnrolmentRequest(completeInput)).toEqual({
      version: 1,
      adapter: "generic-mcp",
      profile: "codex-default",
      workerSessionId: "session_ABC-01",
      callsign: "Nightjar",
      capabilities: ["pull-request-review", "repository-read"],
      toolAllowlist: ["github.fetch", "github.review"],
      projectScope: ["smolrunner", "stensibly"],
      preferredStances: ["independent-review", "integration"],
      startedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-07-27T02:00:00.000Z",
      heartbeatSeconds: 300,
      correlationId: "corr_01",
      causationId: "cause_01",
      grantsAuthority: false,
      fingerprint: "sha256:70b7f47ffa4e136ae6515bc8d38760f134115db07ea1db98ea961141a34e17d5",
    });
  });

  test("makes set ordering irrelevant to exact replay identity", () => {
    const first = buildWorkerEnrolmentRequest(completeInput);
    const reordered = buildWorkerEnrolmentRequest({
      ...completeInput,
      capabilities: [...completeInput.capabilities].reverse(),
      toolAllowlist: [...(completeInput.toolAllowlist ?? [])].reverse(),
      projectScope: [...completeInput.projectScope].reverse(),
      preferredStances: [...(completeInput.preferredStances ?? [])].reverse(),
    });

    expect(reordered).toEqual(first);
  });

  test("uses locale-independent code-point ordering", () => {
    const request = buildWorkerEnrolmentRequest({
      ...completeInput,
      toolAllowlist: ["github:write", "github.read", "github-review"],
    });

    expect(request.toolAllowlist).toEqual([
      "github-review",
      "github.read",
      "github:write",
    ]);
  });

  test("changes replay identity when any material field changes", () => {
    const first = buildWorkerEnrolmentRequest(completeInput);
    for (const changed of [
      { ...completeInput, profile: "codex-review" },
      { ...completeInput, callsign: "Kestrel" },
      { ...completeInput, heartbeatSeconds: 301 },
      { ...completeInput, expiresAt: "2026-07-27T02:00:01.000Z" },
      { ...completeInput, capabilities: [...completeInput.capabilities, "artifact-read"] },
      { ...completeInput, projectScope: [...completeInput.projectScope, "renderprove"] },
    ]) {
      expect(buildWorkerEnrolmentRequest(changed).fingerprint).not.toBe(first.fingerprint);
    }
  });

  test("supports a minimal bounded request without descriptive metadata", () => {
    const request = buildWorkerEnrolmentRequest({
      adapter: "generic-mcp",
      profile: "default",
      workerSessionId: "session_01",
      capabilities: ["repository-read"],
      projectScope: ["stensibly"],
      startedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-07-27T00:01:00.000Z",
      heartbeatSeconds: 60,
    });

    expect(request.callsign).toBeNull();
    expect(request.toolAllowlist).toEqual([]);
    expect(request.preferredStances).toEqual([]);
    expect(request.correlationId).toBeNull();
    expect(request.causationId).toBeNull();
    expect(request.grantsAuthority).toBe(false);
    expect(request.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects duplicate normalized set entries", () => {
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      capabilities: ["Review", " review "],
    })).toThrow("Capability list contains duplicate entries");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      projectScope: ["Stensibly", "stensibly"],
    })).toThrow("Project list contains duplicate entries");
  });

  test("rejects malformed identities, slugs, controls, and list bounds", () => {
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      workerSessionId: "session/unsafe",
    })).toThrow("Worker session ID contains unsupported characters");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      adapter: "generic mcp",
    })).toThrow("Runner adapter must be a lowercase slug");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      callsign: "Nightjar\n",
    })).toThrow("Worker callsign contains unsupported control characters");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      correlationId: "corr_01\u202e",
    })).toThrow("Correlation ID contains unsupported control characters");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      capabilities: [],
    })).toThrow("Capability list must contain 1 to 32 entries");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      toolAllowlist: Array.from({ length: 101 }, (_, index) => `tool-${index}`),
    })).toThrow("Tool list must contain 0 to 100 entries");
  });

  test("rejects malformed calendar times and invalid heartbeat lifetimes", () => {
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      startedAt: "2026-02-30T00:00:00Z",
    })).toThrow("Enrolment start must be a valid calendar timestamp");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      expiresAt: "2026-07-26T23:59:59.000Z",
    })).toThrow("Enrolment expiry must be later than start");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      heartbeatSeconds: 29,
    })).toThrow("Heartbeat interval must be an integer from 30 to 86400 seconds");
    expect(() => buildWorkerEnrolmentRequest({
      ...completeInput,
      expiresAt: "2026-07-27T00:04:59.000Z",
      heartbeatSeconds: 300,
    })).toThrow("Enrolment lifetime must include at least one heartbeat interval");
  });
});
