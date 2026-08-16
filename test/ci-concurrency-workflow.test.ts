import { describe, expect, test } from "bun:test";
import {
  CI_CANONICAL_COMMAND_IDS_V1,
  CI_VALIDATION_PROFILE_COMMANDS_V1,
} from "../src/ci-queue-receipt.ts";

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
const browserJob = workflow.match(
  /\n  browser-evidence:\n([\s\S]*?)\n  test:\n/u,
)?.[1];
const runtimeParityJob = workflow.match(
  /\n  runtime-parity:\n([\s\S]*?)\n  serial-full:\n/u,
)?.[1];
const serialFullJob = workflow.match(
  /\n  serial-full:\n([\s\S]*)$/u,
)?.[1];
const commandMarkers = {
  lockfile: "bun run lockfile:check",
  typecheck: "bun run typecheck",
  "bun-tests": "bun run test",
  "convex-tests": "bun run test:convex",
  "worker-check": "bun run worker:check",
  "runtime-parity": "bun run test:runtime-parity",
} as const satisfies Record<
  typeof CI_CANONICAL_COMMAND_IDS_V1[number],
  string
>;

describe("canonical CI scheduling", () => {
  test("runs feature revisions once through pull requests", () => {
    expect(triggers).toContain("push:\n    branches:\n      - main");
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("workflow_call:");
  });

  test("cancels only superseded pull-request runs", () => {
    expect(concurrency).toBeDefined();
    expect(concurrency).toContain("ci-${{ github.repository }}-");
    expect(concurrency).toContain("github.event_name == 'pull_request'");
    expect(concurrency).toContain(
      "format('pr-{0}-{1}', github.event.pull_request.number,",
    );
    expect(concurrency).toContain("&& 'validation' ||");
    expect(concurrency).toContain("&& 'metadata' || 'validation'");
    expect(concurrency).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(concurrency).not.toContain("cancel-in-progress: true");
  });

  test("isolates exact requested revisions and validation profiles", () => {
    expect(concurrency).toContain("github.event_name == 'workflow_dispatch'");
    expect(concurrency).toContain("github.event_name == 'workflow_call'");
    expect(concurrency).toContain(
      "format('exact-{0}-{1}', inputs.expected_sha, inputs.validation_profile)",
    );
    expect(concurrency).toContain("format('push-{0}', github.sha)");
    expect(concurrency).not.toContain("github.ref");
    expect(concurrency).not.toContain("github.head_ref");
    expect(concurrency).not.toContain("github.run_id");
  });

  test("keeps the existing parallel topology as the default exact-ref profile", () => {
    expect(triggers).toContain("validation_profile:");
    expect(triggers).toContain("default: full_parallel");
    expect(triggers).toContain("type: choice");
    expect(triggers).toContain("- full_parallel");
    expect(triggers).toContain("- serial_full");
    for (const job of [testJob, runtimeParityJob]) {
      expect(job).toContain("github.event_name != 'workflow_dispatch' &&");
      expect(job).toContain("github.event_name != 'workflow_call'");
      expect(job).toContain("inputs.validation_profile == 'full_parallel'");
    }
  });

  test("pins every parallel job and attests the repository validation tree", () => {
    for (const job of [browserJob, testJob, runtimeParityJob]) {
      expect(job).toContain("PARALLEL_VALIDATION_SHA:");
      expect(job).toContain("github.event.pull_request.head.sha");
      expect(job).toContain("ref: ${{ env.PARALLEL_VALIDATION_SHA }}");
      expect(job).toContain("persist-credentials: false");
      expect(job).toContain('revision="$(git rev-parse HEAD)"');
      expect(job).toContain('"${revision}" != "${PARALLEL_VALIDATION_SHA}"');
    }
    expect(testJob).toContain(
      "validation-revision: ${{ steps.validation-tree.outputs.revision }}",
    );
    expect(testJob).toContain(
      "validation-tree: ${{ steps.validation-tree.outputs.tree }}",
    );
    expect(testJob).toContain("id: validation-tree");
    expect(testJob).toContain('tree="$(git rev-parse \'HEAD^{tree}\')"');
    expect(testJob).toContain('! "${tree}" =~ ^[0-9a-f]{40}$');
  });

  test("uses one canonical gate contract for both full profiles", () => {
    expect(CI_VALIDATION_PROFILE_COMMANDS_V1.full_parallel)
      .toBe(CI_CANONICAL_COMMAND_IDS_V1);
    expect(CI_VALIDATION_PROFILE_COMMANDS_V1.serial_full)
      .toBe(CI_CANONICAL_COMMAND_IDS_V1);
    const parallelTopology = `${testJob ?? ""}\n${runtimeParityJob ?? ""}`;
    for (const commandId of CI_CANONICAL_COMMAND_IDS_V1) {
      expect(parallelTopology).toContain(commandMarkers[commandId]);
      expect(serialFullJob).toContain(commandMarkers[commandId]);
    }
  });

  test("checks the synthetic merge after green exact-head parallel jobs", () => {
    expect(serialFullJob).toBeDefined();
    expect(serialFullJob).toContain("needs: [browser-evidence, test, runtime-parity]");
    expect(serialFullJob).toContain("always()");
    expect(serialFullJob).toContain("github.event_name == 'pull_request'");
    expect(serialFullJob).toContain("needs.browser-evidence.result == 'success'");
    expect(serialFullJob).toContain("needs.test.result == 'success'");
    expect(serialFullJob).toContain("needs.runtime-parity.result == 'success'");
    expect(serialFullJob).toContain("github.event_name == 'workflow_dispatch' ||");
    expect(serialFullJob).toContain("github.event_name == 'workflow_call'");
    expect(serialFullJob).toContain("inputs.validation_profile == 'serial_full'");
    expect(serialFullJob).toContain("github.sha ||");
    expect(serialFullJob?.match(/actions\/checkout@v6/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/oven-sh\/setup-bun@v2/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/actions\/setup-node@v6/gu)).toHaveLength(1);
    expect(serialFullJob?.match(/bun install --frozen-lockfile/gu)).toHaveLength(1);
    expect(serialFullJob).toContain('pipeline_status=("${PIPESTATUS[@]}")');
    expect(serialFullJob).toContain('"${pipeline_status[0]}" -ne 0');
    expect(serialFullJob).toContain('"${pipeline_status[1]}" -ne 0');
    expect(serialFullJob).toContain("exit \"${status}\"");
  });

  test("reuses parallel results only for one exact byte-identical tree", () => {
    expect(serialFullJob).toContain("id: tree-equivalence");
    expect(serialFullJob).toContain(
      "REPOSITORY_REVISION: ${{ needs.test.outputs.validation-revision }}",
    );
    expect(serialFullJob).toContain('"${GITHUB_EVENT_NAME}" == "pull_request"');
    expect(serialFullJob).toContain(
      '"${REPOSITORY_REVISION}" == "${EXPECTED_PARALLEL_SHA}"',
    );
    expect(serialFullJob).toContain('"${REPOSITORY_TREE}" == "${source_tree}"');
    expect(serialFullJob).toContain(
      "if: steps.tree-equivalence.outputs.reuse_parallel != 'true'",
    );
  });

  test("preserves exact-SHA admission and bounded failure artifacts", () => {
    expect(serialFullJob).toContain("SERIAL_VALIDATION_SHA:");
    expect(serialFullJob).toContain("github.event.pull_request.head.sha");
    expect(serialFullJob).toContain("EXPECTED_PARALLEL_SHA:");
    expect(serialFullJob).toContain("ref: ${{ env.SERIAL_VALIDATION_SHA }}");
    expect(serialFullJob).toContain("persist-credentials: false");
    expect(serialFullJob).toContain('actual_sha="$(git rev-parse HEAD)"');
    expect(serialFullJob).toContain('! "${SERIAL_VALIDATION_SHA}" =~ ^[0-9a-f]{40}$');
    expect(serialFullJob).toContain('"${actual_sha}" != "${SERIAL_VALIDATION_SHA}"');
    expect(serialFullJob).toContain("serial-full-diagnostics-${{ env.SERIAL_VALIDATION_SHA }}");
    expect(serialFullJob).toContain("typecheck-output.txt");
    expect(serialFullJob).toContain("test-output.txt");
    expect(serialFullJob).toContain("convex-test-output.txt");
    expect(serialFullJob).toContain("worker-check-output.txt");
    expect(serialFullJob).toContain("runtime-parity-output.txt");
    expect(serialFullJob).not.toContain("git push");
    expect(serialFullJob).not.toContain("contents: write");
  });
});
