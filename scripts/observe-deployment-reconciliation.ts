import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sha256 } from "../src/canonical-json.js";
import {
  parseDashboardDeploymentMarker,
  type DashboardDeploymentMarker,
} from "./dashboard-deployment-marker.js";
import {
  compileDeploymentReconciliation,
  type ExactCiArtifactObservation,
  type ExactCiRunObservation,
  type SuccessfulDeploymentWorkflowObservation,
  type TargetDeploymentObservation,
} from "../src/deployment-reconciliation.js";
import { parseStrictJson } from "../src/strict-json.js";

const maximumApiResponseBytes = 2 * 1024 * 1024;
const maximumReceiptJsonBytes = 8 * 1024;
const maximumReceiptArtifactBytes = 16 * 1024;
const ciWorkflowPath = ".github/workflows/ci.yml" as const;
const receiptJsonName = "exact-ref-validation-receipt.json";
const receiptChecksumName = "exact-ref-validation-receipt.sha256";
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const numericIdPattern = /^[1-9][0-9]{0,19}$/u;

export interface DeploymentReconciliationEnvironment {
  readonly [key: string]: string | undefined;
  readonly GITHUB_API_URL?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_REPOSITORY_ID?: string;
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_RUN_ATTEMPT?: string;
  readonly GITHUB_WORKFLOW_SHA?: string;
  readonly OBSERVER_SOURCE_REVISION?: string;
  readonly RUNNER_TEMP?: string;
  readonly CI_RECEIPT_DIRECTORY?: string;
  readonly DEPLOYMENT_RECONCILIATION_OUTPUT?: string;
  readonly TRIGGER_RUN_ID?: string;
  readonly TRIGGER_RUN_ATTEMPT?: string;
  readonly TRIGGER_HEAD_SHA?: string;
}

