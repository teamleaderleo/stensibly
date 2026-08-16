import { sha256, stableJson } from "./canonical-json.js";

export const DEPLOYMENT_RECONCILIATION_SCHEMA_VERSION =
  "stensibly-deployment-reconciliation-decision/3" as const;

export type DeploymentTarget = "worker" | "convex" | "dashboard";
export type DeploymentReconciliationDecision =
  | "would_dispatch"
  | "not_relevant"
  | "waiting_current_main"
  | "baseline_unknown"
  | "classification_unknown"
  | "history_not_linear";

export interface ExactCiRunObservation {
  readonly repositoryId: string;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly workflowId: string;
  readonly workflowName: "CI";
  readonly workflowPath: ".github/workflows/ci.yml";
  readonly eventName: "push";
  readonly headBranch: "main";
  readonly headRevision: string;
  readonly status: "completed";
  readonly conclusion: "success";
}

export interface ExactCiArtifactObservation {
  readonly artifactId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly archiveDigest: string;
  readonly contentDigest: string;
  readonly expired: false;
}

export interface SuccessfulDeploymentWorkflowObservation {
  readonly runId: string;
  readonly runAttempt: number;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface DashboardProviderCurrentDeploymentObservation {
  readonly kind: "dashboard-public-marker";
  readonly sourceRevision: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly markerFingerprint: string;
}

export interface WorkerProviderCurrentDeploymentObservation {
  readonly kind: "worker-public-version";
  readonly sourceRevision: string;
  readonly versionId: string;
  readonly versionTag: string;
  readonly versionCreatedAt: string;
}

export type ProviderCurrentDeploymentObservation =
  | DashboardProviderCurrentDeploymentObservation
  | WorkerProviderCurrentDeploymentObservation;

export interface TargetDeploymentObservation {
  readonly target: DeploymentTarget;
  readonly workflowPath:
    | ".github/workflows/deploy-worker.yml"
    | ".github/workflows/deploy-convex.yml"
    | ".github/workflows/publish-dashboard-on-main.yml";
  readonly latestSuccessfulWorkflow: SuccessfulDeploymentWorkflowObservation | null;
  readonly providerCurrent: ProviderCurrentDeploymentObservation | null;
  readonly history: "ahead" | "identical" | "behind" | "diverged" | "unknown";
  readonly classifier:
    | Readonly<{
      kind: "site-tree-oid";
      contractVersion: 1;
      baselineTreeOid: string;
      currentTreeOid: string;
    }>
    | Readonly<{
      kind: "unavailable";
      contractVersion: 1;
      reason:
        | "dependency_classifier_not_implemented"
        | "site_tree_observation_failed"
        | "provider_current_observation_failed";
    }>;
}

export interface DeploymentReconciliationInput {
  readonly repositoryId: string;
  readonly repository: string;
  readonly observerWorkflowRevision: string;
  readonly observerSourceRevision: string;
  readonly observerRunId: string;
  readonly observerRunAttempt: string;
  readonly currentMainRevision: string;
  readonly ciRun: ExactCiRunObservation;
  readonly ciArtifact: ExactCiArtifactObservation;
  readonly ciReceipt: unknown;
  readonly targets: readonly TargetDeploymentObservation[];
  readonly observedAt: string;
}

export interface AdmittedExactCiReceipt {
  readonly schemaVersion: "stensibly-ci-exact-ref-receipt/1";
  readonly repository: string;
  readonly eventName: "push";
  readonly sourceRevision: string;
  readonly eventRevision: string;
  readonly workflowRevision: string;
  readonly workflowRef: string;
  readonly validationProfile: "full_parallel";
  readonly inputValid: true;
  readonly status: "success";
  readonly jobs: Readonly<{
    browserEvidence: "success";
    repositoryTests: "success";
    runtimeParity: "success";
    serialFull: "skipped";
  }>;
  readonly run: Readonly<{
    id: string;
    attempt: string;
    url: string;
  }>;
  readonly completedAt: string;
}

export interface DeploymentReconciliationReceipt {
  readonly schemaVersion: typeof DEPLOYMENT_RECONCILIATION_SCHEMA_VERSION;
  readonly mode: "shadow";
  readonly repository: Readonly<{ id: string; fullName: string }>;
  readonly observer: Readonly<{
    workflowRevision: string;
    sourceRevision: string;
    runId: string;
    runAttempt: string;
    observedAt: string;
  }>;
  readonly ci: Readonly<{
    runId: string;
    runAttempt: string;
    workflowId: string;
    workflowPath: ".github/workflows/ci.yml";
    workflowRevision: string;
    sourceRevision: string;
    validationProfile: "full_parallel";
    artifactId: string;
    artifactName: string;
    artifactArchiveDigest: string;
    receiptContentDigest: string;
  }>;
  readonly currentMainRevision: string;
  readonly targets: ReadonlyArray<Readonly<{
    target: DeploymentTarget;
    decision: DeploymentReconciliationDecision;
    latestSuccessfulWorkflow: SuccessfulDeploymentWorkflowObservation | null;
    baselineAuthority:
      | "workflow_only"
      | "public_deployment_marker"
      | "public_worker_version";
    providerCurrentVerified: boolean;
    providerCurrent: ProviderCurrentDeploymentObservation | null;
    classifier: TargetDeploymentObservation["classifier"];
    history: TargetDeploymentObservation["history"];
    reason:
      | "current_main_advanced"
      | "no_successful_workflow_baseline"
      | "dependency_classifier_not_implemented"
      | "site_tree_observation_failed"
      | "provider_current_observation_failed"
      | "baseline_not_ancestor"
      | "site_tree_unchanged"
      | "site_tree_changed";
    authorizesDeployment: false;
  }>>;
  readonly authorizesMutation: false;
  readonly authorizesDeployment: false;
  readonly authorizesRetry: false;
  readonly fingerprint: string;
}

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const numericIdPattern = /^[1-9][0-9]{0,19}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const workflowPath = ".github/workflows/ci.yml" as const;

export function admitExactCiReceipt(
  value: unknown,
  expected: Readonly<{
    repository: string;
    runId: string;
    runAttempt: string;
    sourceRevision: string;
  }>,
): AdmittedExactCiReceipt {
  requireRepository(expected.repository, "Expected repository");
  requireNumericId(expected.runId, "Expected CI run ID");
  requireNumericId(expected.runAttempt, "Expected CI run attempt");
  requireSha(expected.sourceRevision, "Expected CI source revision");

  const receipt = exactRecord(value, "CI receipt", [
    "schemaVersion",
    "repository",
    "eventName",
    "sourceRevision",
    "eventRevision",
    "workflowRevision",
    "workflowRef",
    "validationProfile",
    "inputValid",
    "status",
    "jobs",
    "run",
    "completedAt",
  ]);
  if (receipt.schemaVersion !== "stensibly-ci-exact-ref-receipt/1") {
    throw new Error("CI receipt schema version is unsupported");
  }
  if (receipt.repository !== expected.repository || receipt.eventName !== "push") {
    throw new Error("CI receipt repository or event does not match the exact main push");
  }
  for (const [label, revision] of [
    ["source", receipt.sourceRevision],
    ["event", receipt.eventRevision],
    ["workflow", receipt.workflowRevision],
  ] as const) {
    requireSha(revision, `CI receipt ${label} revision`);
    if (revision !== expected.sourceRevision) {
      throw new Error(`CI receipt ${label} revision does not match the triggering head`);
    }
  }
  const expectedWorkflowRef = `${expected.repository}/${workflowPath}@refs/heads/main`;
  if (receipt.workflowRef !== expectedWorkflowRef) {
    throw new Error("CI receipt workflow ref does not identify CI on main");
  }
  if (
    receipt.validationProfile !== "full_parallel"
    || receipt.inputValid !== true
    || receipt.status !== "success"
  ) {
    throw new Error("CI receipt does not prove successful full-parallel validation");
  }
  const jobs = exactRecord(receipt.jobs, "CI receipt jobs", [
    "browserEvidence",
    "repositoryTests",
    "runtimeParity",
    "serialFull",
  ]);
  if (
    jobs.browserEvidence !== "success"
    || jobs.repositoryTests !== "success"
    || jobs.runtimeParity !== "success"
    || jobs.serialFull !== "skipped"
  ) {
    throw new Error("CI receipt job topology is not the successful main-push topology");
  }
  const run = exactRecord(receipt.run, "CI receipt run", ["id", "attempt", "url"]);
  if (run.id !== expected.runId || run.attempt !== expected.runAttempt) {
    throw new Error("CI receipt run identity does not match the triggering run");
  }
  const expectedRunUrl = `https://github.com/${expected.repository}/actions/runs/${expected.runId}`;
  if (run.url !== expectedRunUrl) throw new Error("CI receipt run URL is not canonical");
  const completedAt = requireTimestamp(receipt.completedAt, "CI receipt completion time");

  return Object.freeze({
    schemaVersion: "stensibly-ci-exact-ref-receipt/1",
    repository: expected.repository,
    eventName: "push",
    sourceRevision: expected.sourceRevision,
    eventRevision: expected.sourceRevision,
    workflowRevision: expected.sourceRevision,
    workflowRef: expectedWorkflowRef,
    validationProfile: "full_parallel",
    inputValid: true,
    status: "success",
    jobs: Object.freeze({
      browserEvidence: "success",
      repositoryTests: "success",
      runtimeParity: "success",
      serialFull: "skipped",
    }),
    run: Object.freeze({ id: expected.runId, attempt: expected.runAttempt, url: expectedRunUrl }),
    completedAt,
  });
}

export function compileDeploymentReconciliation(
  input: DeploymentReconciliationInput,
): DeploymentReconciliationReceipt {
  const repositoryId = requireNumericId(input.repositoryId, "Repository ID");
  const repository = requireRepository(input.repository, "Repository");
  const observerWorkflowRevision = requireSha(
    input.observerWorkflowRevision,
    "Observer workflow revision",
  );
  const observerSourceRevision = requireSha(
    input.observerSourceRevision,
    "Observer source revision",
  );
  const observerRunId = requireNumericId(input.observerRunId, "Observer run ID");
  const observerRunAttempt = requireNumericId(input.observerRunAttempt, "Observer run attempt");
  const currentMainRevision = requireSha(input.currentMainRevision, "Current main revision");
  const observedAt = requireTimestamp(input.observedAt, "Observation time");
  const ciRun = admitCiRun(input.ciRun, repositoryId, repository);
  if (
    observerWorkflowRevision !== ciRun.headRevision
    || observerSourceRevision !== ciRun.headRevision
  ) {
    throw new Error("Observer workflow and source revisions must match the admitted CI head");
  }
  const ciArtifact = admitCiArtifact(input.ciArtifact, ciRun);
  const ciReceipt = admitExactCiReceipt(input.ciReceipt, {
    repository,
    runId: ciRun.runId,
    runAttempt: ciRun.runAttempt,
    sourceRevision: ciRun.headRevision,
  });
  const targets = admitTargets(input.targets).map((target) => compileTarget(
    target,
    currentMainRevision,
    ciRun.headRevision,
  ));

  const body = Object.freeze({
    schemaVersion: DEPLOYMENT_RECONCILIATION_SCHEMA_VERSION,
    mode: "shadow" as const,
    repository: Object.freeze({ id: repositoryId, fullName: repository }),
    observer: Object.freeze({
      workflowRevision: observerWorkflowRevision,
      sourceRevision: observerSourceRevision,
      runId: observerRunId,
      runAttempt: observerRunAttempt,
      observedAt,
    }),
    ci: Object.freeze({
      runId: ciRun.runId,
      runAttempt: ciRun.runAttempt,
      workflowId: ciRun.workflowId,
      workflowPath: ciRun.workflowPath,
      workflowRevision: ciReceipt.workflowRevision,
      sourceRevision: ciReceipt.sourceRevision,
      validationProfile: ciReceipt.validationProfile,
      artifactId: ciArtifact.artifactId,
      artifactName: ciArtifact.name,
      artifactArchiveDigest: ciArtifact.archiveDigest,
      receiptContentDigest: ciArtifact.contentDigest,
    }),
    currentMainRevision,
    targets: Object.freeze(targets),
    authorizesMutation: false as const,
    authorizesDeployment: false as const,
    authorizesRetry: false as const,
  });
  return Object.freeze({ ...body, fingerprint: sha256(stableJson(body)) });
}

function admitCiRun(
  input: ExactCiRunObservation,
  repositoryId: string,
  repository: string,
): ExactCiRunObservation {
  if (input.repositoryId !== repositoryId || input.repository !== repository) {
    throw new Error("CI run repository identity does not match the observer repository");
  }
  requireNumericId(input.runId, "CI run ID");
  requireNumericId(input.runAttempt, "CI run attempt");
  requireNumericId(input.workflowId, "CI workflow ID");
  requireSha(input.headRevision, "CI head revision");
  if (
    input.workflowName !== "CI"
    || input.workflowPath !== workflowPath
    || input.eventName !== "push"
    || input.headBranch !== "main"
    || input.status !== "completed"
    || input.conclusion !== "success"
  ) {
    throw new Error("CI run is not an exact successful main push from the canonical workflow");
  }
  return Object.freeze({ ...input });
}

function admitCiArtifact(
  input: ExactCiArtifactObservation,
  ciRun: ExactCiRunObservation,
): ExactCiArtifactObservation {
  requireNumericId(input.artifactId, "CI artifact ID");
  const expectedName = `exact-ref-validation-receipt-${ciRun.runId}-${ciRun.runAttempt}`;
  if (input.name !== expectedName) throw new Error("CI receipt artifact name is not exact");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 16_384) {
    throw new Error("CI receipt artifact exceeds the bounded size");
  }
  requireDigest(input.archiveDigest, "CI artifact archive digest");
  requireDigest(input.contentDigest, "CI receipt content digest");
  if (input.expired !== false) throw new Error("CI receipt artifact is expired");
  return Object.freeze({ ...input });
}

