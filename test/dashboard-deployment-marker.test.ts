import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitDashboardDeploymentMarker,
  compileDashboardDeploymentMarker,
  DASHBOARD_DEPLOYMENT_MARKER_SCHEMA_VERSION,
  runDashboardDeploymentMarker,
} from "../scripts/dashboard-deployment-marker.ts";

const sourceRevision = "a".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("public dashboard deployment marker", () => {
  test("compiles one deterministic content-minimised identity", () => {
    const marker = compileDashboardDeploymentMarker(identity());
    expect(marker).toEqual({
      schemaVersion: DASHBOARD_DEPLOYMENT_MARKER_SCHEMA_VERSION,
      repository: "teamleaderleo/stensibly",
      sourceRevision,
      workflowRevision: sourceRevision,
      run: { id: "123", attempt: "2" },
      authorizesDeployment: false,
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.isFrozen(marker.run)).toBe(true);
    expect(JSON.stringify(marker)).not.toContain("token");
  });

  test("admits only the exact publication and recomputed fingerprint", () => {
    const marker = compileDashboardDeploymentMarker(identity());
    expect(admitDashboardDeploymentMarker(marker, identity())).toEqual(marker);
    expect(() => admitDashboardDeploymentMarker({
      ...marker,
      sourceRevision: "b".repeat(40),
    }, identity())).toThrow("does not match");
    expect(() => admitDashboardDeploymentMarker({
      ...marker,
      fingerprint: `sha256:${"f".repeat(64)}`,
    }, identity())).toThrow("not self-consistent");
    expect(() => admitDashboardDeploymentMarker({
      ...marker,
      unexpected: true,
    }, identity())).toThrow("fields are not exact");
  });

  test("writes only the exact prebuilt public path and verifies only runner-temp evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-dashboard-marker-"));
    temporaryRoots.push(root);
    const output = join(root, ".vercel/output/static/.well-known/stensibly-deployment.json");
    const writeEnvironment = environment(
      root,
      ".vercel/output/static/.well-known/stensibly-deployment.json",
      "write",
    );
    const previousDirectory = process.cwd();
    process.chdir(root);
    try {
      const marker = await runDashboardDeploymentMarker(writeEnvironment);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(marker);
      await expect(runDashboardDeploymentMarker({
        ...writeEnvironment,
        DASHBOARD_DEPLOYMENT_MARKER_PATH: join(root, "other.json"),
      })).rejects.toThrow("output path is invalid");

      const downloaded = join(root, "runner-temp/public-marker.json");
      await mkdir(join(root, "runner-temp"), { recursive: true });
      await writeFile(downloaded, await readFile(output));
      expect(await runDashboardDeploymentMarker(
        environment(root, downloaded, "verify"),
      )).toEqual(marker);
      await expect(runDashboardDeploymentMarker({
        ...environment(root, downloaded, "verify"),
        EXPECTED_REVISION: "b".repeat(40),
        GITHUB_SHA: "b".repeat(40),
        GITHUB_WORKFLOW_SHA: "b".repeat(40),
      })).rejects.toThrow("does not match");
    } finally {
      process.chdir(previousDirectory);
    }
  });

  test("rejects symlinked, oversized, duplicate-key, and outside inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-dashboard-marker-hostile-"));
    temporaryRoots.push(root);
    const runnerTemp = join(root, "runner-temp");
    await mkdir(runnerTemp, { recursive: true });
    const input = join(runnerTemp, "marker.json");
    await writeFile(input, `${JSON.stringify(compileDashboardDeploymentMarker(identity()))}\n`);
    await unlink(input);
    await symlink(join(root, "missing.json"), input);
    await expect(runDashboardDeploymentMarker(
      environment(root, input, "verify"),
    )).rejects.toThrow("bounded ordinary file");

    await unlink(input);
    await writeFile(input, "x".repeat(2_049));
    await expect(runDashboardDeploymentMarker(
      environment(root, input, "verify"),
    )).rejects.toThrow("bounded ordinary file");

    await writeFile(input, '{"schemaVersion":"a","schemaVersion":"b"}');
    await expect(runDashboardDeploymentMarker(
      environment(root, input, "verify"),
    )).rejects.toThrow("Duplicate JSON object key");

    await expect(runDashboardDeploymentMarker(
      environment(root, join(root, "outside.json"), "verify"),
    )).rejects.toThrow("inside RUNNER_TEMP");
  });
});

function identity() {
  return {
    repository: "teamleaderleo/stensibly",
    sourceRevision,
    workflowRevision: sourceRevision,
    runId: "123",
    runAttempt: "2",
  };
}

function environment(
  root: string,
  path: string,
  mode: "write" | "verify",
): Record<string, string> {
  return {
    DASHBOARD_DEPLOYMENT_MARKER_MODE: mode,
    DASHBOARD_DEPLOYMENT_MARKER_PATH: path,
    EXPECTED_REVISION: sourceRevision,
    GITHUB_REPOSITORY: "teamleaderleo/stensibly",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: sourceRevision,
    GITHUB_WORKFLOW_SHA: sourceRevision,
    RUNNER_TEMP: join(root, "runner-temp"),
  };
}
