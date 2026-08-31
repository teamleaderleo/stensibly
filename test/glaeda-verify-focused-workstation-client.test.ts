import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintGlaedaVerifyFocusedRequestV1,
  fingerprintGlaedaVerifyFocusedRuntimeV1,
  GlaedaVerifyFocusedWorkstationClientV1,
  type GlaedaVerifyFocusedRequestV1,
} from "../src/glaeda-verify-focused-workstation-client.ts";
import { fingerprintGlaedaWorkstationCommandV1 } from
  "../src/glaeda-workstation-contracts.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;

describe("Glaeda verify-focused workstation client", () => {
  test("binds a fixed credentialless profile and admits its compact physical receipt", async () => {
    const fixture = files();
    const request = focusedRequest();
    const node = {
      id: "big-red",
      generation: 1,
      capabilitySnapshotSha256: sha("c"),
      osClass: "linux" as const,
      architectureClass: "x86_64" as const,
      glaedaRuntimeSha256: fingerprintGlaedaVerifyFocusedRuntimeV1(
        fixture.script,
        fixture.implementation,
      ),
    };
    const command = focusedCommand(node, request);
    let invoked: string[] = [];
    const client = new GlaedaVerifyFocusedWorkstationClientV1({
      pythonInterpreter: fixture.python,
      script: fixture.script,
      implementation: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node,
      request,
      process: (processInput) => {
        invoked = processInput.arguments;
        const report = physicalReport(command);
        return {
          status: 0,
          stdout: new TextEncoder().encode(`${JSON.stringify(report)}\n`),
          stderr: new Uint8Array(),
        };
      },
    });
    const check = await client.check(command);
    const receipt = await client.execute({ command, check });

    expect(receipt).toMatchObject({
      executionIdentityClass: "credentialless_project",
      terminalClass: "succeeded",
      rawContentEmitted: false,
      containsCredentials: false,
      authorizesRedispatch: false,
    });
    expect(invoked).toContain("--repository-root");
    expect(invoked).toContain("--command-fingerprint");
    expect(invoked).not.toContain("--shell");
    expect(invoked).not.toContain("--environment");
    expect(invoked).not.toContain("--remote-url");
    expect(client.lastResult()).toMatchObject({
      requestSha256: fingerprintGlaedaVerifyFocusedRequestV1(request),
      terminalClass: "succeeded",
    });
  });

  test("uses reconcile-only and returns null when no terminal physical receipt exists", async () => {
    const fixture = files();
    const request = focusedRequest();
    const node = {
      id: "big-red",
      generation: 1,
      capabilitySnapshotSha256: sha("c"),
      osClass: "linux" as const,
      architectureClass: "x86_64" as const,
      glaedaRuntimeSha256: fingerprintGlaedaVerifyFocusedRuntimeV1(
        fixture.script,
        fixture.implementation,
      ),
    };
    const command = focusedCommand(node, request);
    let invoked: string[] = [];
    const client = new GlaedaVerifyFocusedWorkstationClientV1({
      pythonInterpreter: fixture.python,
      script: fixture.script,
      implementation: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node,
      request,
      process: (processInput) => {
        invoked = processInput.arguments;
        return { status: 75, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
    });
    const check = await client.check(command);
    expect(await client.reconcile({ command, check })).toBeNull();
    expect(invoked.at(-1)).toBe("--reconcile-only");
  });

  test("admits cleanup-incomplete only as an explicit terminal failure", async () => {
    const fixture = files();
    const request = focusedRequest();
    const node = {
      id: "big-red",
      generation: 1,
      capabilitySnapshotSha256: sha("c"),
      osClass: "linux" as const,
      architectureClass: "x86_64" as const,
      glaedaRuntimeSha256: fingerprintGlaedaVerifyFocusedRuntimeV1(
        fixture.script,
        fixture.implementation,
      ),
    };
    const command = focusedCommand(node, request);
    const report = physicalReport(command);
    report.result.terminal_class = "cleanup_incomplete";
    report.result.task_cleanup_complete = false;
    const client = new GlaedaVerifyFocusedWorkstationClientV1({
      pythonInterpreter: fixture.python,
      script: fixture.script,
      implementation: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node,
      request,
      process: () => ({
        status: 0,
        stdout: new TextEncoder().encode(`${JSON.stringify(report)}\n`),
        stderr: new Uint8Array(),
      }),
    });

    const check = await client.check(command);
    expect((await client.execute({ command, check })).terminalClass).toBe("cleanup_incomplete");

    report.result.task_cleanup_complete = true;
    const invalid = new GlaedaVerifyFocusedWorkstationClientV1({
      pythonInterpreter: fixture.python,
      script: fixture.script,
      implementation: fixture.implementation,
      repositoryRoot: fixture.repository,
      stateRoot: fixture.state,
      cargoRoot: fixture.cargo,
      rustupRoot: fixture.rustup,
      node,
      request,
      process: () => ({
        status: 0,
        stdout: new TextEncoder().encode(`${JSON.stringify(report)}\n`),
        stderr: new Uint8Array(),
      }),
    });
    const invalidCheck = await invalid.check(command);
    await expect(invalid.execute({ command, check: invalidCheck })).rejects.toThrow(
      "changed exact command or isolation identity",
    );
  });
});

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

function focusedCommand(node: ReturnType<typeof nodeType>, request: GlaedaVerifyFocusedRequestV1) {
  return {
    version: 1 as const,
    project: "glaeda",
    itemId: "item-1",
    itemClaimGeneration: 1,
    runId: "run-1",
    runGeneration: 2,
    leaseGeneration: 3,
    authority: { holderId: "service:big-red-glaeda", expiresAt: "2026-08-31T06:00:00.000Z" },
    commandId: "glaeda-command-1",
    idempotencyKey: "glaeda-command-1",
    node,
    source: {
      repository: request.repository,
      commitOid: request.commitOid,
      treeOid: request.treeOid,
      logicalChangeRef: `github:${request.commitOid}`,
    },
    profile: {
      id: "verify-focused/v1",
      versionSha256: request.profileVersionSha256,
      class: "verify_focused" as const,
      resourceClass: "big-red-focused",
      deadlineSeconds: 600,
    },
    profileRequestSha256: fingerprintGlaedaVerifyFocusedRequestV1(request),
  };
}

function nodeType() {
  return {
    id: "big-red",
    generation: 1,
    capabilitySnapshotSha256: sha("c"),
    osClass: "linux" as const,
    architectureClass: "x86_64" as const,
    glaedaRuntimeSha256: sha("d"),
  };
}

function physicalReport(command: ReturnType<typeof focusedCommand>) {
  return {
    authority: "physical_execution_observation",
    authorizes_effects: false,
    authorizes_redispatch: false,
    authorizes_work: false,
    command_fingerprint: fingerprintGlaedaWorkstationCommandV1(command),
    contains_credentials: false,
    contains_private_content: false,
    document_type: "glaeda-verify-focused-receipt",
    execution_identity_class: "credentialless_project",
    isolation: {
      ambient_environment: "cleared",
      build_state: "task_private_tmpfs",
      filesystem: "read_only_source_task_private_tmpfs",
      network: "none",
      package_cache: "host_public_crates_io_read_only",
      publisher_credentials: "absent",
      control_credentials: "absent",
      ssh_agent: "absent",
      sudo_admin: "absent",
      unrelated_writable_projects: "absent",
    },
    profile: {
      id: command.profile.id,
      class: command.profile.class,
      generation: command.profile.versionSha256,
      resource_class: command.profile.resourceClass,
      deadline_seconds: command.profile.deadlineSeconds,
    },
    result: {
      cpu_seconds: null,
      elapsed_seconds: 1,
      exit_code: 0,
      max_rss_kib: null,
      output_bytes: 0,
      output_sha256: sha("0"),
      terminal_class: "succeeded",
      started_at_unix_millis: 1_788_150_000_000,
      settled_at_unix_millis: 1_788_150_001_000,
      process_tree_settled: true,
      raw_output: "not_published",
      resource_accounting: "cgroup_enforced_metrics_not_exported_v1",
      task_cleanup_complete: true,
    },
    schema_version: 1,
    source: {
      repository: command.source.repository,
      commit: command.source.commitOid,
      tree: command.source.treeOid,
    },
  };
}

function files() {
  const root = mkdtempSync(join(tmpdir(), "stensibly-glaeda-focused-"));
  const result: Record<string, string> = {};
  for (const name of ["repository", "cargo", "rustup"]) {
    const path = join(root, name);
    mkdirSync(path);
    result[name] = path;
  }
  result.state = join(root, "state");
  for (const name of ["python", "script", "implementation"]) {
    const path = join(root, name);
    writeFileSync(path, name, { mode: 0o700 });
    result[name] = path;
  }
  return result as {
    repository: string; cargo: string; rustup: string; state: string;
    python: string; script: string; implementation: string;
  };
}
