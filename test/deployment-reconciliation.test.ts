import { describe, expect, test } from "bun:test";
import {
  compileDeploymentReconciliation,
  DEPLOYMENT_RECONCILIATION_SCHEMA_VERSION,
  type DeploymentReconciliationInput,
  type TargetDeploymentObservation,
} from "../src/deployment-reconciliation.ts";

const currentSha = "a".repeat(40);
const baselineSha = "b".repeat(40);
const otherSha = "c".repeat(40);
const workerSha = "8".repeat(40);
const repository = "teamleaderleo/stensibly";

describe("deployment reconciliation decision compiler", () => {
  test("emits one stable, non-authorizing shadow contract", () => {
    const first = compileDeploymentReconciliation(fixture());
    const second = compileDeploymentReconciliation(fixture());

    expect(first.schemaVersion).toBe(DEPLOYMENT_RECONCILIATION_SCHEMA_VERSION);
    expect(first.mode).toBe("shadow");
    expect(first.authorizesMutation).toBe(false);
    expect(first.authorizesDeployment).toBe(false);
    expect(first.authorizesRetry).toBe(false);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).toEqual(second);
    expect(first.observer).toEqual({
      workflowRevision: currentSha,
      sourceRevision: currentSha,
      runId: "456",
      runAttempt: "1",
      observedAt: "2026-08-16T12:00:00.000Z",
    });
    expect(first.targets).toEqual([
      expect.objectContaining({
        target: "worker",
        decision: "classification_unknown",
        reason: "dependency_classifier_not_implemented",
        providerCurrentVerified: true,
        baselineAuthority: "public_worker_version",
        providerCurrent: {
          kind: "worker-public-version",
          sourceRevision: workerSha,
          versionId: "21f335ee-7d2e-44e8-8139-5b9939a48248",
          versionTag: `git-${workerSha}`,
          versionCreatedAt: "2026-08-16T09:11:56.892401Z",
        },
        authorizesDeployment: false,
      }),
      expect.objectContaining({
        target: "convex",
        decision: "classification_unknown",
        reason: "dependency_classifier_not_implemented",
        providerCurrentVerified: false,
        baselineAuthority: "workflow_only",
        providerCurrent: null,
        authorizesDeployment: false,
      }),
      expect.objectContaining({
        target: "dashboard",
        decision: "not_relevant",
        reason: "site_tree_unchanged",
        latestSuccessfulWorkflow: {
          runId: "700",
          runAttempt: 2,
          revision: baselineSha,
          updatedAt: "2026-08-16T10:00:00Z",
        },
        providerCurrentVerified: true,
        baselineAuthority: "public_deployment_marker",
        providerCurrent: {
          kind: "dashboard-public-marker",
          sourceRevision: baselineSha,
          workflowRunId: "700",
          workflowRunAttempt: 2,
          markerFingerprint: `sha256:${"7".repeat(64)}`,
        },
        authorizesDeployment: false,
      }),
    ]);
  });

  test("uses the complete dashboard site tree identity without authorizing a dispatch", () => {
    const changed = compileDeploymentReconciliation(fixture({
      targets: targetFixtures({ currentTreeOid: otherSha }),
    }));
    expect(changed.targets[2]).toEqual(expect.objectContaining({
      target: "dashboard",
      decision: "would_dispatch",
      reason: "site_tree_changed",
      classifier: {
        kind: "site-tree-oid",
        contractVersion: 1,
        baselineTreeOid: baselineSha,
        currentTreeOid: otherSha,
      },
      authorizesDeployment: false,
    }));
    expect(changed.authorizesDeployment).toBe(false);
  });

  test("records a newer main as waiting for a successor CI run", () => {
    const receipt = compileDeploymentReconciliation(fixture({
      currentMainRevision: otherSha,
    }));
    expect(receipt.targets.map((target) => target.decision)).toEqual([
      "waiting_current_main",
      "waiting_current_main",
      "waiting_current_main",
    ]);
    expect(receipt.targets.every((target) => target.reason === "current_main_advanced")).toBe(true);
    expect(receipt.authorizesDeployment).toBe(false);
  });

  test("distinguishes missing and non-linear workflow baselines", () => {
    const missingTargets = targetFixtures().map((target) => target.target === "dashboard"
      ? { ...target, latestSuccessfulWorkflow: null, providerCurrent: null }
      : target) as readonly TargetDeploymentObservation[];
    expect(compileDeploymentReconciliation(fixture({ targets: missingTargets })).targets[2])
      .toEqual(expect.objectContaining({
        decision: "baseline_unknown",
        reason: "no_successful_workflow_baseline",
      }));

    const divergedTargets = targetFixtures({ currentTreeOid: otherSha }).map((target) =>
      target.target === "dashboard" ? { ...target, history: "diverged" as const } : target);
    expect(compileDeploymentReconciliation(fixture({ targets: divergedTargets })).targets[2])
      .toEqual(expect.objectContaining({
        decision: "history_not_linear",
        reason: "baseline_not_ancestor",
      }));
  });

  test("rejects receipt, run, repository, topology, and artifact identity drift", () => {
    expect(() => compileDeploymentReconciliation(fixture({
      repository: "other/repository",
    }))).toThrow("repository identity");
    expect(() => compileDeploymentReconciliation(fixture({
      ciRun: { ...fixture().ciRun, eventName: "push", headBranch: "main", workflowName: "CI", workflowPath: ".github/workflows/ci.yml", status: "completed", conclusion: "success", headRevision: otherSha },
    }))).toThrow("source revision");
    expect(() => compileDeploymentReconciliation(fixture({
      ciArtifact: { ...fixture().ciArtifact, name: "exact-ref-validation-receipt-123-2" },
    }))).toThrow("artifact name");
    expect(() => compileDeploymentReconciliation(fixture({
      ciReceipt: { ...exactReceipt(), status: "failure" },
    }))).toThrow("successful full-parallel");
    expect(() => compileDeploymentReconciliation(fixture({
      ciReceipt: { ...exactReceipt(), unexpected: true },
    }))).toThrow("fields are not exact");
    expect(() => compileDeploymentReconciliation(fixture({
      ciReceipt: {
        ...exactReceipt(),
        jobs: { ...exactReceipt().jobs, repositoryTests: "failure" },
      },
    }))).toThrow("job topology");
    expect(() => compileDeploymentReconciliation(fixture({
      targets: targetFixtures().map((target) => target.target === "dashboard"
        ? {
          ...target,
          providerCurrent: {
            ...target.providerCurrent!,
            workflowRunId: "701",
          },
        }
        : target),
    }))).toThrow("does not bind its workflow baseline");
    expect(() => compileDeploymentReconciliation(fixture({
      targets: targetFixtures().map((target) => target.target === "dashboard"
        ? {
          ...target,
          classifier: {
            kind: "unavailable" as const,
            contractVersion: 1 as const,
            reason: "provider_current_observation_failed" as const,
          },
        }
        : target),
    }))).toThrow("evidence and classifier are incoherent");
    expect(() => compileDeploymentReconciliation(fixture({
      targets: targetFixtures().map((target) => target.target === "worker"
        ? {
          ...target,
          providerCurrent: {
            ...target.providerCurrent!,
            versionTag: `git-${otherSha}`,
          },
        }
        : target),
    }))).toThrow("version tag is invalid");
  });

  test("requires the observer workflow and checked-out source to be the admitted CI head", () => {
    expect(() => compileDeploymentReconciliation(fixture({
      observerWorkflowRevision: otherSha,
    }))).toThrow("Observer workflow and source revisions");
    expect(() => compileDeploymentReconciliation(fixture({
      observerSourceRevision: otherSha,
    }))).toThrow("Observer workflow and source revisions");
  });
});

