import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/ci.yml", import.meta.url),
).text();

const concurrency = workflow.match(
  /\nconcurrency:\n([\s\S]*?)\npermissions:\n/u,
)?.[1];

describe("canonical CI concurrency", () => {
  test("cancels only superseded pull-request runs", () => {
    expect(concurrency).toBeDefined();
    expect(concurrency).toContain("github.event_name == 'pull_request'");
    expect(concurrency).toContain(
      "format('pr-{0}', github.event.pull_request.number)",
    );
    expect(concurrency).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(concurrency).not.toContain("cancel-in-progress: true");
  });

  test("isolates exact dispatch and push revisions", () => {
    expect(concurrency).toContain("github.event_name == 'workflow_dispatch'");
    expect(concurrency).toContain(
      "format('dispatch-{0}', inputs.expected_sha)",
    );
    expect(concurrency).toContain("format('push-{0}', github.sha)");
    expect(concurrency).not.toContain("github.ref");
    expect(concurrency).not.toContain("github.head_ref");
    expect(concurrency).not.toContain("github.run_id");
  });
});
