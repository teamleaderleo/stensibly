import { describe, expect, test } from "bun:test";
import {
  GlaedaGitHubCanaryClientV1,
  type GlaedaCanaryProcessV1,
} from "../src/glaeda-github-canary-client.ts";
import type { GlaedaWorkstationCommandV1 } from "../src/glaeda-workstation-contracts.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const requestId = "owned-workstation-20260831024016";
const requestCommitOid = "6".repeat(40);
const sourceCommitOid = "f".repeat(40);
const sourceTreeOid = "7".repeat(40);
const target = {
  requestId,
  requestCommitOid,
  requestSha256: sha("a"),
  transportGeneration: sha("b"),
  profileGeneration: sha("c"),
};

describe("Glaeda GitHub canary workstation client", () => {
  test("checks one exact request, executes it once, and emits a content-free bounded receipt", async () => {
    const calls: Array<{ action: string; requestId: string; requestCommitOid: string }> = [];
    const process: GlaedaCanaryProcessV1 = async (input) => {
      calls.push(input);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(input.action === "observe-one"
          ? observation()
          : terminal()),
      };
    };
    const times = [
      new Date("2026-08-31T05:00:01.000Z"),
      new Date("2026-08-31T05:00:02.000Z"),
    ];
    const client = new GlaedaGitHubCanaryClientV1({
      scriptPath: "/opt/glaeda-dispatch/big_red_canary.py",
      target,
      process,
      now: () => times.shift()!,
    });
    const checked = await client.check(command());
    const receipt = await client.execute({ command: command(), check: checked });

    expect(calls).toEqual([
      expect.objectContaining({ action: "observe-one", requestId, requestCommitOid }),
      expect.objectContaining({ action: "consume-one", requestId, requestCommitOid }),
    ]);
    expect(checked.profile).toEqual({
      id: "repo-query/v1",
      versionSha256: target.profileGeneration,
      class: "repo_query",
    });
    expect(receipt).toMatchObject({
      terminalClass: "succeeded",
      resultSha256: sha("e"),
      resultBytes: 2628,
      startedAt: "2026-08-31T05:00:01.000Z",
      settledAt: "2026-08-31T05:00:02.000Z",
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesRedispatch: false,
    });
    expect(client.terminal).toEqual({
      requestId,
      requestCommitOid,
      resultCommitOid: "9".repeat(40),
      resultSha256: sha("e"),
      resultBytes: 2628,
      replay: false,
      resultRef: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${"9".repeat(40)}`,
    });
  });

  test("reconciles an exact published result without invoking physical execution", async () => {
    const actions: string[] = [];
    const client = new GlaedaGitHubCanaryClientV1({
      scriptPath: "/opt/glaeda-dispatch/big_red_canary.py",
      target,
      process: async (input) => {
        actions.push(input.action);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(input.action === "observe-one"
            ? observation()
            : terminal("reconcile-one", true)),
        };
      },
      now: () => new Date("2026-08-31T05:01:00.000Z"),
    });
    const checked = await client.check(command());
    const receipt = await client.reconcile({ command: command(), check: checked });

    expect(actions).toEqual(["observe-one", "reconcile-one"]);
    expect(receipt).toMatchObject({
      resultSha256: sha("e"),
      startedAt: "2026-08-31T05:01:00.000Z",
      settledAt: "2026-08-31T05:01:00.000Z",
      authorizesRedispatch: false,
    });
    expect(client.terminal?.replay).toBe(true);
  });

  test("refuses profile input drift before touching the physical transport", async () => {
    let calls = 0;
    const client = new GlaedaGitHubCanaryClientV1({
      scriptPath: "/opt/glaeda-dispatch/big_red_canary.py",
      target,
      process: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    const changed = command();
    changed.profileRequestSha256 = sha("0");
    await expect(client.check(changed)).rejects.toThrow(/exact canary request/);
    expect(calls).toBe(0);
  });

  test("refuses a request observation whose exact binary or source identity drifted", async () => {
    const client = new GlaedaGitHubCanaryClientV1({
      scriptPath: "/opt/glaeda-dispatch/big_red_canary.py",
      target,
      process: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(observation({ query_binary_sha256: sha("0") })),
      }),
    });
    await expect(client.check(command())).rejects.toThrow(/exact workstation command/);
  });
});

function command(): GlaedaWorkstationCommandV1 {
  return {
    version: 1,
    project: "stensibly",
    itemId: "item-owned-workstation",
    itemClaimGeneration: 1,
    runId: "run-owned-workstation",
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      holderId: "service:big-red-glaeda",
      expiresAt: "2026-08-31T06:00:00.000Z",
    },
    commandId: "glaeda-command-owned-workstation",
    idempotencyKey: "glaeda-command-owned-workstation-1",
    node: {
      id: "big-red",
      generation: 1,
      capabilitySnapshotSha256: sha("d"),
      osClass: "linux",
      architectureClass: "x86_64",
      glaedaRuntimeSha256: sha("8"),
    },
    source: {
      repository: "teamleaderleo/glaeda",
      commitOid: sourceCommitOid,
      treeOid: sourceTreeOid,
      logicalChangeRef: `glaeda-dispatch:${requestCommitOid}`,
    },
    profile: {
      id: "repo-query/v1",
      versionSha256: target.profileGeneration,
      class: "repo_query",
      resourceClass: "interactive-small",
      deadlineSeconds: 60,
    },
    profileRequestSha256: target.requestSha256,
  };
}

function observation(changes: Record<string, unknown> = {}) {
  return {
    action: "observe-one",
    elapsed_us: 1,
    outcome: "complete",
    receipt: {
      base_commit_oid: "1".repeat(40),
      max_patch_bytes: 4096,
      profile_id: "repo-query/v1",
      project_id: "github.com/teamleaderleo/glaeda",
      query_binary_sha256: sha("8"),
      request_bytes: 655,
      request_commit_oid: requestCommitOid,
      request_digest: target.requestSha256,
      request_id: requestId,
      request_tree_oid: "2".repeat(40),
      schema: "glaeda-github-request-observation-v0",
      source_commit_oid: sourceCommitOid,
      source_tree_oid: sourceTreeOid,
      transport_generation: target.transportGeneration,
      ...changes,
    },
  };
}

function terminal(
  action: "consume-one" | "reconcile-one" = "consume-one",
  replay = false,
) {
  return {
    action,
    elapsed_us: 2,
    outcome: "complete",
    receipt: {
      replay,
      request_commit_oid: requestCommitOid,
      request_id: requestId,
      result_bytes: 2628,
      result_commit_oid: "9".repeat(40),
      result_digest: sha("e"),
      schema: "glaeda-github-terminal-replay-v0",
    },
  };
}
