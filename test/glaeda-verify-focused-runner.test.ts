import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintGlaedaCapabilitySnapshotV1,
  GLAEDA_CAPABILITY_ARTIFACT_SCHEMA,
} from "../src/glaeda-owned-workstation-capability.ts";
import {
  executeGlaedaVerifyFocusedRunV1,
  executeGlaedaVerifyRequiredRunV1,
} from "../src/glaeda-verify-focused-runner.ts";
import {
  fingerprintGlaedaVerifyFocusedRequestV1,
  fingerprintGlaedaVerifyFocusedRuntimeV1,
  type GlaedaVerifyFocusedRequestV1,
} from "../src/glaeda-verify-focused-workstation-client.ts";
import { runnerAdapterCommandOutcomeSha256 } from
  "../src/runner-adapter-command-contracts.ts";
import { RunnerMcpHttpClient } from "../src/runner-mcp-http-client.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const actorId = "service:big-red-glaeda";
const now = () => new Date("2026-08-31T05:00:00.000Z");

describe("Glaeda verify-focused one-shot runner", () => {
  test("claims verify-required only through its exact named runner profile", async () => {
    const fixture = files();
    const runtime = fingerprintGlaedaVerifyFocusedRuntimeV1(fixture.script, fixture.implementation);
    let claim: Record<string, unknown> | null = null;
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        expect(body.params.name).toBe("claim_runner_work");
        claim = body.params.arguments;
        return toolResponse(body.id, null);
      },
    });
    expect(await executeGlaedaVerifyRequiredRunV1({
      runner: client,
      project: "glaeda",
      runId: "run-required-1",
      profileGeneration: sha("a"),
      pythonInterpreterPath: fixture.python,
      verifyScriptPath: fixture.script,
      verifyImplementationPath: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node: {
        id: "big-red", generation: 1, osClass: "linux", architectureClass: "x86_64",
        glaedaRuntimeSha256: runtime,
      },
    })).toEqual({ outcome: "idle" });
    expect(claim).toMatchObject({
      runnerProfile: "verify-required/v1",
      runnerProfileVersion: sha("a"),
      project: "glaeda",
      runId: "run-required-1",
      leaseSeconds: 1500,
    });
  });

  test("refuses a verify-required lease that cannot cover execution and settlement", async () => {
    const fixture = files();
    const runtime = fingerprintGlaedaVerifyFocusedRuntimeV1(fixture.script, fixture.implementation);
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`,
      fetch: async () => { throw new Error("runner must not be called"); },
    });
    await expect(executeGlaedaVerifyRequiredRunV1({
      runner: client,
      project: "glaeda",
      runId: "run-required-short-lease",
      profileGeneration: sha("a"),
      pythonInterpreterPath: fixture.python,
      verifyScriptPath: fixture.script,
      verifyImplementationPath: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node: {
        id: "big-red", generation: 1, osClass: "linux", architectureClass: "x86_64",
        glaedaRuntimeSha256: runtime,
      },
      leaseSeconds: 1200,
    })).rejects.toThrow(/outlive its physical deadline/);
  });

  test("recovers a lost settlement response from the Glaeda receipt without reexecution", async () => {
    const fixture = files();
    const request = focusedRequest();
    const runtime = fingerprintGlaedaVerifyFocusedRuntimeV1(fixture.script, fixture.implementation);
    const calls: string[] = [];
    const physicalCalls: string[][] = [];
    let reservation: Record<string, unknown> | null = null;
    let settlementAttempts = 0;
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        const { name, arguments: args } = body.params;
        calls.push(name);
        if (name === "reserve_workstation_adapter_command") {
          const {
            itemClaimGeneration: _itemClaimGeneration,
            authorityHolderId: _authorityHolderId,
            authorityExpiresAt: _authorityExpiresAt,
            ...command
          } = args;
          if (reservation === null) {
            reservation = { ...command, reservedAt: "2026-08-31T05:00:00.000Z" };
            return toolResponse(body.id, {
              outcome: "reserved", dispatchAuthorized: true, command: reservation, settlement: null,
            });
          }
          return toolResponse(body.id, {
            outcome: "replayed", dispatchAuthorized: false, command: reservation, settlement: null,
          });
        }
        if (name === "settle_runner_adapter_command") {
          settlementAttempts += 1;
          if (settlementAttempts === 1) throw new Error("lost settlement response");
        }
        return toolResponse(body.id, responseFor(name, args, request, runtime));
      },
    });
    const input = {
      runner: client,
      project: "glaeda",
      runId: "run-focused-1",
      profileGeneration: request.profileVersionSha256,
      pythonInterpreterPath: fixture.python,
      verifyScriptPath: fixture.script,
      verifyImplementationPath: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node: {
        id: "big-red",
        generation: 1,
        osClass: "linux" as const,
        architectureClass: "x86_64" as const,
        glaedaRuntimeSha256: runtime,
      },
      inspectPythonInterpreter: async () => ({
        executableSha256: sha("9"), path: fixture.python, version: "3.14.4",
      }),
      now,
      process: (processInput: { arguments: string[] }) => {
        physicalCalls.push(processInput.arguments);
        const fingerprint = valueAfter(processInput.arguments, "--command-fingerprint");
        const report = physicalReport(request, fingerprint);
        return {
          status: 0,
          stdout: new TextEncoder().encode(`${JSON.stringify(report)}\n`),
          stderr: new Uint8Array(),
        };
      },
    };

    await expect(executeGlaedaVerifyFocusedRunV1(input)).rejects.toThrow(/transport failed/);
    const recovered = await executeGlaedaVerifyFocusedRunV1(input);

    expect(recovered).toMatchObject({ outcome: "succeeded", runStatus: "succeeded" });
    expect(physicalCalls).toHaveLength(2);
    expect(physicalCalls[0]).not.toContain("--reconcile-only");
    expect(physicalCalls[1]!.at(-1)).toBe("--reconcile-only");
    expect(settlementAttempts).toBe(2);
    expect(calls.filter((name) => name === "reserve_workstation_adapter_command")).toHaveLength(2);
  });

  test("blocks and releases a claim when credentialless admission refuses", async () => {
    const fixture = files();
    const request = focusedRequest();
    const runtime = fingerprintGlaedaVerifyFocusedRuntimeV1(fixture.script, fixture.implementation);
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token: `stn.tok_${"2".repeat(32)}.${"B".repeat(43)}`,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        calls.push(body.params);
        return toolResponse(body.id, responseFor(body.params.name, body.params.arguments, request, runtime));
      },
    });

    await expect(executeGlaedaVerifyFocusedRunV1({
      runner: client,
      project: "glaeda",
      runId: "run-focused-1",
      profileGeneration: request.profileVersionSha256,
      pythonInterpreterPath: fixture.python,
      verifyScriptPath: fixture.script,
      verifyImplementationPath: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node: {
        id: "big-red", generation: 1, osClass: "linux", architectureClass: "x86_64",
        glaedaRuntimeSha256: runtime,
      },
      inspectPythonInterpreter: async () => ({
        executableSha256: sha("9"), path: fixture.python, version: "3.14.5",
      }),
      now,
    })).rejects.toThrow(/Python runtime changed/);

    expect(calls.map((call) => call.name)).toEqual([
      "claim_runner_work",
      "transition_runner_run",
    ]);
    expect(calls[1]!.arguments).toMatchObject({
      command: "block",
      expectedGeneration: 1,
      expectedLeaseGeneration: 2,
      checkpoint: "Credentialless verify-focused/v1 admission refused before physical dispatch.",
    });
  });
});

function responseFor(
  name: string,
  args: Record<string, unknown>,
  request: GlaedaVerifyFocusedRequestV1,
  runtime: string,
) {
  if (name === "claim_runner_work") {
    return {
      run: {
        id: "run-focused-1", itemId: "item-focused-1", status: "starting", generation: 1,
        leaseGeneration: 2, leaseOwnerId: actorId,
        leaseExpiresAt: "2026-08-31T06:00:00.000Z", runnerType: "glaeda-workstation",
        runnerProfile: "verify-focused/v1", runnerProfileVersion: request.profileVersionSha256,
      },
      authorityFence: { holderId: actorId, generation: 2, expiresAt: "2026-08-31T06:00:00.000Z" },
      item: { id: "item-focused-1", project: "glaeda", claimGeneration: 4, claimedBy: actorId },
      context: { artifacts: [requestArtifact(request), capabilityArtifact(request, runtime)] },
    };
  }
  if (name === "transition_runner_run" && args.command === "run") {
    return {
      id: "run-focused-1", status: "running", generation: 1, leaseGeneration: 2,
      leaseOwnerId: actorId, leaseExpiresAt: "2026-08-31T06:00:00.000Z",
    };
  }
  if (name === "transition_runner_run" && args.command === "block") {
    return {
      id: "run-focused-1", status: "blocked", generation: 2, leaseGeneration: 2,
      leaseOwnerId: null, leaseExpiresAt: null,
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
        settledAt: "2026-08-31T05:01:00.000Z",
      },
    };
  }
  if (name === "transition_runner_run" && args.command === "succeed") {
    return {
      id: "run-focused-1", status: "succeeded", generation: 2, leaseGeneration: 2,
      leaseOwnerId: null, leaseExpiresAt: null,
    };
  }
  throw new Error(`Unexpected tool ${name}`);
}

function focusedRequest(): GlaedaVerifyFocusedRequestV1 {
  return {
    version: 1,
    repository: "teamleaderleo/glaeda",
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    profileVersionSha256: sha("a"),
    resourceClass: "big-red-focused",
    deadlineSeconds: 600,
    executionIdentityClass: "credentialless_project",
  };
}

function requestArtifact(request: GlaedaVerifyFocusedRequestV1) {
  return {
    kind: "commit",
    uri: `https://github.com/${request.repository}/commit/${request.commitOid}`,
    metadata: {
      schema: "glaeda-verify-focused-request/v1",
      requestId: "verify-focused-20260831",
      repository: request.repository,
      commitOid: request.commitOid,
      treeOid: request.treeOid,
      profileVersionSha256: request.profileVersionSha256,
      resourceClass: request.resourceClass,
      deadlineSeconds: request.deadlineSeconds,
      executionIdentityClass: request.executionIdentityClass,
      requestSha256: fingerprintGlaedaVerifyFocusedRequestV1(request),
    },
  };
}

