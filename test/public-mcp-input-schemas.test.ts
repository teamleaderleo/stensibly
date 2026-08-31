import { describe, expect, test } from "bun:test";
import { expandPublicMcpInput } from "../src/public-mcp-input-schemas.ts";

describe("compact public MCP inputs", () => {
  test("compiles deterministic dispatch defaults behind the small public request", () => {
    const expanded = expandPublicMcpInput("dispatch_work", {
      project: "stensibly",
      itemId: "item-1",
      expectedClaimGeneration: 3,
      actor: { id: "agent-1", name: "Agent", kind: "agent" },
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: "sha256:abc",
      idempotencyKey: "dispatch-1",
    }) as Record<string, unknown>;

    expect(expanded).toMatchObject({
      leaseSeconds: 900,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      executionEnvelope: {
        schemaVersion: 1,
        objective: "Dispatch work item item-1 with runner profile repo-query/v1",
      },
    });
    expect(expanded).not.toHaveProperty("objective");
  });

  test("supplies empty artifact metadata without advertising its storage schema", () => {
    expect(expandPublicMcpInput("attach_artifact", { id: "item-1" }))
      .toEqual({ id: "item-1", metadata: {} });
  });
});
