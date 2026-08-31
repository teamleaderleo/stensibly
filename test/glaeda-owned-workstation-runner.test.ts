import { describe, expect, test } from "bun:test";
import type { GlaedaCanaryProcessV1 } from "../src/glaeda-github-canary-client.ts";
import { executeGlaedaOwnedWorkstationRunV1 } from "../src/glaeda-owned-workstation-runner.ts";
import { runnerAdapterCommandOutcomeSha256 } from "../src/runner-adapter-command-contracts.ts";
import { RunnerMcpHttpClient } from "../src/runner-mcp-http-client.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const profileGeneration = sha("a");
const requestDigest = sha("b");
const runtimeDigest = sha("c");
const requestId = "owned-workstation-20260831030000";
const requestCommitOid = "1".repeat(40);
const sourceCommitOid = "2".repeat(40);
const sourceTreeOid = "3".repeat(40);
const actorId = "service:big-red-glaeda";

describe("owned Glaeda workstation runner", () => {
  test("claims one exact run, fences physical dispatch, settles, and succeeds with a bounded ref", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`,
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer stn\./);
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        calls.push(body.params);
        return toolResponse(body.id, responseFor(body.params.name, body.params.arguments));
      },
    });
    const result = await executeGlaedaOwnedWorkstationRunV1({
      runner: client,
      project: "stensibly",
      runId: "run-owned-workstation-1",
      profileGeneration,
      canaryScriptPath: "/home/leo/Projects/glaeda-dispatch/big_red_canary.py",
      node: {
        id: "big-red",
        generation: 7,
        capabilitySnapshotSha256: sha("d"),
        osClass: "linux",
        architectureClass: "x86_64",
        glaedaRuntimeSha256: runtimeDigest,
      },
      canaryProcess,
    });

    expect(calls.map((call) => call.name)).toEqual([
      "claim_runner_work",
      "transition_runner_run",
      "reserve_workstation_adapter_command",
      "settle_runner_adapter_command",
      "transition_runner_run",
    ]);
    expect(calls[0]!.arguments).toMatchObject({
      runId: "run-owned-workstation-1",
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: profileGeneration,
      project: "stensibly",
    });
    expect(calls[2]!.arguments).toMatchObject({
      itemClaimGeneration: 4,
      authorityHolderId: actorId,
      authorityExpiresAt: "2026-08-31T06:00:00.000Z",
      adapterId: "glaeda-workstation",
      profileId: "repo-query/v1",
      profileVersion: profileGeneration,
    });
    expect(calls[3]!.arguments).toMatchObject({
      project: "stensibly",
      outcome: {
        kind: "bounded_episode_completed",
        latestCheckpointSha256: sha("e"),
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      runId: "run-owned-workstation-1",
      itemId: "item-owned-workstation-1",
      resultSha256: sha("e"),
      resultBytes: 2628,
      resultRef: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${"6".repeat(40)}`,
      runStatus: "succeeded",
    });
  });

  test("restarts after physical result publication and reconciles without redispatch", async () => {
    const runnerCalls: string[] = [];
    const canaryActions: string[] = [];
    let reservedCommand: Record<string, unknown> | null = null;
    let settlementAttempts = 0;
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"2".repeat(32)}.${"B".repeat(43)}`,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        const { name, arguments: args } = body.params;
        runnerCalls.push(name);
        if (name === "reserve_workstation_adapter_command") {
          const {
            itemClaimGeneration: _itemClaimGeneration,
            authorityHolderId: _authorityHolderId,
            authorityExpiresAt: _authorityExpiresAt,
            ...command
          } = args;
          if (reservedCommand === null) {
            reservedCommand = { ...command, reservedAt: "2026-08-31T05:00:00.000Z" };
            return toolResponse(body.id, {
              outcome: "reserved",
              dispatchAuthorized: true,
              command: reservedCommand,
              settlement: null,
            });
          }
          return toolResponse(body.id, {
            outcome: "replayed",
            dispatchAuthorized: false,
            command: reservedCommand,
            settlement: null,
          });
        }
        if (name === "settle_runner_adapter_command") {
          settlementAttempts += 1;
          if (settlementAttempts === 1) {
            throw new Error("simulated response loss after physical publication");
          }
        }
        return toolResponse(body.id, responseFor(name, args));
      },
    });
    const process: GlaedaCanaryProcessV1 = async ({ action }) => {
      canaryActions.push(action);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(action === "observe-one" ? canaryObservation(action) : {
          action,
          elapsed_us: 2,
          outcome: "complete",
          receipt: {
            replay: action === "reconcile-one",
            request_commit_oid: requestCommitOid,
            request_id: requestId,
            result_bytes: 2628,
            result_commit_oid: "6".repeat(40),
            result_digest: sha("e"),
            schema: "glaeda-github-terminal-replay-v0",
          },
        }),
      };
    };
    const input = {
      runner: client,
      project: "stensibly",
      runId: "run-owned-workstation-1",
      profileGeneration,
      canaryScriptPath: "/home/leo/Projects/glaeda-dispatch/big_red_canary.py",
      node: {
        id: "big-red",
        generation: 7,
        capabilitySnapshotSha256: sha("d"),
        osClass: "linux" as const,
        architectureClass: "x86_64" as const,
        glaedaRuntimeSha256: runtimeDigest,
      },
      canaryProcess: process,
    };

    await expect(executeGlaedaOwnedWorkstationRunV1(input)).rejects.toThrow(
      /settle_runner_adapter_command transport failed/,
    );
    const recovered = await executeGlaedaOwnedWorkstationRunV1(input);

    expect(recovered).toMatchObject({
      outcome: "succeeded",
      resultSha256: sha("e"),
      resultRef: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${"6".repeat(40)}`,
    });
    expect(canaryActions).toEqual([
      "observe-one",
      "consume-one",
      "observe-one",
      "reconcile-one",
    ]);
    expect(canaryActions.filter((action) => action === "consume-one")).toHaveLength(1);
    expect(runnerCalls.filter((name) => name === "reserve_workstation_adapter_command")).toHaveLength(2);
    expect(settlementAttempts).toBe(2);
  });
});