function admitTargets(
  targets: readonly TargetDeploymentObservation[],
): readonly TargetDeploymentObservation[] {
  if (!Array.isArray(targets) || targets.length !== 3) {
    throw new Error("Deployment reconciliation requires exactly three target observations");
  }
  const expectedPaths: Readonly<Record<DeploymentTarget, TargetDeploymentObservation["workflowPath"]>> = {
    worker: ".github/workflows/deploy-worker.yml",
    convex: ".github/workflows/deploy-convex.yml",
    dashboard: ".github/workflows/publish-dashboard-on-main.yml",
  };
  const seen = new Set<DeploymentTarget>();
  for (const target of targets) {
    const targetName: DeploymentTarget = target.target;
    if (!(["worker", "convex", "dashboard"] as readonly string[]).includes(targetName)) {
      throw new Error("Deployment reconciliation target is unsupported");
    }
    if (seen.has(targetName)) throw new Error("Deployment reconciliation target is duplicated");
    seen.add(targetName);
    if (target.workflowPath !== expectedPaths[targetName]) {
      throw new Error(`Deployment workflow path for ${target.target} is not canonical`);
    }
    if (target.latestSuccessfulWorkflow !== null) {
      requireNumericId(target.latestSuccessfulWorkflow.runId, `${target.target} workflow baseline run ID`);
      if (
        !Number.isInteger(target.latestSuccessfulWorkflow.runAttempt)
        || target.latestSuccessfulWorkflow.runAttempt < 1
        || target.latestSuccessfulWorkflow.runAttempt > 1_000_000
      ) {
        throw new Error(`${target.target} workflow baseline run attempt is invalid`);
      }
      requireSha(target.latestSuccessfulWorkflow.revision, `${target.target} workflow baseline revision`);
      requireTimestamp(target.latestSuccessfulWorkflow.updatedAt, `${target.target} workflow baseline update time`);
    }
    if (target.providerCurrent?.kind === "dashboard-public-marker") {
      if (target.target !== "dashboard" || target.latestSuccessfulWorkflow === null) {
        throw new Error("Only a dashboard workflow baseline may bind its public marker");
      }
      requireSha(target.providerCurrent.sourceRevision, "Dashboard provider-current source revision");
      requireNumericId(target.providerCurrent.workflowRunId, "Dashboard provider-current run ID");
      if (!Number.isInteger(target.providerCurrent.workflowRunAttempt)
        || target.providerCurrent.workflowRunAttempt < 1
        || target.providerCurrent.workflowRunAttempt > 1_000_000) {
        throw new Error("Dashboard provider-current run attempt is invalid");
      }
      requireDigest(target.providerCurrent.markerFingerprint, "Dashboard marker fingerprint");
      if (target.providerCurrent.sourceRevision !== target.latestSuccessfulWorkflow.revision
        || target.providerCurrent.workflowRunId !== target.latestSuccessfulWorkflow.runId
        || target.providerCurrent.workflowRunAttempt !== target.latestSuccessfulWorkflow.runAttempt) {
        throw new Error("Dashboard provider current does not bind its workflow baseline");
      }
    } else if (target.providerCurrent?.kind === "worker-public-version") {
      if (target.target !== "worker" || target.latestSuccessfulWorkflow !== null) {
        throw new Error("Only the Worker may bind its public version receipt");
      }
      requireSha(target.providerCurrent.sourceRevision, "Worker provider-current source revision");
      if (!uuidPattern.test(target.providerCurrent.versionId)) {
        throw new Error("Worker provider-current version ID is invalid");
      }
      if (target.providerCurrent.versionTag !== `git-${target.providerCurrent.sourceRevision}`) {
        throw new Error("Worker provider-current version tag is invalid");
      }
      requireProviderTimestamp(
        target.providerCurrent.versionCreatedAt,
        "Worker provider-current creation time",
      );
    } else if (target.providerCurrent !== null) {
      throw new Error("Deployment provider-current evidence kind is unsupported");
    }
    if (!["ahead", "identical", "behind", "diverged", "unknown"].includes(target.history)) {
      throw new Error(`Deployment history for ${target.target} is unsupported`);
    }
    if (target.classifier.contractVersion !== 1) {
      throw new Error(`Deployment classifier for ${target.target} is unsupported`);
    }
    if (target.classifier.kind === "site-tree-oid") {
      if (target.target !== "dashboard") {
        throw new Error("Only the dashboard may use the site-tree classifier");
      }
      requireSha(target.classifier.baselineTreeOid, "Dashboard baseline site tree OID");
      requireSha(target.classifier.currentTreeOid, "Dashboard current site tree OID");
    } else if (
      target.classifier.kind !== "unavailable"
      || ![
        "dependency_classifier_not_implemented",
        "site_tree_observation_failed",
        "provider_current_observation_failed",
      ].includes(target.classifier.reason)
    ) {
      throw new Error(`Deployment classifier for ${target.target} is invalid`);
    }
    if (
      target.providerCurrent !== null
      && target.classifier.kind === "unavailable"
      && target.classifier.reason === "provider_current_observation_failed"
    ) {
      throw new Error("Deployment provider-current evidence and classifier are incoherent");
    }
  }
  return Object.freeze([...targets]);
}

