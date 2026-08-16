import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.js";
import {
  ConvexProjectActivityOrchestratorSource,
  type ProjectActivityConvexCaller,
} from "../src/convex-project-activity-source.js";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.js";

function activity(project = "stensibly", workspace = "default") {
  return compileOrchestratorActivityObservation({
    workspace,
    project,
    actorId: "agent_keel",
    sourceClass: "ledger_event",
    sourceId: "evt_recent_activity",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-08-16T10:20:00.000Z",
    activityClass: "handoff",
    activityState: "observed",
    workItemId: "issue:1586",
    relatedEvidenceIds: ["evt_recent_activity"],
  });
}

describe("Convex Project Activity orchestrator source", () => {
  test("queries the recent durable window and admits canonical observations", async () => {
    const calls: Record<string, unknown>[] = [];
    const observation = activity();
    const client: ProjectActivityConvexCaller = {
      async query(_reference, args) {
        calls.push(args);
        return {
          observations: [{
            appendOrder: 41,
            observationJson: stableJson(observation),
          }],
          truncated: true,
        };
      },
    };
    const source = new ConvexProjectActivityOrchestratorSource({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    const result = await source.listRecent({ project: "stensibly", limit: 12 });
    expect(result.orchestrator).toEqual([observation]);
    expect(result.orchestratorTruncated).toBe(true);
    expect(calls).toEqual([{
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
      limit: 12,
    }]);
  });

  test("rejects durable observations that escape configured workspace or project scope", async () => {
    const foreign = activity("elsewhere");
    const client: ProjectActivityConvexCaller = {
      async query() {
        return {
          observations: [{ appendOrder: 7, observationJson: stableJson(foreign) }],
          truncated: false,
        };
      },
    };
    const source = new ConvexProjectActivityOrchestratorSource({
      client,
      serviceSecret: "service-secret",
    });
    await expect(source.listRecent({ project: "stensibly", limit: 12 }))
      .rejects.toThrow("escaped source scope");
  });

  test("rejects an oversized read before calling Convex", async () => {
    let calls = 0;
    const client: ProjectActivityConvexCaller = {
      async query() {
        calls += 1;
        return { observations: [], truncated: false };
      },
    };
    const source = new ConvexProjectActivityOrchestratorSource({
      client,
      serviceSecret: "service-secret",
    });
    await expect(source.listRecent({ project: "stensibly", limit: 51 }))
      .rejects.toThrow("source limit");
    expect(calls).toBe(0);
  });
});
