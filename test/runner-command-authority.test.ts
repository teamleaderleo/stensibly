import { describe, expect, test } from "bun:test";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  assertRunnerCommandAuthorityActiveV1,
} from "../src/runner-command-authority.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";

const issuedAt = "2026-07-31T00:00:00.000Z";
const expiresAt = "2026-07-31T01:00:00.000Z";

describe("runner command execution-time authority", () => {
  test("accepts parsed start and resume commands strictly inside their authority window", () => {
    const start = startCommand();
    const resume = resumeCommand();
    const now = new Date("2026-07-31T00:30:00.000Z");

    expect(assertRunnerCommandAuthorityActiveV1(start, now)).toBe(start);
    expect(assertRunnerCommandAuthorityActiveV1(resume, now)).toBe(resume);
    expect(Object.isFrozen(start)).toBe(true);
    expect(Object.isFrozen(resume)).toBe(true);
  });

  test("accepts the exact issue time and rejects a future-issued command", () => {
    const command = startCommand();

    expect(
      assertRunnerCommandAuthorityActiveV1(command, new Date(issuedAt)),
    ).toBe(command);
    expect(() =>
      assertRunnerCommandAuthorityActiveV1(
        command,
        new Date("2026-07-30T23:59:59.999Z"),
      )
    ).toThrow("cannot execute before its issue time");
  });

  test("rejects exact expiry and later invocation", () => {
    const start = startCommand();
    const resume = resumeCommand();

    expect(() =>
      assertRunnerCommandAuthorityActiveV1(start, new Date(expiresAt))
    ).toThrow("authority expired before execution");
    expect(() =>
      assertRunnerCommandAuthorityActiveV1(
        resume,
        new Date("2026-07-31T01:00:00.001Z"),
      )
    ).toThrow("authority expired before execution");
  });

  test("rejects an invalid trusted clock without changing the parsed command", () => {
    const command = startCommand();

    expect(() =>
      assertRunnerCommandAuthorityActiveV1(command, new Date("invalid"))
    ).toThrow("requires a valid current time");
    expect(command.authority.expiresAt).toBe(expiresAt);
    expect(Object.isFrozen(command)).toBe(true);
  });
});

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-authority-start"),
    kind: "start",
  });
}

function resumeCommand(): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase("command-authority-resume"),
    kind: "resume",
    continuation: { id: "continuation-authority-1", generation: 1 },
    adapterResumeRef: null,
    checkpointRef: null,
    reason: "continuation",
  });
}

function commandBase(commandId: string) {
  const runId = "run_authority_activity";
  const itemId = "item_authority_activity";
  const project = "scrapbook";
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId: "workflow_authority_activity",
    adapterId: "authority-test-adapter",
    adapterVersion: "1.0.0",
    profileId: "authority-test-profile",
    profileVersion: "2026-07-31",
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-actor",
      generation: 1,
      expiresAt,
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove execution-time runner authority enforcement.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove execution-time runner authority enforcement.",
        summary: null,
        nextAction: "Validate the authority window before execution.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:test-authority-activity"],
    issuedAt,
  };
}
