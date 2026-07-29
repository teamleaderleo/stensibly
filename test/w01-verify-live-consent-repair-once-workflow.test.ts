import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-verify-live-consent-repair-once.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("W01 one-time live consent repair probe", () => {
  test("is credential-free, one-time, and fixed-target", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("https://api.stensibly.com/oauth/consent");
    expect(workflow).toContain('TARGET_ISSUE: "286"');
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("secrets.");
  });

  test("polls for both compatibility cases and preserves cross-site rejection", () => {
    expect(workflow).toContain("seq 1 100");
    expect(workflow).toContain("sleep 15");
    expect(workflow).toContain('probe omitted "" same-origin');
    expect(workflow).toContain("probe null null same-origin");
    expect(workflow).toContain('probe cross-site "" cross-site');
    expect(workflow).toContain("400|invalid_request|Consent request validation failed");
    expect(workflow).toContain("403|access_denied|Consent origin is not allowed");
  });

  test("uses an empty bounded form request and posts one result", () => {
    expect(workflow).toContain("--connect-timeout 5 --max-time 10");
    expect(workflow).toContain('--header "Content-Type: application/x-www-form-urlencoded"');
    expect(workflow).toContain('--data ""');
    expect(workflow).toContain("gh issue comment");
    expect(workflow).toContain("credential-free probe");
  });
});