function fixture(
  override: Partial<DeploymentReconciliationInput> = {},
): DeploymentReconciliationInput {
  return {
    repositoryId: "1310091990",
    repository,
    observerWorkflowRevision: currentSha,
    observerSourceRevision: currentSha,
    observerRunId: "456",
    observerRunAttempt: "1",
    currentMainRevision: currentSha,
    ciRun: {
      repositoryId: "1310091990",
      repository,
      runId: "123",
      runAttempt: "1",
      workflowId: "319014676",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      eventName: "push",
      headBranch: "main",
      headRevision: currentSha,
      status: "completed",
      conclusion: "success",
    },
    ciArtifact: {
      artifactId: "789",
      name: "exact-ref-validation-receipt-123-1",
      sizeBytes: 818,
      archiveDigest: `sha256:${"d".repeat(64)}`,
      contentDigest: `sha256:${"e".repeat(64)}`,
      expired: false,
    },
    ciReceipt: exactReceipt(),
    targets: targetFixtures(),
    observedAt: "2026-08-16T12:00:00.000Z",
    ...override,
  };
}

function exactReceipt() {
  return {
    schemaVersion: "stensibly-ci-exact-ref-receipt/1",
    repository,
    eventName: "push",
    sourceRevision: currentSha,
    eventRevision: currentSha,
    workflowRevision: currentSha,
    workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
    validationProfile: "full_parallel",
    inputValid: true,
    status: "success",
    jobs: {
      browserEvidence: "success",
      repositoryTests: "success",
      runtimeParity: "success",
      serialFull: "skipped",
    },
    run: {
      id: "123",
      attempt: "1",
      url: `https://github.com/${repository}/actions/runs/123`,
    },
    completedAt: "2026-08-16T11:59:00Z",
  };
}

function targetFixtures(
  dashboard: Partial<Readonly<{ baselineTreeOid: string; currentTreeOid: string }>> = {},
): readonly TargetDeploymentObservation[] {
  return [
    {
      target: "worker",
      workflowPath: ".github/workflows/deploy-worker.yml",
      latestSuccessfulWorkflow: null,
      providerCurrent: {
        kind: "worker-public-version",
        sourceRevision: workerSha,
        versionId: "21f335ee-7d2e-44e8-8139-5b9939a48248",
        versionTag: `git-${workerSha}`,
        versionCreatedAt: "2026-08-16T09:11:56.892401Z",
      },
      history: "unknown",
      classifier: {
        kind: "unavailable",
        contractVersion: 1,
        reason: "dependency_classifier_not_implemented",
      },
    },
    {
      target: "convex",
      workflowPath: ".github/workflows/deploy-convex.yml",
      latestSuccessfulWorkflow: null,
      providerCurrent: null,
      history: "unknown",
      classifier: {
        kind: "unavailable",
        contractVersion: 1,
        reason: "dependency_classifier_not_implemented",
      },
    },
    {
      target: "dashboard",
      workflowPath: ".github/workflows/publish-dashboard-on-main.yml",
      latestSuccessfulWorkflow: {
        runId: "700",
        runAttempt: 2,
        revision: baselineSha,
        updatedAt: "2026-08-16T10:00:00Z",
      },
      providerCurrent: {
        kind: "dashboard-public-marker",
        sourceRevision: baselineSha,
        workflowRunId: "700",
        workflowRunAttempt: 2,
        markerFingerprint: `sha256:${"7".repeat(64)}`,
      },
      history: "ahead",
      classifier: {
        kind: "site-tree-oid",
        contractVersion: 1,
        baselineTreeOid: dashboard.baselineTreeOid ?? baselineSha,
        currentTreeOid: dashboard.currentTreeOid ?? baselineSha,
      },
    },
  ];
}
