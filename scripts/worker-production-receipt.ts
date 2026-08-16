import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sha256, stableJson } from "../src/canonical-json.js";
import { parseStrictJson } from "../src/strict-json.js";
import {
  PRODUCTION_BINDING_CONTRACT,
  newestDeployment,
  type DeploymentSnapshot,
} from "./worker-production-release.js";

const OFFICIAL_ENDPOINT = "https://api.stensibly.com";
const FALLBACK_ENDPOINT = "https://stensibly-api.leoli-082000.workers.dev";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKER_NAME = PRODUCTION_BINDING_CONTRACT.workerName;
const WRANGLER_CONFIG = "wrangler.jsonc";
const ORIGIN_VERIFY_ATTEMPTS = 8;
const ORIGIN_VERIFY_DELAY_MS = 5_000;

export interface WorkerProviderCurrentObservation {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
}

export interface WorkerProductionReceiptInput {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly baselineDeploymentId: string;
  readonly provider: WorkerProviderCurrentObservation;
  readonly observedAt: string;
}

export interface WorkerProductionDeploymentReceipt {
  readonly schemaVersion: "stensibly-worker-production-deployment-receipt/1";
  readonly repository: string;
  readonly workerName: string;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly run: {
    readonly id: string;
    readonly attempt: string;
  };
  readonly baselineDeploymentId: string;
  readonly production: WorkerProviderCurrentObservation;
  readonly verifiedOrigins: readonly [
    { readonly origin: typeof FALLBACK_ENDPOINT; readonly versionId: string },
    { readonly origin: typeof OFFICIAL_ENDPOINT; readonly versionId: string },
  ];
  readonly providerCurrentVerified: true;
  readonly authorizesDeployment: false;
  readonly observedAt: string;
  readonly fingerprint: string;
}

export interface WorkerProductionReceiptDependencies {
  run(command: string, args: readonly string[]): Promise<{ stdout: string }>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  sleep(milliseconds: number): Promise<void>;
  now(): Date;
}

export function observeWorkerProviderCurrent(
  inventory: unknown,
  expectedSourceRevision: string,
  expectedVersionId: string,
): WorkerProviderCurrentObservation {
  requireSha(expectedSourceRevision, "Expected source revision");
  requireUuid(expectedVersionId, "Expected Worker version ID");
  const deployment = newestDeployment(inventory);
  if (deployment.source !== "wrangler" || deployment.strategy !== "percentage") {
    throw new Error("Current Worker deployment has an unexpected provider strategy");
  }
  if (deployment.annotations.triggeredBy !== "deployment") {
    throw new Error("Current Worker deployment has an unexpected trigger annotation");
  }
  const expectedMessage = `Promote exact Stensibly main ${expectedSourceRevision}`;
  if (deployment.annotations.message !== expectedMessage) {
    throw new Error("Current Worker deployment is not bound to the expected source revision");
  }
  if (
    deployment.versions.length !== 1
    || deployment.versions[0]?.percentage !== 100
    || deployment.versions[0]?.version_id !== expectedVersionId
  ) {
    throw new Error("Current Worker deployment is not the expected sole active version");
  }
  return Object.freeze({
    deploymentId: deployment.id,
    versionId: expectedVersionId,
    sourceRevision: expectedSourceRevision,
    createdAt: deployment.created_on,
  });
}

export function compileWorkerProductionReceipt(
  input: WorkerProductionReceiptInput,
): WorkerProductionDeploymentReceipt {
  if (!REPOSITORY_PATTERN.test(input.repository)) throw new Error("Repository identity is invalid");
  requireSha(input.sourceRevision, "Source revision");
  requireSha(input.workflowRevision, "Workflow revision");
  if (input.workflowRevision !== input.sourceRevision) {
    throw new Error("Worker receipt workflow revision does not match the deployed source");
  }
  requireNumericId(input.runId, "Workflow run ID");
  requireNumericId(input.runAttempt, "Workflow run attempt");
  requireUuid(input.baselineDeploymentId, "Baseline deployment ID");
  requireUuid(input.provider.deploymentId, "Production deployment ID");
  requireUuid(input.provider.versionId, "Production Worker version ID");
  requireSha(input.provider.sourceRevision, "Production source revision");
  requireTimestamp(input.provider.createdAt, "Production deployment time");
  requireTimestamp(input.observedAt, "Receipt observation time");
  if (input.provider.sourceRevision !== input.sourceRevision) {
    throw new Error("Provider-current source revision does not match the deployed source");
  }
  const core = Object.freeze({
    schemaVersion: "stensibly-worker-production-deployment-receipt/1" as const,
    repository: input.repository,
    workerName: WORKER_NAME,
    sourceRevision: input.sourceRevision,
    workflowRevision: input.workflowRevision,
    run: Object.freeze({ id: input.runId, attempt: input.runAttempt }),
    baselineDeploymentId: input.baselineDeploymentId,
    production: Object.freeze({ ...input.provider }),
    verifiedOrigins: Object.freeze([
      Object.freeze({ origin: FALLBACK_ENDPOINT, versionId: input.provider.versionId }),
      Object.freeze({ origin: OFFICIAL_ENDPOINT, versionId: input.provider.versionId }),
    ] as const),
    providerCurrentVerified: true as const,
    authorizesDeployment: false as const,
    observedAt: input.observedAt,
  });
  return Object.freeze({ ...core, fingerprint: sha256(stableJson(core)) });
}

