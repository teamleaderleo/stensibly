import { Buffer } from "node:buffer";
import { appendFile } from "node:fs/promises";

export const DASHBOARD_RELEASE_WINDOW_CONTRACT_VERSION = 1 as const;

const activeStatuses = new Set(["requested", "waiting", "pending", "queued", "in_progress"]);
const exactPaths = new Set([
  ".github/workflows/auto-deploy-dashboard.yml",
  ".github/workflows/deploy-dashboard.yml",
  ".github/workflows/publish-dashboard-on-main.yml",
  "bun.lock",
  "package.json",
  "scripts/link-vercel-project-domain.sh",
  "src/dashboard-assets.ts",
  "src/dashboard-deployment-diagnostics.ts",
  "src/verify-dashboard.ts",
]);
const shaPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const maximumApiResponseBytes = 2 * 1024 * 1024;
const maximumComparedFiles = 300;
const publisherWorkflow = "publish-dashboard-on-main.yml";

export interface DashboardWorkflowRun {
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
  readonly createdAt: string;
}

export interface DashboardReleaseDecisionInput {
  readonly force: boolean;
  readonly activeRun: boolean;
  readonly currentSha: string;
  readonly baselineSha: string | null;
  readonly attemptedSha: string | null;
  readonly compareStatus?: "ahead" | "identical" | "behind" | "diverged" | "unavailable";
  readonly changedFiles?: readonly string[];
  readonly compareTruncated?: boolean;
}

export type DashboardReleaseDecision = Readonly<{
  action: "dispatch" | "skip";
  reason:
    | "manual_force"
    | "active_run"
    | "missing_baseline"
    | "already_current"
    | "already_attempted"
    | "relevant_changes"
    | "no_relevant_changes"
    | "comparison_unavailable"
    | "comparison_truncated"
    | "history_not_linear";
}>;

export function isDashboardReleasePath(path: string): boolean {
  return isSafePath(path) && (path.startsWith("site/") || exactPaths.has(path));
}

export function hasActiveDashboardRun(runs: readonly DashboardWorkflowRun[]): boolean {
  return runs.some((run) => activeStatuses.has(run.status));
}

export function latestSuccessfulDashboardSha(runs: readonly DashboardWorkflowRun[]): string | null {
  return latestRunSha(runs.filter((run) => run.conclusion === "success"));
}

export function latestAttemptedDashboardSha(runs: readonly DashboardWorkflowRun[]): string | null {
  return latestRunSha(runs);
}

export function decideDashboardRelease(input: DashboardReleaseDecisionInput): DashboardReleaseDecision {
  requireSha(input.currentSha, "Current main revision");
  if (input.baselineSha !== null) requireSha(input.baselineSha, "Dashboard baseline revision");
  if (input.attemptedSha !== null) requireSha(input.attemptedSha, "Dashboard attempted revision");

  if (input.force) return Object.freeze({ action: "dispatch", reason: "manual_force" });
  if (input.activeRun) return Object.freeze({ action: "skip", reason: "active_run" });
  if (input.baselineSha === input.currentSha) return Object.freeze({ action: "skip", reason: "already_current" });
  if (input.attemptedSha === input.currentSha) return Object.freeze({ action: "skip", reason: "already_attempted" });
  if (input.baselineSha === null) return Object.freeze({ action: "dispatch", reason: "missing_baseline" });
  if (input.compareStatus === undefined || input.compareStatus === "unavailable") {
    return Object.freeze({ action: "skip", reason: "comparison_unavailable" });
  }
  if (input.compareStatus === "behind" || input.compareStatus === "diverged") {
    return Object.freeze({ action: "skip", reason: "history_not_linear" });
  }
  if ((input.changedFiles ?? []).some(isDashboardReleasePath)) {
    return Object.freeze({ action: "dispatch", reason: "relevant_changes" });
  }
  if (input.compareTruncated) return Object.freeze({ action: "skip", reason: "comparison_truncated" });
  return Object.freeze({ action: "skip", reason: "no_relevant_changes" });
}

