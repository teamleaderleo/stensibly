import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sha256, stableJson } from "../src/canonical-json.js";
import { parseStrictJson } from "../src/strict-json.js";

const VERCEL_API_ORIGIN = "https://api.vercel.com";
const DASHBOARD_HOST = "www.stensibly.com";
const PROJECT_NAME = "stensibly";
const EXPECTED_REPOSITORY = "teamleaderleo/stensibly";
const EXPECTED_GITHUB_ORG = "teamleaderleo";
const EXPECTED_GITHUB_REPO = "stensibly";
const EXPECTED_GITHUB_REF = "main";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9]{1,64}$/u;
const TEAM_ID_PATTERN = /^team_[A-Za-z0-9]{1,64}$/u;
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]{1,64}$/u;
const DEPLOYMENT_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\.vercel\.app$/u;
const MAXIMUM_PROVIDER_BYTES = 256 * 1_024;

export interface DashboardProviderCurrentObservation {
  readonly deploymentId: string;
  readonly immutableOrigin: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly readyAt: string;
  readonly aliasUpdatedAt: string;
}

export interface DashboardProductionReceiptInput {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly provider: DashboardProviderCurrentObservation;
  readonly observedAt: string;
}

export interface DashboardProductionDeploymentReceipt {
  readonly schemaVersion: "stensibly-dashboard-production-deployment-receipt/1";
  readonly repository: typeof EXPECTED_REPOSITORY;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly run: { readonly id: string; readonly attempt: string };
  readonly provider: {
    readonly name: "vercel";
    readonly projectId: string;
    readonly projectName: typeof PROJECT_NAME;
    readonly teamId: string;
  };
  readonly canonical: {
    readonly host: typeof DASHBOARD_HOST;
    readonly aliasUpdatedAt: string;
  };
  readonly production: Omit<DashboardProviderCurrentObservation, "aliasUpdatedAt">;
  readonly providerCurrentVerified: true;
  readonly authorizesDeployment: false;
  readonly observedAt: string;
  readonly fingerprint: string;
}

export interface DashboardProductionReceiptDependencies {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): Date;
}

export function observeDashboardProviderCurrent(
  aliasValue: unknown,
  deploymentValue: unknown,
  expected: {
    readonly projectId: string;
    readonly teamId: string;
    readonly deploymentOrigin: string;
    readonly sourceRevision: string;
  },
): DashboardProviderCurrentObservation {
  requireProjectId(expected.projectId);
  requireTeamId(expected.teamId);
  requireSha(expected.sourceRevision, "Expected dashboard source revision");
  const expectedHost = requireDeploymentOrigin(expected.deploymentOrigin).hostname;
  const alias = requireRecord(aliasValue, "Vercel alias");
  requireExactString(alias.alias, DASHBOARD_HOST, "Vercel alias host");
  requireExactString(alias.projectId, expected.projectId, "Vercel alias project");
  const deploymentId = requirePatternString(
    alias.deploymentId,
    DEPLOYMENT_ID_PATTERN,
    "Vercel alias deployment ID",
  );
  const aliasDeployment = requireRecord(alias.deployment, "Vercel alias deployment");
  requireExactString(aliasDeployment.id, deploymentId, "Vercel alias deployment identity");
  requireExactString(aliasDeployment.url, expectedHost, "Vercel alias deployment URL");
  const aliasUpdatedAt = requireEpoch(alias.updatedAt, "Vercel alias update time");

  const deployment = requireRecord(deploymentValue, "Vercel deployment");
  requireExactString(deployment.id, deploymentId, "Vercel deployment identity");
  requireExactString(deployment.name, PROJECT_NAME, "Vercel deployment name");
  requireExactString(deployment.url, expectedHost, "Vercel immutable deployment URL");
  requireExactString(deployment.readyState, "READY", "Vercel deployment state");
  requireExactString(deployment.target, "production", "Vercel deployment target");
  const project = requireRecord(deployment.project, "Vercel deployment project");
  requireExactString(project.id, expected.projectId, "Vercel deployment project ID");
  requireExactString(project.name, PROJECT_NAME, "Vercel deployment project name");
  const team = requireRecord(deployment.team, "Vercel deployment team");
  requireExactString(team.id, expected.teamId, "Vercel deployment team ID");
  const meta = requireRecord(deployment.meta, "Vercel deployment source metadata");
  requireExactString(meta.githubCommitOrg, EXPECTED_GITHUB_ORG, "Vercel GitHub commit org");
  requireExactString(meta.githubCommitRepo, EXPECTED_GITHUB_REPO, "Vercel GitHub commit repo");
  requireExactString(meta.githubCommitRef, EXPECTED_GITHUB_REF, "Vercel GitHub commit ref");
  requireExactString(
    meta.githubCommitSha,
    expected.sourceRevision,
    "Vercel GitHub commit revision",
  );
  requireExactString(meta.githubOrg, EXPECTED_GITHUB_ORG, "Vercel GitHub org");
  requireExactString(meta.githubRepo, EXPECTED_GITHUB_REPO, "Vercel GitHub repo");
  const createdAt = requireEpoch(deployment.createdAt, "Vercel deployment creation time");
  const readyAt = requireEpoch(deployment.ready, "Vercel deployment ready time");
  if (readyAt < createdAt || aliasUpdatedAt < readyAt) {
    throw new Error("Vercel deployment and alias times are incoherent");
  }
  return Object.freeze({
    deploymentId,
    immutableOrigin: `https://${expectedHost}`,
    sourceRevision: expected.sourceRevision,
    createdAt: new Date(createdAt).toISOString(),
    readyAt: new Date(readyAt).toISOString(),
    aliasUpdatedAt: new Date(aliasUpdatedAt).toISOString(),
  });
}

