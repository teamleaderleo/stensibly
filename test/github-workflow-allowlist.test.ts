import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const workflowDirectory = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

const permanentWorkflows = [
  "apply-bun-lock-candidate.yml",
  "auto-deploy-dashboard.yml",
  "callsign-registry.yml",
  "ci.yml",
  "deploy-dashboard.yml",
  "deploy-worker.yml",
  "mcp-stateful-replay-v130-probe.yml",
  "publish-dashboard-on-main.yml",
  "sync-issue-labels.yml",
  "verify-github-observation-hosted.yml",
  "verify-oauth-hosted.yml",
] as const;

describe("GitHub workflow allowlist", () => {
  test("contains only reviewed permanent workflows", () => {
    const workflows = readdirSync(workflowDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    expect(workflows).toEqual([...permanentWorkflows]);
  });
});
