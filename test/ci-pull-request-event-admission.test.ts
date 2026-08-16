import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/ci.yml", import.meta.url),
).text();

const concurrency = section("concurrency:", "permissions:");
const browserJob = section("  browser-evidence:", "  test:");
const testJob = section("  test:", "  runtime-parity:");
const runtimeJob = section("  runtime-parity:", "  serial-full:");
const receiptJob = workflow.slice(workflow.indexOf("  validation-receipt:"));

describe("pull-request event admission", () => {
  test("isolates ordinary metadata from source validation concurrency", () => {
    expect(concurrency).toContain("github.event.action == 'edited'");
    expect(concurrency).toContain("github.event.action == 'labeled'");
    expect(concurrency).toContain("github.event.action == 'unlabeled'");
    expect(concurrency).toContain("&& 'metadata' || 'validation'");
    expect(concurrency).toContain(
      "contains(github.event.pull_request.labels.*.name, 'ci:red-control')",
    );
    expect(concurrency).toContain(
      "github.event.label.name == 'ci:red-control')) && 'validation'",
    );
  });

  test("runs full validation only for source-bearing or readiness events", () => {
    for (const job of [browserJob, testJob, runtimeJob, receiptJob]) {
      expect(job).toContain("github.event.action == 'opened'");
      expect(job).toContain("github.event.action == 'synchronize'");
      expect(job).toContain("github.event.action == 'reopened'");
      expect(job).toContain("github.event.action == 'ready_for_review'");
      expect(job).toContain("github.event.action == 'unlabeled' &&");
      expect(job).toContain("github.event.label.name == 'ci:red-control'");
      expect(job).not.toContain("github.event.action == 'edited'");
      expect(job).not.toContain("github.event.action == 'labeled'");
      expect(job).not.toContain("github.event.action == 'converted_to_draft'");
      expect(job).not.toContain("github.event.action != 'closed'");
    }
  });

  test("rejects reverse pull requests from the default branch before runner allocation", () => {
    for (const job of [browserJob, testJob, runtimeJob, receiptJob]) {
      expect(job).toContain(
        "github.event.pull_request.head.ref != github.event.repository.default_branch",
      );
    }
  });
});

function section(start: string, end: string): string {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing workflow section ${start} -> ${end}`);
  }
  return workflow.slice(startIndex, endIndex);
}