export function compileDashboardProductionReceipt(
  input: DashboardProductionReceiptInput,
): DashboardProductionDeploymentReceipt {
  if (input.repository !== EXPECTED_REPOSITORY) throw new Error("Dashboard repository is invalid");
  requireSha(input.sourceRevision, "Dashboard source revision");
  requireSha(input.workflowRevision, "Dashboard workflow revision");
  if (input.workflowRevision !== input.sourceRevision) {
    throw new Error("Dashboard workflow revision does not match the deployed source");
  }
  requireNumericId(input.runId, "Dashboard workflow run ID");
  requireNumericId(input.runAttempt, "Dashboard workflow run attempt");
  requireProjectId(input.projectId);
  requireTeamId(input.teamId);
  requirePatternString(
    input.provider.deploymentId,
    DEPLOYMENT_ID_PATTERN,
    "Dashboard deployment ID",
  );
  requireDeploymentOrigin(input.provider.immutableOrigin);
  requireSha(input.provider.sourceRevision, "Provider-current dashboard source revision");
  if (input.provider.sourceRevision !== input.sourceRevision) {
    throw new Error("Provider-current dashboard source does not match the deployed source");
  }
  requireTimestamp(input.provider.createdAt, "Dashboard deployment creation time");
  requireTimestamp(input.provider.readyAt, "Dashboard deployment ready time");
  requireTimestamp(input.provider.aliasUpdatedAt, "Dashboard alias update time");
  requireTimestamp(input.observedAt, "Dashboard receipt observation time");
  const core = Object.freeze({
    schemaVersion: "stensibly-dashboard-production-deployment-receipt/1" as const,
    repository: EXPECTED_REPOSITORY,
    sourceRevision: input.sourceRevision,
    workflowRevision: input.workflowRevision,
    run: Object.freeze({ id: input.runId, attempt: input.runAttempt }),
    provider: Object.freeze({
      name: "vercel" as const,
      projectId: input.projectId,
      projectName: PROJECT_NAME,
      teamId: input.teamId,
    }),
    canonical: Object.freeze({
      host: DASHBOARD_HOST,
      aliasUpdatedAt: input.provider.aliasUpdatedAt,
    }),
    production: Object.freeze({
      deploymentId: input.provider.deploymentId,
      immutableOrigin: input.provider.immutableOrigin,
      sourceRevision: input.provider.sourceRevision,
      createdAt: input.provider.createdAt,
      readyAt: input.provider.readyAt,
    }),
    providerCurrentVerified: true as const,
    authorizesDeployment: false as const,
    observedAt: input.observedAt,
  });
  return Object.freeze({ ...core, fingerprint: sha256(stableJson(core)) });
}

