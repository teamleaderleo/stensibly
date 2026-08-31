import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  GlaedaRepoQueryWorkstationClientV1,
  fingerprintGlaedaRepoQueryRequestV1,
  type GlaedaRepoQueryRequestV1,
} from "../src/glaeda-repo-query-workstation-client.ts";
import {
  admitGlaedaWorkstationCheckV1,
  fingerprintGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCommandV1,
} from "../src/glaeda-workstation-contracts.ts";

const profileVersion = "sha256:f575e0e3cd40e54ca4f868f99777e40386a2fe909cb91362f777e8881302ef65";
const request: GlaedaRepoQueryRequestV1 = {
  version: 1,
  repository: "teamleaderleo/glaeda",
  baseCommitOid: "7e1b79ddec4fd0b548ff10fe37cd09096aeb2f79",
  headCommitOid: "f5f67bdde0b65e9263bf76c2a883d73d91cf3c46",
  headTreeOid: "75429d618ebbd125045c39bd4213993408193acf",
  maxPatchBytes: 4096,
  profileVersionSha256: profileVersion,
};

describe("physical Glaeda repo-query workstation client", () => {
  test("matches the exact Glaeda request digest from the physical mailbox result", () => {
    expect(fingerprintGlaedaRepoQueryRequestV1(request)).toBe(
      "sha256:c9a6c37043f987b609a0e052244743ffd25b27f911d0341977994f89642e6e4f",
    );
  });

  test("binds tree on the fixed CLI and returns a compact correlated receipt", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "stensibly-glaeda-client-")));
    try {
      const binary = join(root, "glaeda-repo-query");
      const checkout = join(root, "checkout");
      writeFileSync(binary, "fixed test binary\n", { mode: 0o755 });
      mkdirSync(checkout);
      const runtimeSha256 = digest(Buffer.from("fixed test binary\n"));
      const node = {
        id: "big-red",
        generation: 1,
        capabilitySnapshotSha256: `sha256:${"a".repeat(64)}`,
        osClass: "linux" as const,
        architectureClass: "x86_64" as const,
        glaedaRuntimeSha256: runtimeSha256,
      };
      let observedArguments: string[] = [];
      const client = new GlaedaRepoQueryWorkstationClientV1({
        binary,
        checkout,
        node,
        request,
        process: (input) => {
          observedArguments = input.arguments;
          const report = {
            document_type: "glaeda-resident-repo-query",
            authority: "observation_only",
            profile_id: "repo-query/v1",
            profile_generation: profileVersion,
            request_digest: fingerprintGlaedaRepoQueryRequestV1(request),
            repository: "github.com/teamleaderleo/glaeda",
            head: request.headCommitOid,
            head_tree: request.headTreeOid,
            patch: { included: false },
          };
          return {
            status: 0,
            stdout: Buffer.from(`${JSON.stringify(report)}\n`),
            stderr: new Uint8Array(),
          };
        },
      });
      const command = commandFor(node);
      await expect(client.check({
        ...command,
        profileRequestSha256: `sha256:${"9".repeat(64)}`,
      })).rejects.toThrow(/exact workstation command/);
      const checked = admitGlaedaWorkstationCheckV1(await client.check(command));
      const receipt = await client.execute({ command, check: checked });

      expect(observedArguments).toContain("--tree");
      expect(observedArguments[observedArguments.indexOf("--tree") + 1]).toBe(
        request.headTreeOid,
      );
      expect(receipt).toMatchObject({
        commandFingerprint: fingerprintGlaedaWorkstationCommandV1(command),
        resultSha256: client.lastResult()?.resultSha256,
        terminalClass: "succeeded",
        executionIdentityClass: "read_only_repository",
      });
      expect(client.lastResult()).toMatchObject({
        requestSha256: command.profileRequestSha256,
        resultBytes: receipt.resultBytes,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function commandFor(node: GlaedaWorkstationCommandV1["node"]): GlaedaWorkstationCommandV1 {
  return {
    version: 1,
    project: "glaeda",
    itemId: "item-physical-query",
    itemClaimGeneration: 1,
    runId: "run-physical-query",
    runGeneration: 2,
    leaseGeneration: 2,
    authority: {
      holderId: "service:glaeda-big-red",
      expiresAt: "2026-08-31T04:00:00.000Z",
    },
    commandId: "command-physical-query",
    idempotencyKey: "command-physical-query-v1",
    node,
    source: {
      repository: request.repository,
      commitOid: request.headCommitOid,
      treeOid: request.headTreeOid,
      logicalChangeRef: "github:glaeda-dispatch:656dab7f83b5bcc3356883de1bc0b2a9dc8346f6",
    },
    profile: {
      id: "repo-query/v1",
      versionSha256: profileVersion,
      class: "repo_query",
      resourceClass: "interactive-small",
      deadlineSeconds: 30,
    },
    profileRequestSha256: fingerprintGlaedaRepoQueryRequestV1(request),
  };
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
