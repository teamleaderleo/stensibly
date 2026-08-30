import { expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/verify-hosted-lazy-workstation.yml", import.meta.url),
).text();

test("hosted Lazy verification workflow is exact, bounded, and secret-safe", () => {
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("environment:\n      name: production");
  expect(workflow).toContain("current_main=\"$(git rev-parse FETCH_HEAD)\"");
  expect(workflow).toContain("bun scripts/convex-production-deploy-key.ts");
  expect(workflow).toContain("convex env get STENSIBLY_SERVICE_SECRET --prod");
  expect(workflow).not.toContain("github.run_attempt");
  expect(workflow).toContain("::add-mask::$service_secret");
  expect(workflow).toContain("bun scripts/verify-hosted-lazy-workstation.ts");
  expect(workflow).toContain(".terminalClaimInvalidationReplay == \"replayed\"");
  expect(workflow).toContain(".authorizesEffects == false");
  expect(workflow).toContain("retention-days: 14");
  expect(workflow).not.toContain("echo \"$service_secret\"");
  expect(workflow).not.toContain("pull_request:");
});
