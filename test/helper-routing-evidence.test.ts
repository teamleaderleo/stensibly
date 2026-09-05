import { describe, expect, test } from "bun:test";
import { projectHelperRoutingEvidenceV1 } from "../src/helper-routing-evidence.ts";
import { fingerprintGlaedaWorkstationCommandV1 } from "../src/glaeda-workstation-contracts.ts";
import { resolve } from "node:path";

const sha = (c: string) => `sha256:${c.repeat(64)}`;
function fixture(profile: "repo_query" | "verify_focused" = "verify_focused", terminal = "succeeded") {
  const command = {
    version: 1 as const, project: "glaeda", itemId: "item-1", itemClaimGeneration: 1,
    runId: "run-1", runGeneration: 1, leaseGeneration: 1,
    authority: { holderId: "service:glaeda", expiresAt: "2026-09-05T02:00:00.000Z" },
    commandId: "command-1", idempotencyKey: "command-1",
    node: { id: "big-red", generation: 1, capabilitySnapshotSha256: sha("a"),
      osClass: "linux" as const, architectureClass: "x86_64" as const, glaedaRuntimeSha256: sha("b") },
    source: { repository: "teamleaderleo/glaeda", commitOid: "c".repeat(40), treeOid: "d".repeat(40), logicalChangeRef: null },
    profile: { id: profile === "repo_query" ? "repo-query/v1" : "verify-focused/v1",
      versionSha256: sha("e"), class: profile, resourceClass: "big-red-focused", deadlineSeconds: 600 },
    profileRequestSha256: sha("f"),
  };
  const { logicalChangeRef: _logical, ...source } = command.source;
  const { resourceClass: _resource, deadlineSeconds: _deadline, ...receiptProfile } = command.profile;
  const commandFingerprint = fingerprintGlaedaWorkstationCommandV1(command);
  const shared = { commandFingerprint, node: command.node, source, profile: receiptProfile,
    executionIdentityClass: profile === "repo_query" ? "read_only_repository" : "credentialless_project",
    rawContentEmitted: false, authorizesWork: false, authorizesEffects: false };
  return {
    version: 1, kind: "glaeda_workstation_adapter_result", command, commandFingerprint,
    check: { schema: "glaeda-workstation-check/v1", ...shared, supported: true },
    receipt: { schema: "glaeda-workstation-receipt/v1", ...shared, terminalClass: terminal,
      resultSha256: sha("1"), resultBytes: 42, startedAt: "2026-09-05T01:00:00.000Z",
      settledAt: "2026-09-05T01:00:02.000Z", containsPrivateContent: false,
      containsCredentials: false, authorizesRedispatch: false },
  };
}

describe("helper routing receipt projection", () => {
  test("verification success preserves exact refs and leaves work acceptance/provider/accounting unknown", () => {
    const source = fixture();
    const task = projectHelperRoutingEvidenceV1(source).tasks[0]!;
    expect(task.outcomes).toEqual({ provider_success: null, process_completed: null, verified: true, accepted: null });
    expect(task.evidence_refs).toContain(`glaeda-result:${sha("1")}`);
    expect(task.evidence_refs).toContain(`stensibly-command:${source.commandFingerprint}`);
    expect(Object.values(task.metrics).every((value) => value === null)).toBe(true);
    expect(task.provider_usage).toEqual([]);
    expect(task.route).toBeNull();
  });
  test("query success does not become verification; failed verification remains failed", () => {
    expect(projectHelperRoutingEvidenceV1(fixture("repo_query")).tasks[0]!.outcomes.verified).toBeNull();
    expect(projectHelperRoutingEvidenceV1(fixture("verify_focused", "failed")).tasks[0]!.outcomes)
      .toEqual({ provider_success: null, process_completed: null, verified: false, accepted: null });
  });
  test("interrupted, refused, cleanup-incomplete and receipt-absent outcomes remain unknown", () => {
    for (const terminal of ["timed_out", "refused", "cleanup_incomplete"]) {
      expect(projectHelperRoutingEvidenceV1(fixture("verify_focused", terminal)).tasks[0]!.outcomes.verified).toBeNull();
    }
    expect(projectHelperRoutingEvidenceV1({ ...fixture(), receipt: null }).tasks[0]!.outcomes.process_completed).toBeNull();
  });
  test("refuses changed receipt identities and replay double counting", () => {
    const source = fixture();
    expect(() => projectHelperRoutingEvidenceV1({ ...source, receipt: { ...source.receipt, commandFingerprint: sha("9") } })).toThrow();
    expect(() => projectHelperRoutingEvidenceV1({ ...source, command: { ...source.command, runId: "other-run" } })).toThrow();
    expect(() => projectHelperRoutingEvidenceV1([source, source])).toThrow("Duplicate");
    expect(() => projectHelperRoutingEvidenceV1([])).toThrow();
  });
  test("CLI reads existing JSON from stdin and emits only the research projection", () => {
    const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/helper-routing-evidence.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify(fixture())), stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual(projectHelperRoutingEvidenceV1(fixture()));
  });
  test("distinct commands for one parent cannot inflate task counts; distinct work items remain distinct", () => {
    const first = fixture();
    const next = fixture("repo_query");
    expect(next.commandFingerprint).not.toBe(first.commandFingerprint);
    expect(() => projectHelperRoutingEvidenceV1([first, next])).toThrow("Duplicate parent");
    next.command.itemId = "item-2";
    next.command.runId = "run-2";
    const fingerprint = fingerprintGlaedaWorkstationCommandV1(next.command);
    next.commandFingerprint = fingerprint;
    next.check.commandFingerprint = fingerprint;
    next.receipt.commandFingerprint = fingerprint;
    expect(projectHelperRoutingEvidenceV1([first, next]).tasks).toHaveLength(2);
  });
  test("CLI errors never echo malformed private values", () => {
    const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/helper-routing-evidence.ts")], {
      stdin: new TextEncoder().encode('{"private":"sentinel-secret"'), stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).not.toContain("sentinel-secret");
  });
});