export async function runDashboardReleaseWindow(
  env: Readonly<Record<string, string | undefined>> = process.env,
  request: typeof fetch = fetch,
): Promise<DashboardReleaseDecision> {
  if (requiredEnvironment(env, "GITHUB_REF") !== "refs/heads/main") {
    throw new Error("Dashboard release windows must run from the main branch");
  }

  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY");
  if (!repositoryPattern.test(repository)) throw new Error("GITHUB_REPOSITORY is invalid");
  const client = githubClient({
    apiBase: parseApiBase(requiredEnvironment(env, "GITHUB_API_URL")),
    repository,
    token: requiredEnvironment(env, "GITHUB_TOKEN"),
    request,
  });
  const force = parseBoolean(env.FORCE_DASHBOARD_RELEASE ?? "false", "FORCE_DASHBOARD_RELEASE");
  const currentSha = await client.mainSha();
  const runs = await client.publisherRuns();
  const baselineSha = latestSuccessfulDashboardSha(runs);
  const attemptedSha = latestAttemptedDashboardSha(runs);
  const activeRun = hasActiveDashboardRun(runs);

  let compareStatus: DashboardReleaseDecisionInput["compareStatus"];
  let changedFiles: readonly string[] | undefined;
  let compareTruncated = false;
  if (!force && !activeRun && baselineSha !== null && baselineSha !== currentSha && attemptedSha !== currentSha) {
    try {
      const comparison = await client.compare(baselineSha, currentSha);
      compareStatus = comparison.status;
      changedFiles = comparison.files;
      compareTruncated = comparison.files.length === maximumComparedFiles;
    } catch {
      compareStatus = "unavailable";
    }
  }

  const decision = decideDashboardRelease({
    force,
    activeRun,
    currentSha,
    baselineSha,
    attemptedSha,
    compareStatus,
    changedFiles,
    compareTruncated,
  });
  if (decision.action === "dispatch") await client.dispatchPublisher();
  emitDecision(decision, currentSha, baselineSha, attemptedSha);
  await appendSummary(env.GITHUB_STEP_SUMMARY, decision, currentSha, baselineSha, attemptedSha);
  return decision;
}

function latestRunSha(runs: readonly DashboardWorkflowRun[]): string | null {
  return runs
    .filter((run) => shaPattern.test(run.headSha))
    .map((run) => ({ ...run, epoch: Date.parse(run.createdAt) }))
    .filter((run) => Number.isFinite(run.epoch))
    .sort((left, right) => right.epoch - left.epoch)[0]?.headSha ?? null;
}