function capabilityArtifact(request: GlaedaVerifyFocusedRequestV1, runtime: string) {
  const snapshot = {
    admission: {
      activeWorkloadsClass: "unobserved", availabilityClass: "available", pressureClass: "unobserved",
    },
    advisoryOnly: true,
    authorizesDispatch: false,
    authorizesExecution: false,
    expiresAt: "2026-08-31T05:03:00.000Z",
    node: { architectureClass: "x86_64", generation: 1, id: "big-red", osClass: "linux" },
    observedAt: "2026-08-31T05:00:00.000Z",
    producer: {
      glaedaRuntimeSha256: runtime,
      python: { executableSha256: sha("9"), version: "3.14.4" },
      workspaceCapabilitySha256: sha("7"),
    },
    profiles: [{
      class: "verify_focused", id: "verify-focused/v1", versionSha256: request.profileVersionSha256,
    }],
    projects: [{
      heatClass: "resident_hot",
      repository: request.repository,
      source: { commitOid: request.commitOid, treeOid: request.treeOid },
      sourceObjectClass: "exact_commit_and_tree_present",
      verificationProfiles: ["verify-focused/v1"],
    }],
    schema: "glaeda-owned-workstation-capability/v1",
  };
  const snapshotSha256 = fingerprintGlaedaCapabilitySnapshotV1(snapshot);
  return {
    kind: "other",
    uri: `urn:stensibly:glaeda-capability:${snapshotSha256}`,
    metadata: { schema: GLAEDA_CAPABILITY_ARTIFACT_SCHEMA, snapshot, snapshotSha256 },
  };
}

