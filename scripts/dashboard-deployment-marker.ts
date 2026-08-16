import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sha256, stableJson } from "../src/canonical-json.js";
import { parseStrictJson } from "../src/strict-json.js";

export const DASHBOARD_DEPLOYMENT_MARKER_SCHEMA_VERSION =
  "stensibly-dashboard-deployment-marker/1" as const;

const expectedRepository = "teamleaderleo/stensibly";
const markerRelativePath = ".vercel/output/static/.well-known/stensibly-deployment.json";
const shaPattern = /^[0-9a-f]{40}$/u;
const numericIdPattern = /^[1-9][0-9]{0,19}$/u;
const maximumMarkerBytes = 2_048;

export interface DashboardDeploymentMarkerInput {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export interface DashboardDeploymentMarker {
  readonly schemaVersion: typeof DASHBOARD_DEPLOYMENT_MARKER_SCHEMA_VERSION;
  readonly repository: typeof expectedRepository;
  readonly sourceRevision: string;
  readonly workflowRevision: string;
  readonly run: Readonly<{ id: string; attempt: string }>;
  readonly authorizesDeployment: false;
  readonly fingerprint: string;
}

export function compileDashboardDeploymentMarker(
  input: DashboardDeploymentMarkerInput,
): DashboardDeploymentMarker {
  if (input.repository !== expectedRepository) {
    throw new Error("Dashboard deployment marker repository is invalid");
  }
  const sourceRevision = requireSha(input.sourceRevision, "Dashboard marker source revision");
  const workflowRevision = requireSha(
    input.workflowRevision,
    "Dashboard marker workflow revision",
  );
  if (workflowRevision !== sourceRevision) {
    throw new Error("Dashboard marker workflow revision does not match its source");
  }
  const body = Object.freeze({
    schemaVersion: DASHBOARD_DEPLOYMENT_MARKER_SCHEMA_VERSION,
    repository: expectedRepository,
    sourceRevision,
    workflowRevision,
    run: Object.freeze({
      id: requireNumericId(input.runId, "Dashboard marker run ID"),
      attempt: requireNumericId(input.runAttempt, "Dashboard marker run attempt"),
    }),
    authorizesDeployment: false as const,
  });
  return Object.freeze({ ...body, fingerprint: sha256(stableJson(body)) });
}

export function admitDashboardDeploymentMarker(
  value: unknown,
  expected: DashboardDeploymentMarkerInput,
): DashboardDeploymentMarker {
  const admitted = parseDashboardDeploymentMarker(value);
  const exactExpected = compileDashboardDeploymentMarker(expected);
  if (stableJson(admitted) !== stableJson(exactExpected)) {
    throw new Error("Dashboard deployment marker does not match the exact publication");
  }
  return admitted;
}

export function parseDashboardDeploymentMarker(
  value: unknown,
): DashboardDeploymentMarker {
  const marker = exactRecord(value, "Dashboard deployment marker", [
    "schemaVersion",
    "repository",
    "sourceRevision",
    "workflowRevision",
    "run",
    "authorizesDeployment",
    "fingerprint",
  ]);
  const run = exactRecord(marker.run, "Dashboard deployment marker run", ["id", "attempt"]);
  const admitted = compileDashboardDeploymentMarker({
    repository: requireString(marker.repository, "Dashboard marker repository"),
    sourceRevision: requireString(marker.sourceRevision, "Dashboard marker source revision"),
    workflowRevision: requireString(
      marker.workflowRevision,
      "Dashboard marker workflow revision",
    ),
    runId: requireString(run.id, "Dashboard marker run ID"),
    runAttempt: requireString(run.attempt, "Dashboard marker run attempt"),
  });
  if (
    admitted.schemaVersion !== marker.schemaVersion
    || marker.authorizesDeployment !== false
    || admitted.fingerprint !== marker.fingerprint
  ) {
    throw new Error("Dashboard deployment marker is not self-consistent");
  }
  return admitted;
}

export async function runDashboardDeploymentMarker(
  env: Record<string, string | undefined> = process.env,
): Promise<DashboardDeploymentMarker> {
  const expected = environmentIdentity(env);
  const mode = requiredEnvironment(env, "DASHBOARD_DEPLOYMENT_MARKER_MODE");
  const path = requiredEnvironment(env, "DASHBOARD_DEPLOYMENT_MARKER_PATH");
  if (mode === "write") {
    const expectedPath = resolve(process.cwd(), markerRelativePath);
    if (resolve(path) !== expectedPath) {
      throw new Error("Dashboard deployment marker output path is invalid");
    }
    const marker = compileDashboardDeploymentMarker(expected);
    await mkdir(dirname(expectedPath), { recursive: true });
    await writeFile(expectedPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    return marker;
  }
  if (mode !== "verify") throw new Error("Dashboard deployment marker mode is invalid");
  const runnerTemp = resolve(requiredEnvironment(env, "RUNNER_TEMP"));
  const inputPath = resolve(path);
  if (inputPath === runnerTemp || !inputPath.startsWith(`${runnerTemp}${sep}`)) {
    throw new Error("Dashboard deployment marker input must be inside RUNNER_TEMP");
  }
  const metadata = await lstat(inputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumMarkerBytes) {
    throw new Error("Dashboard deployment marker must be one bounded ordinary file");
  }
  const bytes = await readFile(inputPath);
  if (bytes.byteLength > maximumMarkerBytes) {
    throw new Error("Dashboard deployment marker exceeds its byte ceiling");
  }
  return admitDashboardDeploymentMarker(parseStrictJson(bytes.toString("utf8"), {
    prefix: "DASHBOARD_DEPLOYMENT_MARKER",
    maxBytes: maximumMarkerBytes,
    maxDepth: 6,
    maxStringLength: 256,
    maxObjectKeys: 16,
    maxArrayLength: 4,
  }), expected);
}

function environmentIdentity(
  env: Record<string, string | undefined>,
): DashboardDeploymentMarkerInput {
  const sourceRevision = requireSha(
    requiredEnvironment(env, "EXPECTED_REVISION"),
    "Expected dashboard revision",
  );
  const githubSha = requireSha(requiredEnvironment(env, "GITHUB_SHA"), "GITHUB_SHA");
  if (githubSha !== sourceRevision) throw new Error("Dashboard marker source revision moved");
  return Object.freeze({
    repository: requiredEnvironment(env, "GITHUB_REPOSITORY"),
    sourceRevision,
    workflowRevision: requiredEnvironment(env, "GITHUB_WORKFLOW_SHA"),
    runId: requiredEnvironment(env, "GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment(env, "GITHUB_RUN_ATTEMPT"),
  });
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not exact`);
  }
  return record;
}

function requiredEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value || value.length > 4_096) throw new Error(`Missing or invalid marker environment: ${name}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!shaPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireNumericId(value: string, label: string): string {
  if (!numericIdPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

if (import.meta.main) await runDashboardDeploymentMarker();
