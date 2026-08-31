import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { mcpCapabilityPolicyRegistry } from "../src/mcp-capability-policy.ts";
import { compileMcpCapabilityExposureSelection } from "../src/mcp-exposure-selection.ts";
import { MCP_TOOL_MANIFEST_VERSION } from "../src/mcp-diagnostics.ts";

interface ChatGptAppActionSnapshot {
  snapshotVersion: number;
  manifestVersion: number;
  toolCount: number;
  toolManifestFingerprint: string;
  toolContractFingerprint: string;
  tools: string[];
  releasePolicy: string;
  requiredAdminActionAfterAnyManifestChange: string;
  latestManifestMustBeActiveBeforeDogfood: boolean;
  reviewedOn: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);
const recoveryPath = new URL("../docs/chatgpt-app-recovery.md", import.meta.url);

function readSnapshot(): ChatGptAppActionSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppActionSnapshot;
}

describe("ChatGPT app action snapshot", () => {
  test("tracks the curated published_default contract and requires a host refresh after drift", () => {
    const snapshot = readSnapshot();
    const selection = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "published_default",
    );
    const expectedManifestFingerprint = `sha256:${createHash("sha256")
      .update(JSON.stringify({
        version: MCP_TOOL_MANIFEST_VERSION,
        tools: snapshot.tools,
      }))
      .digest("hex")}`;

    expect(snapshot.snapshotVersion).toBe(22);
    expect(snapshot.manifestVersion).toBe(MCP_TOOL_MANIFEST_VERSION);
    expect(snapshot.toolCount).toBe(21);
    expect(snapshot.toolCount).toBe(selection.toolNames.length);
    expect(snapshot.toolManifestFingerprint).toBe(expectedManifestFingerprint);
    expect(snapshot.toolContractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.tools).toEqual([...selection.toolNames]);
    expect(snapshot.tools).toContain("get_brief");
    expect(snapshot.tools).toContain("get_runner_context");
    expect(snapshot.tools).not.toContain("get_item");
    expect(snapshot.tools).toContain("attach_artifact");
    expect(snapshot.tools).toContain("dispatch_work");
    expect(snapshot.tools).toContain("get_project_attachment");
    expect(snapshot.tools).toContain("github_repo_health");
    expect(snapshot.tools).toContain("github_ci_diagnose");
    expect(snapshot.tools).toContain("github_create_issue");
    expect(snapshot.tools).toContain("github_update_issue");
    expect(snapshot.tools).toContain("github_add_issue_comment");
    expect(snapshot.tools).toContain("github_publish_change");
    expect(snapshot.tools).toContain("github_land_pr");
    expect(snapshot.tools).not.toContain("get_operation_receipt");
    expect(snapshot.tools).not.toContain("get_operation_workflow");
    expect(snapshot.tools).not.toContain("enrol_worker");
    expect(snapshot.tools).not.toContain("github_call_tool");
    expect(snapshot.tools).not.toContain("github_create_branch");
    expect(snapshot.tools).not.toContain("github_create_file");
    expect(snapshot.tools).not.toContain("github_create_pull_request");
    expect(snapshot.tools).not.toContain("survey_workspace");
    expect(snapshot.releasePolicy).toBe("latest_manifest_only");
    expect(snapshot.requiredAdminActionAfterAnyManifestChange).toBe(
      "refresh_or_recreate_chatgpt_app",
    );
    expect(snapshot.latestManifestMustBeActiveBeforeDogfood).toBe(true);
    expect(snapshot.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect("legacySnapshot" in snapshot).toBe(false);
  });

  test("keeps the latest-only release and curated-profile recovery guidance attached", () => {
    const snapshot = readSnapshot();
    const recovery = readFileSync(recoveryPath, "utf8");

    expect(recovery).toContain(String(snapshot.toolCount));
    expect(recovery).toContain(snapshot.toolManifestFingerprint);
    expect(recovery).toContain(snapshot.toolContractFingerprint);
    expect(recovery).toContain("published_default");
    expect(recovery).toContain("full_internal");
    expect(recovery).toContain("latest manifest only");
    expect(recovery).toContain("before network dispatch");
    expect(recovery).toContain("HAR");
    expect(recovery).not.toContain("25-action");
    expect(recovery).not.toContain("legacy approved actions");
  });
});
