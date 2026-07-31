import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/verify-github-observation-hosted.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("hosted GitHub observation verification workflow", () => {
  test("runs after successful production Worker deployment and supports main-only recovery", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("Deploy Worker Production");
    expect(workflow).toContain("- completed");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  test("admits target bytes before checkout and executes a separate trusted source revision", () => {
    const admissionIndex = workflow.indexOf("Admit trusted source and deployed target");
    const checkoutIndex = workflow.indexOf("actions/checkout@v6");
    expect(admissionIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeGreaterThan(admissionIndex);
    expect(workflow).toContain("SOURCE_REVISION: ${{ github.sha }}");
    expect(workflow).toContain("source_revision: ${{ steps.admit.outputs.source_revision }}");
    expect(workflow).toContain("ref: ${{ env.SOURCE_REVISION }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("Manual verification target must equal the current main workflow revision");
    expect(workflow).not.toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.revision");
    expect(workflow).not.toContain("ref: ${{ env.TARGET_REVISION }}");
  });

  test("keeps the protected environment outside the credential-free admission job", () => {
    const admitIndex = workflow.indexOf("\n  admit:");
    const verifyIndex = workflow.indexOf("\n  verify:");
    expect(admitIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(admitIndex);
    expect(workflow.slice(admitIndex, verifyIndex)).not.toContain("environment:");
    expect(workflow.slice(verifyIndex)).toContain("needs: admit");
    expect(workflow.slice(verifyIndex)).toContain("environment:");
    expect(workflow.slice(verifyIndex)).toContain("name: production");
  });

  test("validates branch, padded, and unrelated manual targets before privileged work", () => {
    expect(workflow).toContain('if [[ ! "$TARGET_REVISION" =~ ^[a-f0-9]{40}$ ]]');
    expect(workflow).toContain('if [[ "${GITHUB_EVENT_NAME}" == "workflow_dispatch" && "$TARGET_REVISION" != "$SOURCE_REVISION" ]]');
    expect(workflow).toContain('if [[ ! "$TARGET_REPOSITORY" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]]');
    const checkoutIndex = workflow.indexOf("actions/checkout@v6");
    expect(workflow.indexOf('if [[ ! "$TARGET_REVISION"')).toBeLessThan(checkoutIndex);
    expect(workflow.indexOf('"$TARGET_REVISION" != "$SOURCE_REVISION"')).toBeLessThan(checkoutIndex);
  });

  test("uses only the existing protected read token after trusted checkout", () => {
    const checkoutIndex = workflow.indexOf("actions/checkout@v6");
    const secretIndex = workflow.indexOf("secrets.STENSIBLY_READ_TOKEN");
    expect(secretIndex).toBeGreaterThan(checkoutIndex);
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(workflow).not.toContain("STENSIBLY_GITHUB_WEBHOOK_SECRET");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("CONVEX_URL");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  test("passes the deployed revision only as verifier data", () => {
    expect(workflow).toContain("bun src/verify-github-observation-readback.ts");
    expect(workflow).toContain('--repository "$TARGET_REPOSITORY"');
    expect(workflow).toContain('--revision "$TARGET_REVISION"');
    expect(workflow).toContain("--limit 100");
    expect(workflow).toContain("Trusted verifier revision");
  });

  test("polls a bounded number of times and publishes content-minimised evidence", () => {
    expect(workflow).toContain("for attempt in $(seq 1 12)");
    expect(workflow).toContain("sleep 10");
    expect(workflow).toContain("github-observation-verification.txt");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).not.toContain("set -x");
    expect(workflow).not.toContain("printenv");
    expect(workflow).not.toContain("curl ");
  });
});