function compileTarget(
  input: TargetDeploymentObservation,
  currentMainRevision: string,
  ciRevision: string,
): DeploymentReconciliationReceipt["targets"][number] {
  const common = Object.freeze({
    target: input.target,
    latestSuccessfulWorkflow: input.latestSuccessfulWorkflow,
    ...(input.providerCurrent === null
      ? Object.freeze({
        baselineAuthority: "workflow_only" as const,
        providerCurrentVerified: false as const,
        providerCurrent: null,
      })
      : Object.freeze({
        baselineAuthority: input.providerCurrent.kind === "dashboard-public-marker"
          ? "public_deployment_marker" as const
          : "public_worker_version" as const,
        providerCurrentVerified: true as const,
        providerCurrent: input.providerCurrent,
      })),
    classifier: input.classifier,
    history: input.history,
    authorizesDeployment: false as const,
  });
  if (currentMainRevision !== ciRevision) {
    return Object.freeze({
      ...common,
      decision: "waiting_current_main" as const,
      reason: "current_main_advanced" as const,
    });
  }
  if (input.classifier.kind === "unavailable") {
    return Object.freeze({
      ...common,
      decision: "classification_unknown" as const,
      reason: input.classifier.reason,
    });
  }
  if (input.latestSuccessfulWorkflow === null) {
    return Object.freeze({
      ...common,
      decision: "baseline_unknown" as const,
      reason: "no_successful_workflow_baseline" as const,
    });
  }
  if (input.history === "behind" || input.history === "diverged") {
    return Object.freeze({
      ...common,
      decision: "history_not_linear" as const,
      reason: "baseline_not_ancestor" as const,
    });
  }
  if (input.history === "unknown") {
    return Object.freeze({
      ...common,
      decision: "classification_unknown" as const,
      reason: "site_tree_observation_failed" as const,
    });
  }
  if (input.classifier.baselineTreeOid === input.classifier.currentTreeOid) {
    return Object.freeze({
      ...common,
      decision: "not_relevant" as const,
      reason: "site_tree_unchanged" as const,
    });
  }
  return Object.freeze({
    ...common,
    decision: "would_dispatch" as const,
    reason: "site_tree_changed" as const,
  });
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not exact`);
  }
  return record;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function requireNumericId(value: unknown, label: string): string {
  if (typeof value !== "string" || !numericIdPattern.test(value)) {
    throw new Error(`${label} must be a positive decimal identifier`);
  }
  return value;
}

function requireRepository(value: unknown, label: string): string {
  if (typeof value !== "string" || !repositoryPattern.test(value) || value.length > 200) {
    throw new Error(`${label} must be an owner/repository name`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function requireProviderTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a bounded UTC timestamp`);
  }
  return value;
}