function responseFor(name: string, args: Record<string, unknown>): unknown {
  if (name === "claim_runner_work") {
    return {
      run: {
        id: "run-owned-workstation-1",
        itemId: "item-owned-workstation-1",
        status: "starting",
        generation: 1,
        leaseGeneration: 2,
        leaseOwnerId: actorId,
        leaseExpiresAt: "2026-08-31T06:00:00.000Z",
        runnerType: "glaeda-workstation",
        runnerProfile: "repo-query/v1",
        runnerProfileVersion: profileGeneration,
      },
      authorityFence: {
        holderId: actorId,
        generation: 2,
        expiresAt: "2026-08-31T06:00:00.000Z",
      },
      item: {
        id: "item-owned-workstation-1",
        project: "stensibly",
        claimGeneration: 4,
        claimedBy: actorId,
      },
      context: { artifacts: [requestArtifact()] },
    };
  }
  if (name === "transition_runner_run" && args.command === "run") {
    return {
      id: "run-owned-workstation-1",
      status: "running",
      generation: 1,
      leaseGeneration: 2,
      leaseOwnerId: actorId,
      leaseExpiresAt: "2026-08-31T06:00:00.000Z",
    };
  }
  if (name === "reserve_workstation_adapter_command") {
    const {
      itemClaimGeneration: _itemClaimGeneration,
      authorityHolderId: _authorityHolderId,
      authorityExpiresAt: _authorityExpiresAt,
      ...command
    } = args;
    return {
      outcome: "reserved",
      dispatchAuthorized: true,
      command: { ...command, reservedAt: "2026-08-31T05:00:00.000Z" },
      settlement: null,
    };
  }
  if (name === "settle_runner_adapter_command") {
    const outcome = args.outcome as Parameters<typeof runnerAdapterCommandOutcomeSha256>[0];
    return {
      outcome: "settled",
      settlement: {
        commandId: args.commandId,
        commandFingerprint: args.commandFingerprint,
        outcome,
        outcomeSha256: runnerAdapterCommandOutcomeSha256(outcome),
        settledAt: "2026-08-31T05:00:02.000Z",
      },
    };
  }
  if (name === "transition_runner_run" && args.command === "succeed") {
    return {
      id: "run-owned-workstation-1",
      status: "succeeded",
      generation: 1,
      leaseGeneration: 2,
      leaseOwnerId: null,
      leaseExpiresAt: null,
    };
  }
  throw new Error(`Unexpected runner tool ${name}`);
}

const canaryProcess: GlaedaCanaryProcessV1 = async ({ action }) => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify(action === "observe-one" ? {
    action,
    elapsed_us: 1,
    outcome: "complete",
    receipt: {
      base_commit_oid: "4".repeat(40),
      max_patch_bytes: 4096,
      profile_id: "repo-query/v1",
      project_id: "github.com/teamleaderleo/glaeda",
      query_binary_sha256: runtimeDigest,
      request_bytes: 655,
      request_commit_oid: requestCommitOid,
      request_digest: requestDigest,
      request_id: requestId,
      request_tree_oid: "5".repeat(40),
      schema: "glaeda-github-request-observation-v0",
      source_commit_oid: sourceCommitOid,
      source_tree_oid: sourceTreeOid,
      transport_generation: sha("f"),
    },
  } : {
    action,
    elapsed_us: 2,
    outcome: "complete",
    receipt: {
      replay: false,
      request_commit_oid: requestCommitOid,
      request_id: requestId,
      result_bytes: 2628,
      result_commit_oid: "6".repeat(40),
      result_digest: sha("e"),
      schema: "glaeda-github-terminal-replay-v0",
    },
  }),
});

function canaryObservation(action: "observe-one") {
  return {
    action,
    elapsed_us: 1,
    outcome: "complete",
    receipt: {
      base_commit_oid: "4".repeat(40),
      max_patch_bytes: 4096,
      profile_id: "repo-query/v1",
      project_id: "github.com/teamleaderleo/glaeda",
      query_binary_sha256: runtimeDigest,
      request_bytes: 655,
      request_commit_oid: requestCommitOid,
      request_digest: requestDigest,
      request_id: requestId,
      request_tree_oid: "5".repeat(40),
      schema: "glaeda-github-request-observation-v0",
      source_commit_oid: sourceCommitOid,
      source_tree_oid: sourceTreeOid,
      transport_generation: sha("f"),
    },
  };
}

function requestArtifact() {
  return {
    kind: "commit",
    uri: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${requestCommitOid}`,
    metadata: {
      schema: "glaeda-repo-query-request/v1",
      requestId,
      requestCommitOid,
      requestDigest,
      transportGeneration: sha("f"),
      profileGeneration,
      sourceRepository: "teamleaderleo/glaeda",
      sourceCommitOid,
      sourceTreeOid,
    },
  };
}

function toolResponse(id: number, value: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  });
}