export async function runDeploymentReconciliationObserver(
  env: DeploymentReconciliationEnvironment = process.env,
  request: typeof fetch = fetch,
): Promise<ReturnType<typeof compileDeploymentReconciliation>> {
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY");
  const repositoryId = requireNumericId(
    requiredEnvironment(env, "GITHUB_REPOSITORY_ID"),
    "GITHUB_REPOSITORY_ID",
  );
  const triggerRunId = requireNumericId(
    requiredEnvironment(env, "TRIGGER_RUN_ID"),
    "TRIGGER_RUN_ID",
  );
  const triggerRunAttempt = requireNumericId(
    requiredEnvironment(env, "TRIGGER_RUN_ATTEMPT"),
    "TRIGGER_RUN_ATTEMPT",
  );
  const triggerHeadSha = requireSha(
    requiredEnvironment(env, "TRIGGER_HEAD_SHA"),
    "TRIGGER_HEAD_SHA",
  );
  const runnerTemp = requiredEnvironment(env, "RUNNER_TEMP");
  const receiptDirectory = requireRunnerTempChild(
    requiredEnvironment(env, "CI_RECEIPT_DIRECTORY"),
    runnerTemp,
    "CI receipt directory",
  );
  const outputPath = requireRunnerTempChild(
    requiredEnvironment(env, "DEPLOYMENT_RECONCILIATION_OUTPUT"),
    runnerTemp,
    "Reconciliation output",
  );
  const client = githubClient({
    apiBase: parseApiBase(requiredEnvironment(env, "GITHUB_API_URL")),
    repository,
    token: requiredEnvironment(env, "GITHUB_TOKEN"),
    request,
  });

  const [run, workflow, initialMainRevision, artifact, localReceipt] = await Promise.all([
    client.run(triggerRunId),
    client.workflow(ciWorkflowPath),
    client.mainRevision(),
    client.exactReceiptArtifact(triggerRunId, triggerRunAttempt),
    readExactCiReceiptDirectory(receiptDirectory),
  ]);
  const ciRun = admitRunObservation({
    run,
    workflow,
    repository,
    repositoryId,
    triggerRunId,
    triggerRunAttempt,
    triggerHeadSha,
  });
  const ciArtifact = admitArtifactObservation({
    artifact,
    localReceipt,
    repositoryId,
    run: ciRun,
  });
  const targets = await observeTargets(
    client,
    initialMainRevision,
    repository,
    repositoryId,
  );
  const currentMainRevision = await client.mainRevision();
  const receipt = compileDeploymentReconciliation({
    repository,
    repositoryId,
    observerWorkflowRevision: requireSha(
      requiredEnvironment(env, "GITHUB_WORKFLOW_SHA"),
      "GITHUB_WORKFLOW_SHA",
    ),
    observerSourceRevision: requireSha(
      requiredEnvironment(env, "OBSERVER_SOURCE_REVISION"),
      "OBSERVER_SOURCE_REVISION",
    ),
    observerRunId: requireNumericId(
      requiredEnvironment(env, "GITHUB_RUN_ID"),
      "GITHUB_RUN_ID",
    ),
    observerRunAttempt: requireNumericId(
      requiredEnvironment(env, "GITHUB_RUN_ATTEMPT"),
      "GITHUB_RUN_ATTEMPT",
    ),
    currentMainRevision,
    ciRun,
    ciArtifact,
    ciReceipt: localReceipt.value,
    targets,
    observedAt: new Date().toISOString(),
  });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

interface GitHubClient {
  run(runId: string): Promise<Record<string, unknown>>;
  workflow(path: string): Promise<Record<string, unknown>>;
  mainRevision(): Promise<string>;
  exactReceiptArtifact(runId: string, runAttempt: string): Promise<Record<string, unknown>>;
  dashboardMarker(cacheRevision: string): Promise<DashboardDeploymentMarker>;
  compare(base: string, head: string): Promise<"ahead" | "identical" | "behind" | "diverged">;
  siteTreeOid(revision: string): Promise<string>;
}

function githubClient(input: {
  readonly apiBase: string;
  readonly repository: string;
  readonly token: string;
  readonly request: typeof fetch;
}): GitHubClient {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  if (input.token.length < 1 || input.token.length > 4_096) {
    throw new Error("GITHUB_TOKEN is invalid");
  }
  const headers = Object.freeze({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const readJson = async (
    path: string,
    maxStringLength = 16_384,
  ): Promise<unknown> => {
    const response = await input.request(
      `${input.apiBase}/repos/${input.repository}${path}`,
      { headers, method: "GET", signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) {
      throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    }
    return parseStrictJson(await readBoundedResponseText(response, maximumApiResponseBytes), {
      maxBytes: maximumApiResponseBytes,
      maxDepth: 20,
      maxStringLength,
      maxObjectKeys: 256,
      maxArrayLength: 300,
      prefix: "DEPLOYMENT_RECONCILIATION_API",
    });
  };
  const record = async (path: string, label: string): Promise<Record<string, unknown>> =>
    exactRecord(await readJson(path), label);

  return Object.freeze({
    run: (runId: string) => record(`/actions/runs/${requireNumericId(runId, "Run ID")}`, "Workflow run"),
    workflow: (path: string) => record(
      `/actions/workflows/${encodeURIComponent(path.split("/").at(-1) ?? path)}`,
      "Workflow",
    ),
    async mainRevision(): Promise<string> {
      const ref = await record("/git/ref/heads/main", "Main ref");
      return requireSha(exactRecord(ref.object, "Main ref object").sha, "Current main revision");
    },
    async exactReceiptArtifact(runId: string, runAttempt: string): Promise<Record<string, unknown>> {
      const expectedName = `exact-ref-validation-receipt-${requireNumericId(runId, "Run ID")}-${requireNumericId(runAttempt, "Run attempt")}`;
      const envelope = await record(
        `/actions/runs/${runId}/artifacts?name=${encodeURIComponent(expectedName)}&per_page=2`,
        "Artifact list",
      );
      const totalCount = requireBoundedInteger(envelope.total_count, "Artifact total count", 1, 1);
      if (
        !Array.isArray(envelope.artifacts)
        || totalCount !== 1
        || envelope.artifacts.length !== 1
      ) {
        throw new Error("Artifact list envelope is invalid");
      }
      const artifact = exactRecord(envelope.artifacts[0], "Artifact 1");
      if (artifact.name !== expectedName) {
        throw new Error(`Artifact list did not return the exact ${expectedName} artifact`);
      }
      return artifact;
    },
    async dashboardMarker(cacheRevision: string): Promise<DashboardDeploymentMarker> {
      const response = await input.request(
        `https://www.stensibly.com/.well-known/stensibly-deployment.json?revision=${requireSha(cacheRevision, "Dashboard marker cache revision")}`,
        {
          headers: { "cache-control": "no-cache" },
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Dashboard marker request failed with HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("Dashboard marker response is not JSON");
      }
      return parseDashboardDeploymentMarker(parseStrictJson(
        await readBoundedResponseText(response, 2_048),
        {
          maxBytes: 2_048,
          maxDepth: 6,
          maxStringLength: 256,
          maxObjectKeys: 16,
          maxArrayLength: 4,
          prefix: "DASHBOARD_RECONCILIATION_MARKER",
        },
      ));
    },
    async compare(base: string, head: string) {
      const comparison = exactRecord(await readJson(
        `/compare/${requireSha(base, "Comparison base")}...${requireSha(head, "Comparison head")}?per_page=1`,
        maximumApiResponseBytes,
      ), "Revision comparison");
      if (!["ahead", "identical", "behind", "diverged"].includes(String(comparison.status))) {
        throw new Error("Revision comparison status is invalid");
      }
      return comparison.status as "ahead" | "identical" | "behind" | "diverged";
    },
    async siteTreeOid(revision: string): Promise<string> {
      const commit = await record(
        `/git/commits/${requireSha(revision, "Site tree revision")}`,
        "Git commit",
      );
      const rootTree = requireSha(
        exactRecord(commit.tree, "Git commit tree").sha,
        "Git root tree OID",
      );
      const tree = await record(`/git/trees/${rootTree}`, "Git root tree");
      if (!Array.isArray(tree.tree) || tree.tree.length > 300) {
        throw new Error("Git root tree envelope is invalid");
      }
      const site = tree.tree
        .map((entry, index) => exactRecord(entry, `Git root tree entry ${index + 1}`))
        .filter((entry) => entry.path === "site" && entry.type === "tree");
      if (site.length !== 1) throw new Error("Git root tree does not contain exactly one site subtree");
      return requireSha(site[0]!.sha, "Site tree OID");
    },
  });
}

async function observeTargets(
  client: GitHubClient,
  currentMainRevision: string,
  repository: string,
  repositoryId: string,
): Promise<readonly TargetDeploymentObservation[]> {
  let dashboardBaseline: SuccessfulDeploymentWorkflowObservation | null = null;
  let dashboardProviderCurrent: TargetDeploymentObservation["providerCurrent"] = null;
  let dashboardClassifier: TargetDeploymentObservation["classifier"] = Object.freeze({
    kind: "unavailable",
    contractVersion: 1,
    reason: "provider_current_observation_failed",
  });
  let dashboardHistory: TargetDeploymentObservation["history"] = "unknown";
  try {
    const marker = await client.dashboardMarker(currentMainRevision);
    const [run, workflow] = await Promise.all([
      client.run(marker.run.id),
      client.workflow(".github/workflows/publish-dashboard-on-main.yml"),
    ]);
    dashboardBaseline = admitDashboardPublicationRun({
      run,
      workflow,
      marker,
      repository,
      repositoryId,
    });
    dashboardProviderCurrent = Object.freeze({
      kind: "dashboard-public-marker" as const,
      sourceRevision: marker.sourceRevision,
      workflowRunId: marker.run.id,
      workflowRunAttempt: dashboardBaseline.runAttempt,
      markerFingerprint: marker.fingerprint,
    });
    dashboardClassifier = Object.freeze({
      kind: "unavailable",
      contractVersion: 1,
      reason: "site_tree_observation_failed",
    });
    try {
      let history: TargetDeploymentObservation["history"];
      let baselineTreeOid: string;
      let currentTreeOid: string;
      if (dashboardBaseline.revision === currentMainRevision) {
        history = "identical";
        currentTreeOid = await client.siteTreeOid(currentMainRevision);
        baselineTreeOid = currentTreeOid;
      } else {
        [history, baselineTreeOid, currentTreeOid] = await Promise.all([
          client.compare(dashboardBaseline.revision, currentMainRevision),
          client.siteTreeOid(dashboardBaseline.revision),
          client.siteTreeOid(currentMainRevision),
        ]);
      }
      dashboardHistory = history;
      dashboardClassifier = Object.freeze({
        kind: "site-tree-oid",
        contractVersion: 1,
        baselineTreeOid,
        currentTreeOid,
      });
    } catch {
      // Shadow evidence fails closed without turning provider/API errors into deploy authority.
    }
    const finalMarker = await client.dashboardMarker(currentMainRevision);
    if (
      finalMarker.fingerprint !== marker.fingerprint
      || finalMarker.sourceRevision !== marker.sourceRevision
      || finalMarker.run.id !== marker.run.id
      || finalMarker.run.attempt !== marker.run.attempt
    ) {
      throw new Error("Dashboard provider current moved during observation");
    }
  } catch {
    // Missing or incoherent public/provider evidence remains visible but non-authorizing.
    dashboardBaseline = null;
    dashboardProviderCurrent = null;
    dashboardHistory = "unknown";
    dashboardClassifier = Object.freeze({
      kind: "unavailable",
      contractVersion: 1,
      reason: "provider_current_observation_failed",
    });
  }
  return Object.freeze([
    unavailableTarget("worker", ".github/workflows/deploy-worker.yml"),
    unavailableTarget("convex", ".github/workflows/deploy-convex.yml"),
    Object.freeze({
      target: "dashboard",
      workflowPath: ".github/workflows/publish-dashboard-on-main.yml",
      latestSuccessfulWorkflow: dashboardBaseline,
      providerCurrent: dashboardProviderCurrent,
      history: dashboardHistory,
      classifier: dashboardClassifier,
    }),
  ]);
}

function unavailableTarget(
  target: "worker" | "convex",
  workflowPath: ".github/workflows/deploy-worker.yml" | ".github/workflows/deploy-convex.yml",
): TargetDeploymentObservation {
  return Object.freeze({
    target,
    workflowPath,
    latestSuccessfulWorkflow: null,
    providerCurrent: null,
    history: "unknown",
    classifier: Object.freeze({
      kind: "unavailable",
      contractVersion: 1,
      reason: "dependency_classifier_not_implemented",
    }),
  });
}

function admitDashboardPublicationRun(input: {
  readonly run: Record<string, unknown>;
  readonly workflow: Record<string, unknown>;
  readonly marker: DashboardDeploymentMarker;
  readonly repository: string;
  readonly repositoryId: string;
}): SuccessfulDeploymentWorkflowObservation {
  const runRepository = exactRecord(input.run.repository, "Dashboard run repository");
  const headRepository = exactRecord(input.run.head_repository, "Dashboard run head repository");
  const workflowId = numericIdentifier(input.workflow.id, "Dashboard workflow ID");
  if (
    numericIdentifier(input.run.id, "Dashboard run ID") !== input.marker.run.id
    || numericIdentifier(input.run.run_attempt, "Dashboard run attempt") !== input.marker.run.attempt
    || numericIdentifier(input.run.workflow_id, "Dashboard run workflow ID") !== workflowId
    || input.workflow.name !== "Publish Dashboard Production"
    || input.workflow.path !== ".github/workflows/publish-dashboard-on-main.yml"
    || input.run.path !== ".github/workflows/publish-dashboard-on-main.yml"
    || input.run.event !== "workflow_dispatch"
    || input.run.head_branch !== "main"
    || input.run.head_sha !== input.marker.sourceRevision
    || input.run.status !== "completed"
    || input.run.conclusion !== "success"
    || numericIdentifier(runRepository.id, "Dashboard run repository ID") !== input.repositoryId
    || runRepository.full_name !== input.repository
    || numericIdentifier(headRepository.id, "Dashboard run head repository ID") !== input.repositoryId
    || headRepository.full_name !== input.repository
  ) {
    throw new Error("Dashboard public marker does not bind an exact successful publication run");
  }
  return Object.freeze({
    runId: input.marker.run.id,
    runAttempt: requireBoundedInteger(
      Number(input.marker.run.attempt),
      "Dashboard marker run attempt",
      1,
      1_000_000,
    ),
    revision: input.marker.sourceRevision,
    updatedAt: requireTimestamp(input.run.updated_at, "Dashboard run terminal update time"),
  });
}

function admitRunObservation(input: {
  readonly run: Record<string, unknown>;
  readonly workflow: Record<string, unknown>;
  readonly repository: string;
  readonly repositoryId: string;
  readonly triggerRunId: string;
  readonly triggerRunAttempt: string;
  readonly triggerHeadSha: string;
}): ExactCiRunObservation {
  const runRepository = exactRecord(input.run.repository, "Workflow run repository");
  const headRepository = exactRecord(input.run.head_repository, "Workflow run head repository");
  const workflowId = numericIdentifier(input.workflow.id, "Workflow ID");
  if (
    numericIdentifier(input.run.id, "Workflow run ID") !== input.triggerRunId
    || numericIdentifier(input.run.run_attempt, "Workflow run attempt") !== input.triggerRunAttempt
    || numericIdentifier(input.run.workflow_id, "Workflow run workflow ID") !== workflowId
    || input.workflow.name !== "CI"
    || input.workflow.path !== ciWorkflowPath
    || input.run.path !== ciWorkflowPath
    || input.run.event !== "push"
    || input.run.head_branch !== "main"
    || input.run.head_sha !== input.triggerHeadSha
    || input.run.status !== "completed"
    || input.run.conclusion !== "success"
    || numericIdentifier(runRepository.id, "Workflow run repository ID") !== input.repositoryId
    || runRepository.full_name !== input.repository
    || numericIdentifier(headRepository.id, "Workflow run head repository ID") !== input.repositoryId
    || headRepository.full_name !== input.repository
  ) {
    throw new Error("Refetched CI run does not match the exact canonical main-push identity");
  }
  return Object.freeze({
    repositoryId: input.repositoryId,
    repository: input.repository,
    runId: input.triggerRunId,
    runAttempt: input.triggerRunAttempt,
    workflowId,
    workflowName: "CI",
    workflowPath: ciWorkflowPath,
    eventName: "push",
    headBranch: "main",
    headRevision: input.triggerHeadSha,
    status: "completed",
    conclusion: "success",
  });
}

function admitArtifactObservation(input: {
  readonly artifact: Record<string, unknown>;
  readonly localReceipt: Readonly<{ value: unknown; contentDigest: string }>;
  readonly repositoryId: string;
  readonly run: ExactCiRunObservation;
}): ExactCiArtifactObservation {
  const artifactRun = exactRecord(input.artifact.workflow_run, "Artifact workflow run");
  const name = `exact-ref-validation-receipt-${input.run.runId}-${input.run.runAttempt}`;
  const sizeBytes = requireBoundedInteger(
    input.artifact.size_in_bytes,
    "Artifact size",
    1,
    maximumReceiptArtifactBytes,
  );
  const archiveDigest = requireDigest(input.artifact.digest, "Artifact archive digest");
  if (
    input.artifact.name !== name
    || input.artifact.expired !== false
    || numericIdentifier(artifactRun.id, "Artifact workflow run ID") !== input.run.runId
    || numericIdentifier(artifactRun.repository_id, "Artifact repository ID") !== input.repositoryId
    || numericIdentifier(artifactRun.head_repository_id, "Artifact head repository ID") !== input.repositoryId
    || artifactRun.head_branch !== "main"
    || artifactRun.head_sha !== input.run.headRevision
  ) {
    throw new Error("CI receipt artifact metadata does not match the exact triggering run");
  }
  return Object.freeze({
    artifactId: numericIdentifier(input.artifact.id, "Artifact ID"),
    name,
    sizeBytes,
    archiveDigest,
    contentDigest: input.localReceipt.contentDigest,
    expired: false,
  });
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new Error("GitHub API response exceeded the reconciliation bound");
    }
  }
  if (response.body === null) throw new Error("GitHub API response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength > maximumBytes - total) {
        await reader.cancel();
        throw new Error("GitHub API response exceeded the reconciliation bound");
      }
      chunks.push(chunk.slice());
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readExactCiReceiptDirectory(
  path: string,
): Promise<Readonly<{ value: unknown; contentDigest: string }>> {
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("CI receipt path is not an ordinary directory");
  }
  const entries = (await readdir(path)).sort();
  if (
    entries.length !== 2
    || entries[0] !== receiptJsonName
    || entries[1] !== receiptChecksumName
  ) {
    throw new Error("CI receipt artifact must contain exactly the JSON and checksum files");
  }
  const jsonPath = resolve(path, receiptJsonName);
  const checksumPath = resolve(path, receiptChecksumName);
  const [jsonStat, checksumStat] = await Promise.all([lstat(jsonPath), lstat(checksumPath)]);
  if (
    !jsonStat.isFile()
    || jsonStat.isSymbolicLink()
    || jsonStat.size < 1
    || jsonStat.size > maximumReceiptJsonBytes
    || !checksumStat.isFile()
    || checksumStat.isSymbolicLink()
    || checksumStat.size < 1
    || checksumStat.size > 256
  ) {
    throw new Error("CI receipt artifact files are not bounded ordinary files");
  }
  const [jsonText, checksumText] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(checksumPath, "utf8"),
  ]);
  const checksum = checksumText.match(
    /^([0-9a-f]{64})[ \t]+\*?exact-ref-validation-receipt\.json\n?$/u,
  )?.[1];
  const contentDigest = sha256(jsonText);
  if (!checksum || contentDigest !== `sha256:${checksum}`) {
    throw new Error("CI receipt checksum does not match the extracted JSON");
  }
  return Object.freeze({
    value: parseStrictJson(jsonText, {
      maxBytes: maximumReceiptJsonBytes,
      maxDepth: 8,
      maxStringLength: 1_024,
      maxObjectKeys: 32,
      maxArrayLength: 16,
      prefix: "EXACT_CI_RECEIPT",
    }),
    contentDigest,
  });
}

function requiredEnvironment(
  env: DeploymentReconciliationEnvironment,
  name: keyof DeploymentReconciliationEnvironment,
): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1) throw new Error(`${name} is required`);
  return value;
}

function requireRunnerTempChild(value: string, runnerTemp: string, label: string): string {
  const root = resolve(runnerTemp);
  const target = resolve(value);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} must stay inside RUNNER_TEMP`);
  }
  return target;
}

function parseApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GITHUB_API_URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("GITHUB_API_URL must be an HTTPS API origin");
  }
  return url.href.replace(/\/$/u, "");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numericIdentifier(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return requireNumericId(value, label);
}

function requireNumericId(value: unknown, label: string): string {
  if (typeof value !== "string" || !numericIdPattern.test(value)) {
    throw new Error(`${label} must be a positive decimal identifier`);
  }
  return value;
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

function requireBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

if (import.meta.main) await runDeploymentReconciliationObserver();
