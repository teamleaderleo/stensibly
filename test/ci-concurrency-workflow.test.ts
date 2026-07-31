import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/ci.yml", import.meta.url),
).text();

const triggers = workflow.match(
  /\non:\n([\s\S]*?)\nconcurrency:\n/u,
)?.[1];
const concurrency = workflow.match(
  /\nconcurrency:\n([\s\S]*?)\npermissions:\n/u,
)?.[1];
const testJob = workflow.match(
  /\n  test:\n([\s\S]*?)\n  runtime-parity:\n/u,
)?.[1];
const runtimeParityJob = workflow.match(
  /\n  runtime-parity:\n([\s\S]*?)\n  serial-full:\n/u,
)?.[1];
const serialFullJob = workflow.match(
  /\n  serial-full:\n([\s\S]*)$/u,
)?.[1];

describe("canonical CI scheduling", () => {
  test("runs feature revisions once through pull requests", () => {
    expect(triggers).toContain("push:\n    branches:\n      - main");
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("workflow_dispatch:");
  });

  test("cancels only superseded pull-request runs", () => {
    expect(concurrency).toBeDefined();
    expect(concurrency).toContain("ci-${{ github.repository }}-");
    expect(concurrency).toContain("github.event_name == 'pull_request'");
    expect(concurrency).toContain(
      "format('pr-{0}', github.event.pull_request.number)",
    );
    expect(concurrency).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(concurrency).not.toContain("cancel-in-progress: true");
  });

  test("isolates exact dispatch revisions and validation profiles", () => {
    expect(concurrency).toContain("github.event_name == 'workflow_dispatch'");
    expect(concurrency).toContain(
      "format('dispatch-{0}-{1}', inputs.expected_sha, inputs.validation_profile)",
    );
    expect(concurrency).toContain("format('push-{0}', github.sha)");
    expect(concurrency).not.toContain("github.ref");
    expect(concurrency).not.toContain("github.head_ref");
    expect(concurrency).not.toContain("github.run_id");
  });

  test("keeps the existing parallel topology as the default dispatch profile", () => {
    expect(triggers).toContain("validation_profile:");
    expect(triggers).toContain("default: full_parallel");
    expect(triggers).toContain("type: choice");
    expect(triggers).toContain("- full_parallel");
    expect(triggers).toContain("- serial_full");
    expect(testJob).toContain(
      "github.event_name != 'workflow_dispatch' || inputs.validation_profile == 'full_parallel'",
    );
    expect(runtimeParityJob).toContain(
      "github.event_name != 'workflow_dispatch' || inputs.validation_profile == 'full_parallel'",
    );
  });

  test("runs the opt-in serial full profile on one hosted runner", () => {
    expect(serialFullJob).toBeDefined();
    expect(serialFullJob).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.validation_profile == 'serial_full'",
    );
    expect(serialFullJob?.match(/actions\/checkout@v6/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/oven-sh\/setup-bun@v2/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/actions\/setup-node@v6/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/bun install --frozen-lockfile/gu)).toHaveLength(1);
    expect(serialFullJob).toContain("bun run lockfile:check");
    expect(serialFullJob).toContain("bun run typecheck");
    expect(serialFullJob).toContain("bun run test");
    expect(serialFullJob).toContain("bun run test:convex");
    expect(serialFullJob).toContain("bun run worker:check");
    expect(serialFullJob).toContain("bun run test:runtime-parity");
    expect(serialFullJob).toContain("code=${PIPESTATUS[0]}");
    expect(serialFullJob).toContain("exit \"${status}\"");
  });

  test("preserves exact-SHA admission and bounded failure artifacts", () => {
    expect(serialFullJob).toContain('"${GITHUB_SHA}" != "${EXPECTED_SHA}"');
    expect(serialFullJob).toContain("serial-full-diagnostics");
    expect(serialFullJob).toContain("typecheck-output.txt");
    expect(serialFullJob).toContain("test-output.txt");
    expect(serialFullJob).toContain("convex-test-output.txt");
    expect(serialFullJob).toContain("worker-check-output.txt");
    expect(serialFullJob).toContain("runtime-parity-output.txt");
    expect(serialFullJob).not.toContain("git push");
    expect(serialFullJob).not.toContain("contents: write");
  });
});
