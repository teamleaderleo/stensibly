import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/publish-dashboard-on-main.yml", import.meta.url),
).text();

function position(value: string): number {
  const index = workflow.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("guarded dashboard publication workflow", () => {
  test("runs only through an explicit dispatch and stays serialized", () => {
    expect(workflow).toContain("name: Publish Dashboard Production");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain("group: stensibly-dashboard-production");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  test("requires the coordinator's exact revision before checkout or protected publication", () => {
    const revisionGate = position("Require the exact admitted revision");
    const firstCheckout = position("actions/checkout@v6");
    const publishJob = position("  publish:");

    expect(workflow).toContain("expected_revision:");
    expect(workflow).toContain("required: true");
    expect(workflow).toContain("type: string");
    expect(workflow).toContain("EXPECTED_REVISION: ${{ inputs.expected_revision }}");
    expect(workflow).toContain('[[ ! "${EXPECTED_REVISION}" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[ "${GITHUB_SHA}" != "${EXPECTED_REVISION}" ]');
    expect(workflow).toContain("needs: validate");
    expect(revisionGate).toBeLessThan(firstCheckout);
    expect(firstCheckout).toBeLessThan(publishJob);

    const validate = workflow.slice(position("  validate:"), publishJob);
    expect(validate).not.toContain("secrets.");
    expect(validate).not.toContain("VERCEL_TOKEN");
    expect(validate).not.toContain("environment:");
  });

  test("rejects dispatches targeting refs other than main", () => {
    const validate = workflow.slice(position("  validate:"), position("  publish:"));
    const publish = workflow.slice(position("  publish:"));

    expect(validate).toContain("if: github.ref == 'refs/heads/main'");
    expect(publish).toContain("if: github.ref == 'refs/heads/main'");
  });

  test("keeps validation secret-free and production effects environment-gated", () => {
    const validate = workflow.slice(position("  validate:"), position("  publish:"));
    expect(validate).not.toContain("secrets.");
    expect(validate).toContain("bun run typecheck");
    expect(validate).toContain("bun run test");
    expect(validate).toContain("bun run test:convex");
    expect(validate).toContain("bun run worker:check");
    expect(validate).toContain("bun run verify:dashboard");
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("name: production");
  });

  test("pins and validates the exact dashboard project before domain work", () => {
    expect(workflow).toContain("VERCEL_CLI_VERSION: 56.5.0");
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain("DASHBOARD_APEX: stensibly.com");
    expect(workflow).toContain("DASHBOARD_HOST: www.stensibly.com");
    expect(workflow).toContain("api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}");
    expect(workflow).toContain('.name == $name and .rootDirectory == "site"');
    expect(position("Validate Vercel project and credentials"))
      .toBeLessThan(position("Keep production public and previews protected"));
    expect(position("Keep production public and previews protected"))
      .toBeLessThan(position("Link the canonical domain to this project"));
  });

  test("keeps production public while retaining preview SSO", () => {
    expect(workflow).toContain("--request PATCH");
    expect(workflow).toContain("ssoProtection");
    expect(workflow).toContain('"deploymentType":"preview"');
    expect(workflow).not.toContain('"deploymentType":"all"');
  });

  test("runs the separately tested fail-closed domain linker before build", () => {
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} domains add");
    expect(workflow).toContain("run: bash scripts/link-vercel-project-domain.sh");
    expect(position("Link the canonical domain to this project"))
      .toBeLessThan(position("Pull and build the complete dashboard project"));
  });

  test("deploys the complete linked project, verifies immutable routes, then aliases", () => {
    expect(workflow).not.toContain("--cwd site");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} pull");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).toContain("--prebuilt");
    expect(workflow).toContain("--skip-domain");
    expect(workflow).toContain("/labs/quiet-control/");
    expect(workflow).toContain("/labs/soft-companion/");
    expect(workflow).toContain("/labs/field-console/");
    expect(workflow).toContain("alias set");
    expect(workflow).toContain("Embed the public deployment identity");
    expect(workflow).toContain("scripts/dashboard-deployment-marker.ts");
    expect(workflow).toContain(
      ".vercel/output/static/.well-known/stensibly-deployment.json",
    );
    expect(position("Pull and build the complete dashboard project"))
      .toBeLessThan(position("Embed the public deployment identity"));
    expect(position("Embed the public deployment identity"))
      .toBeLessThan(position("Create and verify an immutable production deployment"));
    expect(position("Create and verify an immutable production deployment"))
      .toBeLessThan(position("Assign the canonical domain to the verified deployment"));
  });

  test("proves the exact public source identity before recording provider current", () => {
    expect(workflow).toContain(
      'vercel@${VERCEL_CLI_VERSION} curl "/.well-known/stensibly-deployment.json"',
    );
    expect(workflow).toContain(
      'https://${DASHBOARD_HOST}/.well-known/stensibly-deployment.json?revision=${EXPECTED_REVISION}',
    );
    expect(workflow).toContain("${{ runner.temp }}/dashboard-marker-immutable.json");
    expect(workflow).toContain("${{ runner.temp }}/dashboard-marker-public.json");
    expect(workflow).toContain("DASHBOARD_DEPLOYMENT_MARKER_MODE: write");
    expect(workflow).toContain("DASHBOARD_DEPLOYMENT_MARKER_MODE: verify");
    expect(position("Embed the public deployment identity"))
      .toBeLessThan(position("Assign the canonical domain to the verified deployment"));
    expect(position("Verify the public dashboard and Labs routes"))
      .toBeLessThan(position("Record provider-current dashboard receipt"));
  });

  test("uses token environment authentication without forwarding it to native curl", () => {
    const commandStart = position(
      'vercel@${VERCEL_CLI_VERSION} curl "${route}"',
    );
    const commandEnd = workflow.indexOf('> "${output}"', commandStart);
    expect(commandEnd).toBeGreaterThan(commandStart);
    const command = workflow.slice(commandStart, commandEnd);

    expect(command).not.toContain("--token");
    expect(command.indexOf('curl "${route}"'))
      .toBeLessThan(command.indexOf('--deployment "${deployment_url}"'));
    expect(command.indexOf('--deployment "${deployment_url}"'))
      .toBeLessThan(command.indexOf("              -- "));
    expect(command.indexOf("              -- "))
      .toBeLessThan(command.indexOf("--fail --silent --show-error"));
  });

  test("verifies the public root and Labs routes before recording success", () => {
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/quiet-control/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/soft-companion/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/field-console/');
    const verify = position("Verify the public dashboard and Labs routes");
    const providerReceipt = position("Record provider-current dashboard receipt");
    const uploadReceipt = position("Upload provider-current dashboard receipt");
    const summary = position("Record publication receipt");
    expect(verify).toBeLessThan(providerReceipt);
    expect(providerReceipt).toBeLessThan(uploadReceipt);
    expect(uploadReceipt).toBeLessThan(summary);
    expect(workflow).toContain("bun scripts/dashboard-production-receipt.ts");
    expect(workflow).toContain("${{ runner.temp }}/dashboard-production-deployment-receipt.json");
    expect(workflow).toContain(
      "dashboard-production-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("source: \\`${GITHUB_SHA}\\`");
    expect(workflow).toContain("expected revision: \\`${EXPECTED_REVISION}\\`");
    expect(workflow).toContain("immutable deployment:");
  });

  test("uses only the narrow Vercel production secrets", () => {
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CONVEX_URL");

    const publish = position("  publish:");
    const steps = workflow.indexOf("    steps:", publish);
    expect(workflow.slice(publish, steps)).not.toContain("secrets.");
    const upload = position("Upload provider-current dashboard receipt");
    const summary = position("Record publication receipt");
    expect(workflow.slice(upload, summary)).not.toContain("secrets.");
    expect(workflow.slice(position("Record provider-current dashboard receipt"), upload))
      .toContain("secrets.VERCEL_TOKEN");
  });
});
