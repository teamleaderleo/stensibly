import { appendFile, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFFICIAL_ENDPOINT = "https://api.stensibly.com";
const FALLBACK_ENDPOINT = "https://stensibly-api.leoli-082000.workers.dev";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRANGLER_CONFIG = "wrangler.jsonc";
const STANDARD_RETRY_ATTEMPTS = 3;
const EDGE_CONVERGENCE_RETRY_ATTEMPTS = 12;
const RETRY_DELAY_MILLISECONDS = 10_000;

class WorkerVersionMismatchError extends Error {
  constructor(
    readonly observedVersionId: string | null,
    readonly expectedVersionIds: readonly string[],
  ) {
    super(
      `Health reached Worker version ${observedVersionId ?? "missing"}; expected ${expectedVersionIds.join(", ")}`,
    );
    this.name = "WorkerVersionMismatchError";
  }
}

export interface ProductionBindingExpectation {
  name: string;
  type: "plain_text" | "ratelimit" | "secret_text";
  text?: string;
}

export interface ProductionBindingContract {
  version: 1;
  workerName: string;
  requiredBindings: ProductionBindingExpectation[];
  forbiddenBindings: string[];
}

export const PRODUCTION_BINDING_CONTRACT = await loadProductionBindingContract();
const WORKER_NAME = PRODUCTION_BINDING_CONTRACT.workerName;
export const REQUIRED_PRODUCTION_BINDINGS = Object.freeze(Object.fromEntries(
  PRODUCTION_BINDING_CONTRACT.requiredBindings.map((binding) => [binding.name, Object.freeze(binding)]),
));

export const SAFE_IGNORED_RELEASE_PATHS = Object.freeze([
  ".wrangler-dry-run/",
  "node_modules/",
] as const);

export interface WorkerBinding {
  name?: unknown;
  type?: unknown;
  text?: unknown;
}

export interface WorkerVersionView {
  id?: unknown;
  resources?: {
    bindings?: unknown;
  };
}

export interface DeploymentVersion {
  version_id: string;
  percentage: number;
}

export interface DeploymentSnapshot {
  id: string;
  created_on: string;
  versions: DeploymentVersion[];
}

export interface CommandResult {
  stdout: string;
}

export interface ReleaseDependencies {
  run(command: string, args: string[], options?: { env?: Record<string, string> }): Promise<CommandResult>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  sleep(milliseconds: number): Promise<void>;
  cleanupWranglerTemporaryDirectories(): Promise<void>;
  createWranglerOutputFile(): Promise<{ directory: string; path: string }>;
  removeTemporaryDirectory(path: string): Promise<void>;
}

export interface ProductionReleaseOptions {
  expectedSha: string;
  oauthExpectation: "disabled" | "enabled";
  project?: string;
  githubOutput?: string;
}

export interface ProductionReleaseResult {
  baselineDeploymentId: string;
  candidateVersionId: string;
  candidatePreviewUrl: string;
  recovered: boolean;
}

export function validateProductionVersion(
  version: WorkerVersionView,
  expectedVersionId?: string,
): string[] {
  const problems: string[] = [];
  if (expectedVersionId && version.id !== expectedVersionId) {
    problems.push(`version identity is ${String(version.id)}; expected ${expectedVersionId}`);
  }
  const rawBindings = version.resources?.bindings;
  if (!Array.isArray(rawBindings)) {
    return [...problems, "version binding inventory is missing"];
  }
  const bindings = new Map<string, WorkerBinding>();
  for (const binding of rawBindings) {
    if (!isRecord(binding) || typeof binding.name !== "string") continue;
    bindings.set(binding.name, binding);
  }
  for (const [name, expected] of Object.entries(REQUIRED_PRODUCTION_BINDINGS)) {
    const actual = bindings.get(name);
    if (!actual) {
      problems.push(`required binding ${name} is missing`);
      continue;
    }
    if (actual.type !== expected.type) {
      problems.push(`binding ${name} has type ${String(actual.type)}; expected ${expected.type}`);
      continue;
    }
    if (expected.text !== undefined && actual.text !== expected.text) {
      problems.push(`binding ${name} has an unexpected production value`);
    }
  }
  for (const name of PRODUCTION_BINDING_CONTRACT.forbiddenBindings) {
    if (bindings.has(name)) problems.push(`obsolete binding ${name} must be absent`);
  }
  return problems;
}

export function newestDeployment(input: unknown): DeploymentSnapshot {
  if (!Array.isArray(input)) throw new Error("Wrangler deployment inventory is not an array");
  const deployments = input.map(parseDeploymentSnapshot);
  if (deployments.length === 0) throw new Error("Worker has no deployment to preserve");
  return deployments.reduce((latest, candidate) => (
    Date.parse(candidate.created_on) > Date.parse(latest.created_on) ? candidate : latest
  ));
}

export function deploymentSpecs(versions: readonly DeploymentVersion[]): string[] {
  if (versions.length < 1 || versions.length > 2) {
    throw new Error(`Expected one or two deployed versions; received ${versions.length}`);
  }
  const total = versions.reduce((sum, version) => sum + version.percentage, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`Deployment percentages sum to ${total}; expected 100`);
  }
  return versions.map((version) => `${version.version_id}@${version.percentage}%`);
}