export async function runWorkerProductionReceipt(
  env: Record<string, string | undefined> = process.env,
  dependencies: WorkerProductionReceiptDependencies = defaultDependencies,
): Promise<WorkerProductionDeploymentReceipt> {
  const outputPath = requireRunnerTempChild(
    requiredEnvironment(env, "WORKER_PRODUCTION_RECEIPT_OUTPUT"),
    requiredEnvironment(env, "RUNNER_TEMP"),
  );
  const sourceRevision = requireSha(requiredEnvironment(env, "GITHUB_SHA"), "GITHUB_SHA");
  const workflowRevision = requireSha(
    requiredEnvironment(env, "GITHUB_WORKFLOW_SHA"),
    "GITHUB_WORKFLOW_SHA",
  );
  const expectedVersionId = requireUuid(
    requiredEnvironment(env, "EXPECTED_CANDIDATE_VERSION_ID"),
    "EXPECTED_CANDIDATE_VERSION_ID",
  );
  const result = await dependencies.run("bunx", [
    "wrangler",
    "deployments",
    "list",
    "--name",
    WORKER_NAME,
    "--json",
    "--config",
    WRANGLER_CONFIG,
  ]);
  const provider = observeWorkerProviderCurrent(
    parseStrictJson(result.stdout, {
      prefix: "WORKER_DEPLOYMENT_INVENTORY",
      maxBytes: 128 * 1_024,
      maxDepth: 8,
      maxStringLength: 4_096,
      maxObjectKeys: 64,
      maxArrayLength: 20,
    }),
    sourceRevision,
    expectedVersionId,
  );
  for (const endpoint of [FALLBACK_ENDPOINT, OFFICIAL_ENDPOINT] as const) {
    await verifyOrigin(endpoint, provider.versionId, dependencies);
  }
  const receipt = compileWorkerProductionReceipt({
    repository: requiredEnvironment(env, "GITHUB_REPOSITORY"),
    sourceRevision,
    workflowRevision,
    runId: requiredEnvironment(env, "GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment(env, "GITHUB_RUN_ATTEMPT"),
    baselineDeploymentId: requiredEnvironment(env, "EXPECTED_BASELINE_DEPLOYMENT_ID"),
    provider,
    observedAt: dependencies.now().toISOString(),
  });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

async function verifyOrigin(
  endpoint: typeof FALLBACK_ENDPOINT | typeof OFFICIAL_ENDPOINT,
  expectedVersionId: string,
  dependencies: WorkerProductionReceiptDependencies,
): Promise<void> {
  let observedStatus = 0;
  let observedVersionId = "";
  for (let attempt = 1; attempt <= ORIGIN_VERIFY_ATTEMPTS; attempt += 1) {
    const response = await dependencies.fetch(`${endpoint}/health`, {
      headers: { "cache-control": "no-store" },
      signal: AbortSignal.timeout(10_000),
    });
    observedStatus = response.status;
    observedVersionId = response.headers.get("x-stensibly-worker-version-id")?.trim() ?? "";
    if (observedStatus === 200 && observedVersionId === expectedVersionId) return;
    if (attempt < ORIGIN_VERIFY_ATTEMPTS) {
      await dependencies.sleep(ORIGIN_VERIFY_DELAY_MS);
    }
  }
  if (observedStatus !== 200) {
    throw new Error(`Worker receipt health returned ${observedStatus}`);
  }
  throw new Error("Worker receipt health version does not match provider current");
}

function requiredEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value || value.length > 4_096) throw new Error(`Missing or invalid receipt environment: ${name}`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireNumericId(value: string, label: string): string {
  if (!NUMERIC_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function requireRunnerTempChild(outputPath: string, runnerTemp: string): string {
  const root = resolve(runnerTemp);
  const output = resolve(outputPath);
  if (output === root || !output.startsWith(`${root}${sep}`)) {
    throw new Error("Worker production receipt output must be inside RUNNER_TEMP");
  }
  return output;
}

const defaultDependencies: WorkerProductionReceiptDependencies = {
  async run(command, args) {
    const child = Bun.spawn([command, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command} exited with status ${exitCode}`);
    return { stdout };
  },
  fetch: (input, init) => fetch(input, init),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date(),
};

if (import.meta.main) {
  await runWorkerProductionReceipt();
}