function physicalReport(request: GlaedaVerifyFocusedRequestV1, fingerprint: string) {
  return {
    authority: "physical_execution_observation",
    authorizes_effects: false,
    authorizes_redispatch: false,
    authorizes_work: false,
    command_fingerprint: fingerprint,
    contains_credentials: false,
    contains_private_content: false,
    document_type: "glaeda-verify-focused-receipt",
    execution_identity_class: "credentialless_project",
    isolation: {
      ambient_environment: "cleared", build_state: "task_private_tmpfs",
      filesystem: "read_only_source_task_private_tmpfs",
      package_cache: "host_public_crates_io_read_only",
      network: "none", publisher_credentials: "absent", control_credentials: "absent",
      ssh_agent: "absent", sudo_admin: "absent", unrelated_writable_projects: "absent",
    },
    profile: {
      id: "verify-focused/v1", class: "verify_focused",
      generation: request.profileVersionSha256, resource_class: request.resourceClass,
      deadline_seconds: request.deadlineSeconds,
    },
    result: {
      cpu_seconds: null, elapsed_seconds: 1, exit_code: 0, max_rss_kib: null,
      output_bytes: 0, output_sha256: sha("0"), raw_output: "not_published",
      resource_accounting: "cgroup_enforced_metrics_not_exported_v1",
      terminal_class: "succeeded", started_at_unix_millis: 1_788_150_000_000,
      settled_at_unix_millis: 1_788_150_001_000, process_tree_settled: true,
      task_cleanup_complete: true,
    },
    schema_version: 1,
    source: { repository: request.repository, commit: request.commitOid, tree: request.treeOid },
  };
}

function valueAfter(values: string[], key: string): string {
  const index = values.indexOf(key);
  if (index < 0 || !values[index + 1]) throw new Error(`Missing ${key}`);
  return values[index + 1]!;
}

function files() {
  const root = mkdtempSync(join(tmpdir(), "stensibly-focused-runner-"));
  const result: Record<string, string> = {};
  for (const name of ["repository", "cargo", "rustup"]) {
    const path = join(root, name); mkdirSync(path); result[name] = path;
  }
  result.state = join(root, "state");
  for (const name of ["python", "script", "implementation"]) {
    const path = join(root, name); writeFileSync(path, name, { mode: 0o700 }); result[name] = path;
  }
  return result as {
    repository: string; cargo: string; rustup: string; state: string;
    python: string; script: string; implementation: string;
  };
}

function toolResponse(id: number, value: unknown): Response {
  return Response.json({
    jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] },
  });
}