export function sameVersions(
  left: readonly DeploymentVersion[],
  right: readonly DeploymentVersion[],
): boolean {
  const normalize = (versions: readonly DeploymentVersion[]) => versions
    .map((version) => `${version.version_id}@${version.percentage}`)
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function releaseWorktreeProblems(status: string): string[] {
  const problems = new Set<string>();
  const safeIgnored = new Set<string>(SAFE_IGNORED_RELEASE_PATHS);
  for (const line of status.split(/\r?\n/u).filter(Boolean)) {
    if (line.startsWith("!! ")) {
      if (!safeIgnored.has(line.slice(3))) {
        problems.add("an unapproved ignored path is present");
      }
      continue;
    }
    if (line.startsWith("?? ")) {
      problems.add("an ordinary untracked path is present");
      continue;
    }
    problems.add("a tracked worktree change is present");
  }
  return [...problems];
}

export async function runProductionRelease(
  options: ProductionReleaseOptions,
  dependencies: ReleaseDependencies = defaultDependencies,
): Promise<ProductionReleaseResult> {
  validateReleaseOptions(options);
  requireCredentialEnvironment();
  await assertExactMain(options.expectedSha, dependencies);
  const baseline = await getNewestDeployment(dependencies);
  const upload = await uploadCandidate(options.expectedSha, dependencies);
  await writeGithubOutputs(options.githubOutput, {
    baseline_deployment_id: baseline.id,
    candidate_version_id: upload.versionId,
    candidate_preview_url: upload.previewUrl,
    recovered: "false",
  });

  let promoted = false;
  let recovered = false;
  try {
    await assertProductionVersion(upload.versionId, dependencies);
    await verifyCandidate(upload.versionId, upload.previewUrl, options, dependencies);
    await assertExactMain(options.expectedSha, dependencies);
    await assertDeploymentUnchanged(baseline, dependencies);
    await assertProductionVersion(upload.versionId, dependencies);

    await dependencies.run("bunx", wranglerArgs(
      "wrangler",
      "versions",
      "deploy",
      `${upload.versionId}@100%`,
      "--name",
      WORKER_NAME,
      "--message",
      `Promote exact Stensibly main ${options.expectedSha}`,
      "--yes",
    ));
    promoted = true;
    await writeGithubOutputs(options.githubOutput, { promoted: "true" });
    await assertCandidateActive(upload.versionId, dependencies);
    await verifyProduction(upload.versionId, options, dependencies);
    return {
      baselineDeploymentId: baseline.id,
      candidateVersionId: upload.versionId,
      candidatePreviewUrl: upload.previewUrl,
      recovered: false,
    };
  } catch (error) {
    const active = await candidateIsSoleActiveVersion(upload.versionId, dependencies);
    if (promoted || active) {
      await recoverBaseline(upload.versionId, baseline, dependencies);
      await verifyRecoveredBaseline(baseline, dependencies);
      recovered = true;
      await writeGithubOutputs(options.githubOutput, { recovered: "true" });
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      recovered
        ? `Production candidate failed and the previous deployment was restored: ${detail}`
        : `Production candidate failed before promotion: ${detail}`,
      { cause: error },
    );
  }
}

async function assertExactMain(expectedSha: string, dependencies: ReleaseDependencies): Promise<void> {
  const worktreeStatus = (await dependencies.run("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ])).stdout.trim();
  const worktreeProblems = releaseWorktreeProblems(worktreeStatus);
  if (worktreeProblems.length > 0) {
    throw new Error(`Production release worktree is not clean: ${worktreeProblems.join("; ")}`);
  }
  const head = (await dependencies.run("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== expectedSha) {
    throw new Error(`Checked-out candidate ${head} does not match expected SHA ${expectedSha}`);
  }
  await dependencies.run("git", [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const currentMain = (await dependencies.run("git", [
    "rev-parse",
    "refs/remotes/origin/main",
  ])).stdout.trim();
  if (currentMain !== expectedSha) {
    throw new Error(`Stale production candidate ${expectedSha}; current origin/main is ${currentMain}`);
  }
}

async function uploadCandidate(
  expectedSha: string,
  dependencies: ReleaseDependencies,
): Promise<{ versionId: string; previewUrl: string }> {
  const output = await dependencies.createWranglerOutputFile();
  try {
    await dependencies.run("bunx", wranglerArgs(
      "wrangler",
      "versions",
      "upload",
      "--name",
      WORKER_NAME,
      "--tag",
      `git-${expectedSha}`,
      "--message",
      `Stensibly main ${expectedSha}`,
      "--strict",
    ), {
      env: { WRANGLER_OUTPUT_FILE_PATH: output.path },
    });
    const events = parseJsonLines(await readFile(output.path, "utf8"));
    const event = events.find((candidate) => candidate.type === "version-upload");
    const versionId = typeof event?.version_id === "string" ? event.version_id : "";
    const previewUrl = typeof event?.preview_url === "string" ? event.preview_url : "";
    if (!UUID_PATTERN.test(versionId)) throw new Error("Wrangler did not report a candidate version ID");
    if (!isHttpsUrl(previewUrl)) throw new Error("Wrangler did not report an HTTPS candidate preview URL");
    return { versionId, previewUrl };
  } finally {
    try {
      await dependencies.removeTemporaryDirectory(output.directory);
    } finally {
      await dependencies.cleanupWranglerTemporaryDirectories();
    }
  }
}

async function assertProductionVersion(
  versionId: string,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const result = await dependencies.run("bunx", wranglerArgs(
    "wrangler",
    "versions",
    "view",
    versionId,
    "--name",
    WORKER_NAME,
    "--json",
  ));
  const version = JSON.parse(result.stdout) as WorkerVersionView;
  const problems = validateProductionVersion(version, versionId);
  if (problems.length > 0) {
    throw new Error(`Uploaded Worker version is not production-bound:\n- ${problems.join("\n- ")}`);
  }
}

async function getNewestDeployment(dependencies: ReleaseDependencies): Promise<DeploymentSnapshot> {
  const result = await dependencies.run("bunx", wranglerArgs(
    "wrangler",
    "deployments",
    "list",
    "--name",
    WORKER_NAME,
    "--json",
  ));
  return newestDeployment(JSON.parse(result.stdout));
}

async function assertDeploymentUnchanged(
  baseline: DeploymentSnapshot,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const current = await getNewestDeployment(dependencies);
  if (current.id !== baseline.id || !sameVersions(current.versions, baseline.versions)) {
    throw new Error(
      `Production deployment changed during candidate verification; expected ${baseline.id}, found ${current.id}`,
    );
  }
}

async function assertCandidateActive(
  candidateVersionId: string,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const current = await getNewestDeployment(dependencies);
  const expected = [{ version_id: candidateVersionId, percentage: 100 }];
  if (!sameVersions(current.versions, expected)) {
    throw new Error(`Promoted version ${candidateVersionId} is not the sole active version`);
  }
}

async function candidateIsSoleActiveVersion(
  candidateVersionId: string,
  dependencies: ReleaseDependencies,
): Promise<boolean> {
  const current = await getNewestDeployment(dependencies);
  return sameVersions(current.versions, [{ version_id: candidateVersionId, percentage: 100 }]);
}

async function recoverBaseline(
  candidateVersionId: string,
  baseline: DeploymentSnapshot,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const current = await getNewestDeployment(dependencies);
  const candidate = [{ version_id: candidateVersionId, percentage: 100 }];
  if (!sameVersions(current.versions, candidate)) {
    throw new Error(
      `Refusing to overwrite concurrent deployment ${current.id} while recovering candidate ${candidateVersionId}`,
    );
  }
  await dependencies.run("bunx", wranglerArgs(
    "wrangler",
    "versions",
    "deploy",
    ...deploymentSpecs(baseline.versions),
    "--name",
    WORKER_NAME,
    "--message",
    `Restore deployment ${baseline.id} after failed guarded release`,
    "--yes",
  ));
  const recovered = await getNewestDeployment(dependencies);
  if (!sameVersions(recovered.versions, baseline.versions)) {
    throw new Error(`Recovery deployment ${recovered.id} does not match baseline ${baseline.id}`);
  }
}

async function verifyCandidate(
  candidateVersionId: string,
  previewUrl: string,
  options: ProductionReleaseOptions,
  dependencies: ReleaseDependencies,
): Promise<void> {
  await retry("exact candidate preview health verification", dependencies, () => verifyHealthVersion(
    previewUrl,
    [candidateVersionId],
    dependencies,
  ));
  await retry("candidate bearer verification", dependencies, () => runHostedVerifier(
    previewUrl,
    options.project,
    dependencies,
  ));
  await retry("candidate OAuth verification", dependencies, () => runOAuthVerifier(
    previewUrl,
    options.oauthExpectation,
    dependencies,
  ));
}

async function verifyProduction(
  candidateVersionId: string,
  options: ProductionReleaseOptions,
  dependencies: ReleaseDependencies,
): Promise<void> {
  for (const endpoint of [FALLBACK_ENDPOINT, OFFICIAL_ENDPOINT]) {
    await retry(
      `exact health verification at ${endpoint}`,
      dependencies,
      () => verifyHealthVersion(endpoint, [candidateVersionId], dependencies),
      endpoint === OFFICIAL_ENDPOINT
        ? {
          attempts: EDGE_CONVERGENCE_RETRY_ATTEMPTS,
          retryable: (error) => error instanceof WorkerVersionMismatchError
            && error.observedVersionId !== null,
        }
        : undefined,
    );
    await retry(`bearer verification at ${endpoint}`, dependencies, () => runHostedVerifier(
      endpoint,
      options.project,
      dependencies,
    ));
    await retry(`OAuth verification at ${endpoint}`, dependencies, () => runOAuthVerifier(
      endpoint,
      options.oauthExpectation,
      dependencies,
    ));
  }
  await assertCandidateActive(candidateVersionId, dependencies);
}

async function verifyRecoveredBaseline(
  baseline: DeploymentSnapshot,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const expectedVersionIds = baseline.versions.map((version) => version.version_id);
  for (const endpoint of [FALLBACK_ENDPOINT, OFFICIAL_ENDPOINT]) {
    await retry(
      `recovery health verification at ${endpoint}`,
      dependencies,
      () => verifyHealthVersion(endpoint, expectedVersionIds, dependencies),
      endpoint === OFFICIAL_ENDPOINT
        ? {
          attempts: EDGE_CONVERGENCE_RETRY_ATTEMPTS,
          retryable: (error) => error instanceof WorkerVersionMismatchError
            && error.observedVersionId !== null,
        }
        : undefined,
    );
  }
}

async function verifyHealthVersion(
  endpoint: string,
  expectedVersionIds: readonly string[],
  dependencies: ReleaseDependencies,
): Promise<void> {
  const response = await dependencies.fetch(`${endpoint}/health`, {
    headers: { "cache-control": "no-store" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error(`Health returned ${response.status}`);
  const versionId = response.headers.get("x-stensibly-worker-version-id")?.trim();
  if (!versionId || !expectedVersionIds.includes(versionId)) {
    throw new WorkerVersionMismatchError(versionId || null, expectedVersionIds);
  }
}

async function runHostedVerifier(
  endpoint: string,
  project: string | undefined,
  dependencies: ReleaseDependencies,
): Promise<void> {
  const env = project ? { STENSIBLY_PROJECT: project } : undefined;
  await dependencies.run("bun", [
    "run",
    "verify:hosted",
    "--",
    "--endpoint",
    endpoint,
  ], env ? { env } : undefined);
}

async function runOAuthVerifier(
  endpoint: string,
  expectation: "disabled" | "enabled",
  dependencies: ReleaseDependencies,
): Promise<void> {
  await dependencies.run("bun", [
    "run",
    "verify:oauth",
    "--",
    "--endpoint",
    endpoint,
    "--issuer",
    OFFICIAL_ENDPOINT,
    "--expect",
    expectation,
  ]);
}

async function retry(
  label: string,
  dependencies: ReleaseDependencies,
  operation: () => Promise<void>,
  policy: {
    attempts?: number;
    delayMilliseconds?: number;
    retryable?: (error: unknown) => boolean;
  } = {},
): Promise<void> {
  const attempts = policy.attempts ?? STANDARD_RETRY_ATTEMPTS;
  const delayMilliseconds = policy.delayMilliseconds ?? RETRY_DELAY_MILLISECONDS;
  let lastError: unknown;
  let ordinaryFailures = 0;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsMade = attempt;
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (!policy.retryable?.(error)) {
        ordinaryFailures += 1;
        if (ordinaryFailures >= STANDARD_RETRY_ATTEMPTS) break;
      }
      if (attempt < attempts) await dependencies.sleep(delayMilliseconds);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attemptsMade} attempts: ${detail}`, { cause: lastError });
}

function parseDeploymentSnapshot(value: unknown): DeploymentSnapshot {
  if (!isRecord(value) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    throw new Error("Wrangler returned an invalid deployment ID");
  }
  if (typeof value.created_on !== "string" || Number.isNaN(Date.parse(value.created_on))) {
    throw new Error(`Deployment ${value.id} has an invalid creation time`);
  }
  if (!Array.isArray(value.versions)) {
    throw new Error(`Deployment ${value.id} has no version distribution`);
  }
  const versions = value.versions.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.version_id !== "string"
      || !UUID_PATTERN.test(entry.version_id)
      || typeof entry.percentage !== "number"
      || !Number.isFinite(entry.percentage)
      || entry.percentage < 0
      || entry.percentage > 100
    ) {
      throw new Error(`Deployment ${value.id} contains an invalid version distribution`);
    }
    return { version_id: entry.version_id, percentage: entry.percentage };
  });
  deploymentSpecs(versions);
  return { id: value.id, created_on: value.created_on, versions };
}

function parseJsonLines(input: string): Array<Record<string, unknown>> {
  return input.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("Wrangler output contains a non-object event");
      return value;
    });
}

function validateReleaseOptions(options: ProductionReleaseOptions): void {
  if (!SHA_PATTERN.test(options.expectedSha)) throw new Error("Expected SHA must be 40 lowercase hex characters");
  if (options.oauthExpectation !== "disabled" && options.oauthExpectation !== "enabled") {
    throw new Error("OAuth expectation must be disabled or enabled");
  }
  if (options.project && !/^[a-z0-9][a-z0-9_-]*$/u.test(options.project)) {
    throw new Error("Project must be a lowercase project slug");
  }
}

function requireCredentialEnvironment(): void {
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "STENSIBLY_TOKEN"]) {
    if (!process.env[name]?.trim()) throw new Error(`Missing required production environment secret: ${name}`);
  }
}

async function writeGithubOutputs(
  path: string | undefined,
  values: Record<string, string>,
): Promise<void> {
  if (!path) return;
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[a-z_]+$/u.test(name) || /[\r\n]/u.test(value)) throw new Error("Invalid GitHub output value");
    return `${name}=${value}`;
  });
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

function wranglerArgs(...args: string[]): string[] {
  return [...args, "--config", WRANGLER_CONFIG];
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProductionBindingContract(): Promise<ProductionBindingContract> {
  const input: unknown = await Bun.file(new URL(
    "../config/worker-production-bindings.json",
    import.meta.url,
  )).json();
  if (
    !isRecord(input)
    || input.version !== 1
    || typeof input.workerName !== "string"
    || !/^[a-z0-9][a-z0-9-]*$/u.test(input.workerName)
    || !Array.isArray(input.requiredBindings)
    || !Array.isArray(input.forbiddenBindings)
  ) {
    throw new Error("Production Worker binding contract is invalid");
  }
  const requiredBindings = input.requiredBindings.map((binding) => {
    if (
      !isRecord(binding)
      || typeof binding.name !== "string"
      || !/^[A-Z][A-Z0-9_]*$/u.test(binding.name)
      || (
        binding.type !== "plain_text"
        && binding.type !== "ratelimit"
        && binding.type !== "secret_text"
      )
      || (binding.type === "plain_text" && typeof binding.text !== "string")
      || (binding.type !== "plain_text" && binding.text !== undefined)
    ) {
      throw new Error("Production Worker binding contract has an invalid requirement");
    }
    return {
      name: binding.name,
      type: binding.type,
      ...(typeof binding.text === "string" ? { text: binding.text } : {}),
    } satisfies ProductionBindingExpectation;
  });
  const forbiddenBindings = input.forbiddenBindings.map((binding) => {
    if (typeof binding !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(binding)) {
      throw new Error("Production Worker binding contract has an invalid forbidden binding");
    }
    return binding;
  });
  const requiredNames = new Set(requiredBindings.map((binding) => binding.name));
  if (requiredNames.size !== requiredBindings.length) {
    throw new Error("Production Worker binding contract repeats a required binding");
  }
  if (forbiddenBindings.some((binding) => requiredNames.has(binding))) {
    throw new Error("Production Worker binding contract both requires and forbids one binding");
  }
  return {
    version: 1,
    workerName: input.workerName,
    requiredBindings,
    forbiddenBindings,
  };
}

const defaultDependencies: ReleaseDependencies = {
  async run(command, args, options) {
    const env = { ...process.env, ...(options?.env ?? {}) };
    const child = Bun.spawn([command, ...args], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (stdout) process.stdout.write(stdout);
    if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with status ${exitCode}`);
    return { stdout };
  },
  fetch: (input, init) => fetch(input, init),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  async cleanupWranglerTemporaryDirectories() {
    for (const path of [".wrangler/tmp", ".wrangler"]) {
      try {
        await rmdir(path);
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") continue;
        throw new Error(`Wrangler left non-empty or unexpected release state at ${path}`, {
          cause: error,
        });
      }
    }
  },
  async createWranglerOutputFile() {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-worker-release-"));
    return { directory, path: join(directory, "wrangler-output.jsonl") };
  },
  removeTemporaryDirectory: (path) => rm(path, { recursive: true, force: true }),
};

function parseCli(argv: string[]): ProductionReleaseOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid release argument ${key ?? "missing"}`);
    values.set(key.slice(2), value);
  }
  const expectedSha = values.get("expected-sha") ?? "";
  const oauthExpectation = values.get("oauth-expectation");
  if (oauthExpectation !== "disabled" && oauthExpectation !== "enabled") {
    throw new Error("--oauth-expectation must be disabled or enabled");
  }
  return {
    expectedSha,
    oauthExpectation,
    ...(values.get("project") ? { project: values.get("project") } : {}),
    ...(values.get("github-output") ? { githubOutput: values.get("github-output") } : {}),
  };
}

if (import.meta.main) {
  try {
    const result = await runProductionRelease(parseCli(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: true,
      baselineDeploymentId: result.baselineDeploymentId,
      candidateVersionId: result.candidateVersionId,
      candidatePreviewUrl: result.candidatePreviewUrl,
      recovered: result.recovered,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
