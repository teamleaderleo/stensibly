import { describe, expect, test } from "bun:test";
import { dashboardAssets } from "../src/dashboard-assets.ts";
import {
  buildDashboardDeploymentDiagnostics,
  DASHBOARD_DIAGNOSTICS_FORMAT,
  safeVercelOrigin,
  serializeDashboardDeploymentDiagnostics,
} from "../src/dashboard-deployment-diagnostics.ts";

const runEnvironment = {
  GITHUB_REPOSITORY: "teamleaderleo/stensibly",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SHA: "a".repeat(40),
  DASHBOARD_URL: "https://www.stensibly.com",
};

describe("dashboard deployment diagnostics", () => {
  test("classifies candidate failure without copying secret-bearing environment values", () => {
    const secret = "stn.tok_private-value";
    const diagnostics = buildDashboardDeploymentDiagnostics("candidate", {
      ...runEnvironment,
      VERCEL_TOKEN: secret,
      VERCEL_PROJECT_ID: "prj_secret_identifier",
      VERCEL_ORG_ID: "team_secret_identifier",
      STENSIBLY_TOKEN: secret,
      DEPLOYMENT_URL: `https://candidate.vercel.app/?bypass=${secret}`,
      UNRELATED_SECRET: secret,
    }, new Date("2026-07-25T00:00:00.000Z"));
    const serialized = serializeDashboardDeploymentDiagnostics(diagnostics);

    expect(diagnostics).toMatchObject({
      format: DASHBOARD_DIAGNOSTICS_FORMAT,
      schemaVersion: 1,
      mode: "candidate",
      completeness: "full",
      run: {
        repository: "teamleaderleo/stensibly",
        runId: "123456789",
        runAttempt: "2",
        commit: "a".repeat(40),
        url: "https://github.com/teamleaderleo/stensibly/actions/runs/123456789",
      },
      deployment: {
        productionDomain: "https://www.stensibly.com",
        stagedDeployment: null,
        productionState: "unchanged",
      },
      phases: {
        candidateValidation: "failed",
        stagedDeployment: "not_run",
        promotion: "not_run",
      },
      failurePhase: "candidateValidation",
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("prj_secret_identifier");
    expect(serialized).not.toContain("team_secret_identifier");
    expect(serialized).not.toContain("bypass");
  });

  test("classifies staged-only and post-promotion failures from whitelisted outcomes", () => {
    const stagedOnly = buildDashboardDeploymentDiagnostics("deploy", {
      ...runEnvironment,
      DEPLOYMENT_URL: "https://stensibly-example.vercel.app",
      SECRETS_OUTCOME: "success",
      PROJECT_OUTCOME: "success",
      PULL_SETTINGS_OUTCOME: "success",
      LINKED_PROJECT_OUTCOME: "success",
      BUILD_OUTCOME: "success",
      BUILD_OUTPUT_OUTCOME: "success",
      STAGE_OUTCOME: "success",
      STAGED_VERIFY_OUTCOME: "failure",
      PROMOTE_OUTCOME: "skipped",
      PRODUCTION_VERIFY_OUTCOME: "skipped",
    }, new Date("2026-07-25T00:00:00.000Z"));
    expect(stagedOnly.deployment).toEqual({
      productionDomain: "https://www.stensibly.com",
      stagedDeployment: "https://stensibly-example.vercel.app",
      productionState: "unchanged_staged_only",
    });
    expect(stagedOnly.failurePhase).toBe("stagedVerification");

    const promoted = buildDashboardDeploymentDiagnostics("deploy", {
      ...runEnvironment,
      DEPLOYMENT_URL: "https://stensibly-example.vercel.app",
      SECRETS_OUTCOME: "success",
      PROJECT_OUTCOME: "success",
      PULL_SETTINGS_OUTCOME: "success",
      LINKED_PROJECT_OUTCOME: "success",
      BUILD_OUTCOME: "success",
      BUILD_OUTPUT_OUTCOME: "success",
      STAGE_OUTCOME: "success",
      STAGED_VERIFY_OUTCOME: "success",
      PROMOTE_OUTCOME: "success",
      PRODUCTION_VERIFY_OUTCOME: "failure",
    }, new Date("2026-07-25T00:00:00.000Z"));
    expect(promoted.deployment.productionState).toBe("changed_unverified");
    expect(promoted.failurePhase).toBe("productionVerification");
  });

  test("reports verified promotion and rejects unsafe metadata instead of echoing it", () => {
    const secret = "unsafe-secret";
    const diagnostics = buildDashboardDeploymentDiagnostics("deploy", {
      GITHUB_REPOSITORY: `teamleaderleo/stensibly?token=${secret}`,
      GITHUB_RUN_ID: `123-${secret}`,
      GITHUB_RUN_ATTEMPT: secret,
      GITHUB_SHA: secret,
      DASHBOARD_URL: `https://www.stensibly.com/?token=${secret}`,
      DEPLOYMENT_URL: `https://user:${secret}@candidate.vercel.app`,
      SECRETS_OUTCOME: "success",
      PROJECT_OUTCOME: "success",
      PULL_SETTINGS_OUTCOME: "success",
      LINKED_PROJECT_OUTCOME: "success",
      BUILD_OUTCOME: "success",
      BUILD_OUTPUT_OUTCOME: "success",
      STAGE_OUTCOME: "success",
      STAGED_VERIFY_OUTCOME: "success",
      PROMOTE_OUTCOME: "success",
      PRODUCTION_VERIFY_OUTCOME: "success",
      EXTRA_OUTCOME: secret,
    }, new Date("2026-07-25T00:00:00.000Z"));
    const serialized = serializeDashboardDeploymentDiagnostics(diagnostics);

    expect(diagnostics.deployment.productionState).toBe("changed_verified");
    expect(diagnostics.failurePhase).toBeNull();
    expect(diagnostics.run).toEqual({
      repository: null,
      runId: null,
      runAttempt: null,
      commit: null,
      url: null,
    });
    expect(diagnostics.deployment.productionDomain).toBeNull();
    expect(diagnostics.deployment.stagedDeployment).toBeNull();
    expect(serialized).not.toContain(secret);
  });

  test("accepts only origin-only staged Vercel URLs", () => {
    expect(safeVercelOrigin("https://candidate.vercel.app"))
      .toBe("https://candidate.vercel.app");
    expect(safeVercelOrigin("https://candidate.vercel.app/preview")).toBeNull();
    expect(safeVercelOrigin("https://candidate.vercel.app?bypass=secret")).toBeNull();
    expect(safeVercelOrigin("https://candidate.vercel.app#fragment")).toBeNull();
    expect(safeVercelOrigin("https://candidate.vercel.app:8443")).toBeNull();
    expect(safeVercelOrigin("https://vercel.app")).toBeNull();
  });

  test("keeps the schema stable and records the active verifier contract", () => {
    const diagnostics = buildDashboardDeploymentDiagnostics("deploy", runEnvironment, new Date(0));
    expect(diagnostics.generatedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(diagnostics.completeness).toBe("full");
    expect(diagnostics.verifier).toMatchObject({
      assetContract: "src/dashboard-assets.ts",
      assetCount: dashboardAssets.length,
      productionVerifier: "src/verify-dashboard.ts",
    });
    expect(Object.keys(diagnostics.phases)).toEqual([
      "candidateValidation",
      "productionSecrets",
      "vercelProjectValidation",
      "pullProjectSettings",
      "linkedProjectValidation",
      "productionBuild",
      "buildOutputValidation",
      "stagedDeployment",
      "stagedVerification",
      "promotion",
      "productionVerification",
    ]);
  });
});
