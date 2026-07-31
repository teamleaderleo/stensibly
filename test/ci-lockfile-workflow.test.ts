import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();
const testJob = workflow.match(
  /\n  test:\n([\s\S]*?)\n  runtime-parity:\n/u,
)?.[1];
const runtimeParityJob = workflow.match(
  /\n  runtime-parity:\n([\s\S]*?)\n  serial-full:\n/u,
)?.[1];
const serialFullJob = workflow.match(
  /\n  serial-full:\n([\s\S]*)$/u,
)?.[1];

describe("canonical CI dependency lock", () => {
  test("generates a bounded replacement artifact before rejecting drift", () => {
    expect(workflow).toContain("bun run lockfile:check");
    expect(workflow).toContain("steps.bun-lock.outputs.changed == 'true'");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("bun-lock-candidate-${{ github.sha }}");
    expect(workflow).toContain("artifacts/bun-lock-candidate");
    expect(workflow).not.toContain(".artifacts/bun-lock-candidate");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).toContain("Reject stale committed Bun lockfile");

    expect(workflow.indexOf("Upload refreshed Bun lockfile candidate")).toBeLessThan(
      workflow.indexOf("Reject stale committed Bun lockfile"),
    );
  });

  test("uses the committed lock once in each validation job", () => {
    expect(testJob?.match(/bun install --frozen-lockfile/g)).toHaveLength(1);
    expect(runtimeParityJob?.match(/bun install --frozen-lockfile/g))
      .toHaveLength(1);
    expect(serialFullJob?.match(/bun install --frozen-lockfile/g)).toHaveLength(1);
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("git commit");
    expect(workflow).not.toContain("git push");
  });
});
