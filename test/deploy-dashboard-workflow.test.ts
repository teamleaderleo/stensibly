import { describe, expect, test } from "bun:test";
import { safeVercelOrigin } from "../src/dashboard-deployment-diagnostics.ts";

const workflowPath = new URL("../.github/workflows/deploy-dashboard.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

function position(value: string): number {
  const index = workflow.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("production dashboard deployment workflow", () => {
  test("is manual, main-only, serialized, and environment-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain("group: stensibly-dashboard-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  test("runs secret-free candidate checks before production approval", () => {
    expect(workflow).toContain("name: Validate dashboard production candidate");
    expect(workflow).toContain("needs: test");
    expect(position("name: Validate dashboard production candidate"))
      .toBeLessThan(position("environment:"));
    expect(position("bun run worker:check"))
      .toBeLessThan(position("environment:"));
    const candidate = workflow.slice(position("test:"), position("deploy:"));
    expect(candidate).not.toContain("secrets.");
    expect(candidate).toContain("bun install --frozen-lockfile");
    expect(candidate).toContain("bun run typecheck");
    expect(candidate).toContain("bun run test");
    expect(candidate).toContain("bun run test:convex");
    expect(candidate).toContain(
      "bun run verify:dashboard -- --html-file site/index.html --github-annotation",
    );
    expect(candidate).toContain("name: Record candidate rejection");
    expect(candidate).toContain("Candidate validation failed before production credentials were used");
  });

  test("uses a pinned Vercel CLI and only dashboard deployment secrets", () => {
    expect(workflow).toContain("VERCEL_CLI_VERSION: 56.5.0");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION}");
    expect(workflow).not.toContain("vercel@latest");
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CONVEX_URL");
  });

  test("requires the existing stensibly project and configured site root", () => {
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain("api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}");
    expect(workflow).toContain("project_name");
    expect(workflow).toContain('!= "${EXPECTED_VERCEL_PROJECT}"');
    expect(workflow).toContain("rootDirectory // empty");
    expect(workflow).toContain('!= "site"');
    expect(position("Require the stensibly Vercel project"))
      .toBeLessThan(position("Pull production project settings"));
    expect(workflow).toContain(".vercel/project.json");
    expect(workflow).toContain(".projectId == $project and .orgId == $org");
    expect(workflow).toContain("title=Wrong Vercel Root Directory");
    expect(workflow).not.toContain("stensibly-api");
  });

  test("builds from the repository root, stages without domains, verifies, then promotes once", () => {
    expect(workflow).not.toContain("--cwd site");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).toContain(".vercel/output/config.json");
    expect(workflow).toContain(".vercel/output/static");
    expect(workflow).toContain("--prebuilt");
    expect(workflow).toContain("--prod");
    expect(workflow).toContain("--skip-domain");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} curl /");
    expect(workflow).toContain("--deployment \"${DEPLOYMENT_URL}\"");
    expect(workflow.match(/vercel@\$\{VERCEL_CLI_VERSION\} promote/g)).toHaveLength(1);
    expect(position("Create staged production deployment"))
      .toBeLessThan(position("Verify staged deployment"));
    expect(position("Verify staged deployment"))
      .toBeLessThan(position("Promote verified deployment"));
  });

  test("keeps staged asset and MIME checks aligned with the production verifier", () => {
    expect(workflow).toContain("bun src/dashboard-assets.ts > /tmp/dashboard-assets.json");
    expect(workflow).toContain("jq --exit-status");
    expect(workflow).toContain('.kind == "css" or .kind == "javascript" or .kind == "svg"');
    expect(workflow).toContain('.contentTypes | type == "array"');
    expect(workflow).toContain("all(.contentTypes[]; type == \"string\"");
    expect(workflow).toContain("while IFS=$'\\t' read -r asset kind allowed_content_types marker; do");
    expect(workflow).toContain("--write-out '%{content_type}\\n'");
    expect(workflow).toContain('media_type="${content_type%%;*}"');
    expect(workflow).toContain("grep --fixed-strings --ignore-case --line-regexp --quiet");
    expect(workflow).toContain("returned an unexpected content type for ${kind}");
    expect(workflow).toContain(
      "jq -r '.[] | [.path, .kind, (.contentTypes | join(\",\")), .marker] | @tsv'",
    );
    expect(workflow).not.toContain("asset_specs=(");
    expect(workflow).not.toContain("all(.[ ]; false)");
    expect(workflow).toContain("grep --fixed-strings --quiet");
    expect(workflow).toContain("title=Staged dashboard verification failed");
    expect(workflow).toContain("stn\\.tok_[A-Za-z0-9._-]+");
    expect(position("bun src/dashboard-assets.ts"))
      .toBeLessThan(position("Promote verified deployment"));
  });

  test("labels retries and emits the precise verifier annotation on the final attempt", () => {
    expect(workflow).toContain("production verification attempt ${attempt}/3");
    expect(workflow).toContain('verify_args+=(--github-annotation)');
    expect(workflow).toContain("retrying in ${delay} seconds");
    expect(workflow).toContain("title=Post-promotion dashboard verification failed");
    expect(workflow).toContain("Promotion completed");
    expect(workflow).not.toContain("Use an explicit Vercel rollback decision");
  });

  test("uploads one sanitised JSON fallback for failures before checkout or Bun setup", () => {
    expect(workflow.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(2);
    expect(workflow).toContain("name: Prepare candidate diagnostics fallback");
    expect(workflow).toContain("name: Prepare deployment diagnostics fallback");
    expect(workflow).toContain('"completeness": "fallback"');
    expect(workflow).toContain('"failurePhase": "workflowPrerequisite"');
    expect(workflow).toContain("bun src/dashboard-deployment-diagnostics.ts");
    expect(workflow).toContain("--mode candidate");
    expect(workflow).toContain("--mode deploy");
    expect(workflow).toContain(
      "name: dashboard-candidate-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "name: dashboard-deployment-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "path: /tmp/stensibly-dashboard-candidate-diagnostics/report.json",
    );
    expect(workflow).toContain(
      "path: /tmp/stensibly-dashboard-deployment-diagnostics/report.json",
    );
    expect(workflow.match(/if-no-files-found: error/g)).toHaveLength(2);
    expect(workflow).not.toContain("if-no-files-found: warn");
    expect(workflow.match(/retention-days: 14/g)).toHaveLength(2);
    expect(workflow).not.toContain("path: /tmp/dashboard-index.html");
    expect(workflow).not.toContain("path: /tmp/dashboard-asset-");

    const candidateJob = workflow.slice(position("  test:"), position("  deploy:"));
    expect(candidateJob.indexOf("Prepare candidate diagnostics fallback"))
      .toBeLessThan(candidateJob.indexOf("Require main branch"));
    const deployJob = workflow.slice(position("  deploy:"));
    expect(deployJob.indexOf("Prepare deployment diagnostics fallback"))
      .toBeLessThan(deployJob.indexOf("Require main branch"));

    const candidateUpload = workflow.slice(
      position("- name: Upload candidate diagnostics"),
      position("  deploy:"),
    );
    expect(candidateUpload).toContain("if: ${{ failure() }}");
    const deployUpload = workflow.slice(position("- name: Upload deployment diagnostics"));
    expect(deployUpload).toContain("if: ${{ failure() }}");
    expect(position("Record candidate rejection"))
      .toBeLessThan(position("Upload candidate diagnostics"));
    expect(position("Record deployment report"))
      .toBeLessThan(position("Upload deployment diagnostics"));
  });

  test("uses the same origin-only Vercel validation for staging and reporting", () => {
    expect(workflow.match(/--safe-vercel-origin/g)).toHaveLength(2);
    expect(workflow).not.toContain("== https://*.vercel.app");
    expect(safeVercelOrigin("https://candidate.vercel.app/path")).toBeNull();
    expect(safeVercelOrigin("https://candidate.vercel.app?bypass=secret")).toBeNull();
  });

  test("always records phase outcomes and whether production changed", () => {
    expect(workflow).toContain("name: Record deployment report");
    expect(workflow).toContain("if: ${{ always() }}");
    for (const id of [
      "id: secrets",
      "id: project",
      "id: pull_settings",
      "id: linked_project",
      "id: build",
      "id: build_output",
      "id: stage",
      "id: staged_verify",
      "id: promote",
      "id: production_verify",
    ]) {
      expect(workflow).toContain(id);
    }
    expect(workflow).toContain("**Production state:** ${production_state}.");
    expect(workflow).toContain("changed and verified");
    expect(workflow).toContain("changed; post-promotion verification did not pass");
    expect(workflow).toContain("A staged deployment was created but was not promoted");
    expect(workflow).toContain("| Production verification |");
    expect(workflow).toContain("no bypass credentials included");
  });
});