export async function runDashboardProductionReceipt(
  env: Record<string, string | undefined> = process.env,
  dependencies: DashboardProductionReceiptDependencies = defaultDependencies,
): Promise<DashboardProductionDeploymentReceipt> {
  const outputPath = requireRunnerTempChild(
    requiredEnvironment(env, "DASHBOARD_PRODUCTION_RECEIPT_OUTPUT"),
    requiredEnvironment(env, "RUNNER_TEMP"),
  );
  const sourceRevision = requireSha(requiredEnvironment(env, "GITHUB_SHA"), "GITHUB_SHA");
  const expectedRevision = requireSha(
    requiredEnvironment(env, "EXPECTED_REVISION"),
    "EXPECTED_REVISION",
  );
  const workflowRevision = requireSha(
    requiredEnvironment(env, "GITHUB_WORKFLOW_SHA"),
    "GITHUB_WORKFLOW_SHA",
  );
  if (sourceRevision !== expectedRevision) throw new Error("Dashboard source revision moved");
  const projectId = requireProjectId(requiredEnvironment(env, "VERCEL_PROJECT_ID"));
  const teamId = requireTeamId(requiredEnvironment(env, "VERCEL_ORG_ID"));
  const deploymentOrigin = requiredEnvironment(env, "DEPLOYMENT_URL");
  requireDeploymentOrigin(deploymentOrigin);
  const token = requiredEnvironment(env, "VERCEL_TOKEN");
  const aliasValue = await readProviderJson(
    `${VERCEL_API_ORIGIN}/v4/aliases/${DASHBOARD_HOST}?teamId=${teamId}`,
    token,
    dependencies,
  );
  const alias = requireRecord(aliasValue, "Vercel alias");
  const deploymentId = requirePatternString(
    alias.deploymentId,
    DEPLOYMENT_ID_PATTERN,
    "Vercel alias deployment ID",
  );
  const deploymentValue = await readProviderJson(
    `${VERCEL_API_ORIGIN}/v13/deployments/${deploymentId}?teamId=${teamId}`,
    token,
    dependencies,
  );
  const provider = observeDashboardProviderCurrent(aliasValue, deploymentValue, {
    projectId,
    teamId,
    deploymentOrigin,
    sourceRevision,
  });
  const receipt = compileDashboardProductionReceipt({
    repository: requiredEnvironment(env, "GITHUB_REPOSITORY"),
    sourceRevision,
    workflowRevision,
    runId: requiredEnvironment(env, "GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment(env, "GITHUB_RUN_ATTEMPT"),
    projectId,
    teamId,
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

async function readProviderJson(
  url: string,
  token: string,
  dependencies: DashboardProductionReceiptDependencies,
): Promise<unknown> {
  const response = await dependencies.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error(`Vercel receipt read returned ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("Vercel receipt response is not JSON");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_PROVIDER_BYTES) {
      throw new Error("Vercel receipt response exceeds the byte ceiling");
    }
  }
  const text = await readBoundedResponseText(response, MAXIMUM_PROVIDER_BYTES);
  return parseStrictJson(text, {
    prefix: "VERCEL_RECEIPT_JSON",
    maxBytes: MAXIMUM_PROVIDER_BYTES,
    maxDepth: 12,
    maxStringLength: 16_384,
    maxObjectKeys: 256,
    maxArrayLength: 256,
  });
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) throw new Error("Vercel receipt response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > maximumBytes - total) {
        await reader.cancel();
        throw new Error("Vercel receipt response exceeds the byte ceiling");
      }
      chunks.push(result.value.slice());
      total += result.value.byteLength;
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactString(value: unknown, expected: string, label: string): string {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return expected;
}

function requirePatternString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireNumericId(value: string, label: string): string {
  if (!NUMERIC_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireProjectId(value: string): string {
  return requirePatternString(value, PROJECT_ID_PATTERN, "Vercel project ID");
}

function requireTeamId(value: string): string {
  return requirePatternString(value, TEAM_ID_PATTERN, "Vercel team ID");
}

function requireEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function requireTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function requireDeploymentOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Vercel immutable deployment origin is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || !DEPLOYMENT_HOST_PATTERN.test(parsed.hostname)
  ) throw new Error("Vercel immutable deployment origin is invalid");
  return parsed;
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value || value.length > 16_384) throw new Error(`Missing or invalid receipt environment: ${name}`);
  return value;
}

function requireRunnerTempChild(outputPath: string, runnerTemp: string): string {
  const root = resolve(runnerTemp);
  const output = resolve(outputPath);
  if (output === root || !output.startsWith(`${root}${sep}`)) {
    throw new Error("Dashboard production receipt output must be inside RUNNER_TEMP");
  }
  return output;
}

const defaultDependencies: DashboardProductionReceiptDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

if (import.meta.main) await runDashboardProductionReceipt();
