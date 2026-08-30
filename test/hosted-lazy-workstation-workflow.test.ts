import { expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/verify-hosted-lazy-workstation.yml", import.meta.url),
).text();

test("hosted Lazy verification workflow is exact, bounded, and secret-safe", () => {
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("run_ref:");
  expect(workflow).toContain("HOSTED_LAZY_RUN_REF: ${{ inputs.run_ref || github.run_id }}");
  expect(workflow).toContain("environment:\n      name: production");
  expect(workflow).toContain("current_main=\"$(git rev-parse FETCH_HEAD)\"");
  expect(workflow).toContain("bun scripts/convex-production-deploy-key.ts");
  expect(workflow).toContain("STENSIBLY_SERVICE_SECRET: ${{ secrets.STENSIBLY_SERVICE_SECRET }}");
  expect(workflow).not.toContain("convex env get STENSIBLY_SERVICE_SECRET");
  expect(workflow).not.toContain("github.run_attempt");
  expect(workflow).toContain("::add-mask::$STENSIBLY_SERVICE_SECRET");
  expect(workflow).toContain("bun scripts/verify-hosted-lazy-workstation.ts");
  expect(workflow).toContain(".terminalClaimInvalidationReplay == \"replayed\"");
  expect(workflow).toContain(".authorizesEffects == false");
  expect(workflow).toContain("retention-days: 14");
  expect(workflow).not.toContain("echo \"$STENSIBLY_SERVICE_SECRET\"");
  expect(workflow).not.toContain("pull_request:");
});