function githubClient(input: {
  readonly apiBase: string;
  readonly repository: string;
  readonly token: string;
  readonly request: typeof fetch;
}) {
  const headers = Object.freeze({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const readJson = async (path: string): Promise<unknown> => {
    const response = await input.request(`${input.apiBase}/repos/${input.repository}${path}`, { headers, method: "GET" });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    if (Buffer.byteLength(text, "utf8") > maximumApiResponseBytes) throw new Error("GitHub API response exceeded the dashboard release bound");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("GitHub API returned invalid JSON");
    }
  };

  return Object.freeze({
    async mainSha(): Promise<string> {
      const ref = exactRecord(await readJson("/git/ref/heads/main"), "Main ref");
      return requireSha(exactRecord(ref.object, "Main ref object").sha, "Current main revision");
    },
    async publisherRuns(): Promise<readonly DashboardWorkflowRun[]> {
      const envelope = exactRecord(
        await readJson(`/actions/workflows/${publisherWorkflow}/runs?branch=main&per_page=100`),
        "Dashboard publisher runs",
      );
      if (!Array.isArray(envelope.workflow_runs) || envelope.workflow_runs.length > 100) {
        throw new Error("Dashboard publisher runs have an invalid envelope");
      }
      return Object.freeze(envelope.workflow_runs.map((entry, index) => {
        const run = exactRecord(entry, `Dashboard publisher run ${index + 1}`);
        return Object.freeze({
          status: boundedText(run.status, 40, `Dashboard publisher run ${index + 1} status`),
          conclusion: run.conclusion === null
            ? null
            : boundedText(run.conclusion, 40, `Dashboard publisher run ${index + 1} conclusion`),
          headSha: requireSha(run.head_sha, `Dashboard publisher run ${index + 1} revision`),
          createdAt: boundedText(run.created_at, 64, `Dashboard publisher run ${index + 1} timestamp`),
        });
      }));
    },
    async compare(base: string, head: string) {
      requireSha(base, "Dashboard comparison base");
      requireSha(head, "Dashboard comparison head");
      const comparison = exactRecord(await readJson(`/compare/${base}...${head}?per_page=100`), "Dashboard comparison");
      if (!["ahead", "identical", "behind", "diverged"].includes(String(comparison.status))) {
        throw new Error("Dashboard comparison status is invalid");
      }
      if (!Array.isArray(comparison.files) || comparison.files.length > maximumComparedFiles) {
        throw new Error("Dashboard comparison files have an invalid envelope");
      }
      return Object.freeze({
        status: comparison.status as "ahead" | "identical" | "behind" | "diverged",
        files: Object.freeze(comparison.files.map((entry, index) => boundedText(
          exactRecord(entry, `Dashboard comparison file ${index + 1}`).filename,
          1024,
          `Dashboard comparison file ${index + 1} path`,
        ))),
      });
    },
    async dispatchPublisher(): Promise<void> {
      const response = await input.request(
        `${input.apiBase}/repos/${input.repository}/actions/workflows/${publisherWorkflow}/dispatches`,
        {
          body: JSON.stringify({ ref: "main" }),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 204) throw new Error(`Dashboard publisher dispatch failed with HTTP ${response.status}`);
    },
  });
}

function emitDecision(
  decision: DashboardReleaseDecision,
  currentSha: string,
  baselineSha: string | null,
  attemptedSha: string | null,
): void {
  const messages: Record<DashboardReleaseDecision["reason"], readonly [string, string]> = {
    manual_force: ["Dashboard release queued", `Manual force queued current main ${currentSha}.`],
    active_run: ["Dashboard release coalesced", "A guarded dashboard publication is already active."],
    missing_baseline: ["Dashboard release queued", `No successful publication baseline exists; queued current main ${currentSha}.`],
    already_current: ["Dashboard already current", `Production already covers current main ${currentSha}.`],
    already_attempted: ["Dashboard revision already attempted", `Guarded publication already attempted current main ${attemptedSha ?? currentSha}; use manual force for an intentional retry.`],
    relevant_changes: ["Dashboard release queued", `Dashboard changes accumulated after ${baselineSha ?? "missing baseline"}; queued ${currentSha}.`],
    no_relevant_changes: ["Dashboard release window empty", "No dashboard-relevant files changed since the latest successful publication."],
    comparison_unavailable: ["Dashboard comparison unavailable", "Automatic publication was skipped; the manual queue remains available."],
    comparison_truncated: ["Dashboard comparison truncated", "Automatic publication was skipped because the file comparison reached its bound."],
    history_not_linear: ["Dashboard history uncertain", "Automatic publication was skipped because the successful baseline is not an ancestor of current main."],
  };
  const [title, message] = messages[decision.reason];
  const noticeReasons: readonly DashboardReleaseDecision["reason"][] = [
    "active_run", "already_current", "already_attempted", "no_relevant_changes",
  ];
  const level = decision.action === "dispatch" || noticeReasons.includes(decision.reason) ? "notice" : "warning";
  console.log(`::${level} title=${title}::${message}`);
}

async function appendSummary(
  path: string | undefined,
  decision: DashboardReleaseDecision,
  currentSha: string,
  baselineSha: string | null,
  attemptedSha: string | null,
): Promise<void> {
  if (!path) return;
  await appendFile(path, [
    "## Dashboard release window",
    "",
    `- contract: \`dashboard-release-window/v${DASHBOARD_RELEASE_WINDOW_CONTRACT_VERSION}\``,
    `- decision: \`${decision.action}\``,
    `- reason: \`${decision.reason}\``,
    `- current main: \`${currentSha}\``,
    `- latest successful publication: ${baselineSha ? `\`${baselineSha}\`` : "none"}`,
    `- latest publication attempt: ${attemptedSha ? `\`${attemptedSha}\`` : "none"}`,
    "",
  ].join("\n"), "utf8");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredEnvironment(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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

function parseBoolean(value: string, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  return value;
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} must contain 1-${maximum} safe characters`);
  }
  return value;
}

function isSafePath(value: string): boolean {
  return value.length >= 1
    && value.length <= 1024
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

if (import.meta.main) await runDashboardReleaseWindow();
