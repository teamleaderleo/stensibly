import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestDelegatedReadAdapter,
  type GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubRestActionsRunAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {}

type ActionsTool = "fetch_commit_workflow_runs" | "fetch_workflow_run_jobs";
type RunStatus = "queued" | "in_progress" | "completed" | "requested" | "waiting" | "pending";
type Conclusion = "action_required" | "cancelled" | "failure" | "neutral" | "skipped" | "stale" | "startup_failure" | "success" | "timed_out" | null;

interface AdmittedCall {
  tool: ActionsTool;
  repositoryFullName: string;
  commitSha: string | null;
  runId: number | null;
}

interface ProviderPage {
  payload: unknown;
  requestId?: string;
  nextUrl: string | null;
}

const apiVersion = "2022-11-28";
const runsPageSize = 50;
const jobsPageSize = 100;
const maxPages = 10;
const maxRuns = 200;
const maxJobs = 500;
const maxResponseBytes = 512 * 1024;
const credentialPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

/** Native bounded GitHub Actions run/job metadata reads. */
export class GitHubRestActionsRunAdapter extends GitHubRestDelegatedReadAdapter {
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestActionsRunAdapterOptions) {
    super(options);
    this.#connectionId = identity(options.connectionId, "connection", 240);
    this.#installationId = identity(options.installationId, "installation", 64);
    this.#credentialRef = credentialReference(options.credentialRef);
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? "https://api.github.com");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  override async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = exactRecord(input, [
      "tool", "arguments", "repositoryFullName", "connectionId",
      "installationId", "credentialRef", "catalogueFingerprint",
    ], "GitHub delegated adapter call");
    if (
      envelope.tool !== "fetch_commit_workflow_runs"
      && envelope.tool !== "fetch_workflow_run_jobs"
    ) {
      return super.callReadTool({
        tool: envelope.tool as string,
        arguments: envelope.arguments as Record<string, unknown>,
        repositoryFullName: envelope.repositoryFullName as string,
        connectionId: envelope.connectionId as string,
        installationId: envelope.installationId as string,
        credentialRef: envelope.credentialRef as string,
        catalogueFingerprint: envelope.catalogueFingerprint as string,
      });
    }
    const admitted = this.#admit(envelope);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "actions", access: "read" },
    });
    return admitted.tool === "fetch_commit_workflow_runs"
      ? this.#readRuns(admitted, token.token)
      : this.#readJobs(admitted, token.token);
  }

  #admit(envelope: Record<string, unknown>): AdmittedCall {
    if (
      envelope.connectionId !== this.#connectionId
      || envelope.installationId !== this.#installationId
      || envelope.credentialRef !== this.#credentialRef
    ) {
      throw reject(
        "github_delegated_adapter_binding_mismatch",
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    fingerprint(envelope.catalogueFingerprint);
    const repositoryFullName = inputRepository(envelope.repositoryFullName);
    if (envelope.tool === "fetch_commit_workflow_runs") {
      const args = exactRecord(
        envelope.arguments,
        ["commit_sha"],
        "GitHub delegated fetch_commit_workflow_runs arguments",
      );
      return Object.freeze({
        tool: envelope.tool,
        repositoryFullName,
        commitSha: inputCommitSha(args.commit_sha),
        runId: null,
      });
    }
    const args = exactRecord(
      envelope.arguments,
      ["run_id"],
      "GitHub delegated fetch_workflow_run_jobs arguments",
    );
    return Object.freeze({
      tool: envelope.tool as ActionsTool,
      repositoryFullName,
      commitSha: null,
      runId: inputInteger(args.run_id, "workflow run ID", 1, Number.MAX_SAFE_INTEGER),
    });
  }

  async #readRuns(admitted: AdmittedCall, token: string) {
    const runs: Readonly<Record<string, unknown>>[] = [];
    const ids = new Set<number>();
    let nextUrl: string | null = runsUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.commitSha!,
      1,
    );
    let totalCount: number | null = null;
    let requestId: string | undefined;
    const visited = new Set<string>();
    for (let page = 1; nextUrl !== null; page += 1) {
      if (page > maxPages || visited.has(nextUrl)) throw invalid("GitHub Actions pagination was invalid");
      visited.add(nextUrl);
      const provider = await this.#getPage(nextUrl, token, admitted);
      requestId ??= provider.requestId;
      const body = jsonRecord(provider.payload, "GitHub Actions workflow-runs response");
      const count = integer(body.total_count, "workflow run total count", 0, maxRuns);
      totalCount ??= count;
      if (totalCount !== count) throw invalid("GitHub Actions workflow-run pages disagreed");
      for (const value of denseArray(body.workflow_runs, "GitHub Actions workflow runs", runsPageSize)) {
        const run = parseRun(value, admitted);
        const id = run.id as number;
        if (ids.has(id)) throw invalid("GitHub Actions workflow runs contained a duplicate ID");
        ids.add(id);
        runs.push(run);
        if (runs.length > maxRuns) throw tooLarge(`GitHub Actions result exceeds ${maxRuns} workflow runs`);
      }
      nextUrl = provider.nextUrl;
    }
    if (totalCount === null || runs.length !== totalCount) {
      throw invalid("GitHub Actions workflow-run count was inconsistent");
    }
    return Object.freeze({
      result: Object.freeze({
        repositoryFullName: admitted.repositoryFullName,
        commitSha: admitted.commitSha,
        totalCount,
        workflowRuns: Object.freeze(runs),
      }),
      ...(requestId ? { providerRequestId: requestId } : {}),
    });
  }

  async #readJobs(admitted: AdmittedCall, token: string) {
    const jobs: Readonly<Record<string, unknown>>[] = [];
    const ids = new Set<number>();
    let nextUrl: string | null = jobsUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.runId!,
      1,
    );
    let totalCount: number | null = null;
    let runAttempt: number | null = null;
    let headSha: string | null = null;
    let requestId: string | undefined;
    const visited = new Set<string>();
    for (let page = 1; nextUrl !== null; page += 1) {
      if (page > maxPages || visited.has(nextUrl)) throw invalid("GitHub Actions pagination was invalid");
      visited.add(nextUrl);
      const provider = await this.#getPage(nextUrl, token, admitted);
      requestId ??= provider.requestId;
      const body = jsonRecord(provider.payload, "GitHub Actions workflow-jobs response");
      const count = integer(body.total_count, "workflow job total count", 0, maxJobs);
      totalCount ??= count;
      if (totalCount !== count) throw invalid("GitHub Actions workflow-job pages disagreed");
      for (const value of denseArray(body.jobs, "GitHub Actions workflow jobs", jobsPageSize)) {
        const job = parseJob(value, admitted, this.#apiBaseUrl);
        const id = job.id as number;
        const attempt = job.runAttempt as number;
        const jobHeadSha = job.headSha as string;
        runAttempt ??= attempt;
        headSha ??= jobHeadSha;
        if (runAttempt !== attempt || headSha !== jobHeadSha) {
          throw identityMismatch(
            "GitHub Actions workflow jobs did not share one run attempt and head commit",
          );
        }
        if (ids.has(id)) throw invalid("GitHub Actions workflow jobs contained a duplicate ID");
        ids.add(id);
        jobs.push(job);
        if (jobs.length > maxJobs) throw tooLarge(`GitHub Actions result exceeds ${maxJobs} workflow jobs`);
      }
      nextUrl = provider.nextUrl;
    }
    if (totalCount === null || jobs.length !== totalCount) {
      throw invalid("GitHub Actions workflow-job count was inconsistent");
    }
    return Object.freeze({
      result: Object.freeze({
        repositoryFullName: admitted.repositoryFullName,
        runId: admitted.runId,
        totalCount,
        jobs: Object.freeze(jobs),
      }),
      ...(requestId ? { providerRequestId: requestId } : {}),
    });
  }

  async #getPage(url: string, token: string, admitted: AdmittedCall): Promise<ProviderPage> {
    verifyUrl(url, this.#apiBaseUrl, admitted);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": apiVersion,
        },
      });
    } catch {
      throw reject(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }
    if (response.redirected || (response.url && response.url !== url)) {
      await discard(response);
      throw invalid("GitHub delegated provider redirected the Actions request");
    }
    if (!response.ok) {
      await discard(response);
      throw reject(
        "github_delegated_provider_http_error",
        `GitHub delegated provider returned HTTP ${response.status}`,
      );
    }
    const media = response.headers.get("content-type");
    if (media && !media.toLowerCase().includes("json")) {
      await discard(response);
      throw invalid("GitHub delegated provider returned an unsupported content type");
    }
    return {
      payload: await readJson(response),
      requestId: requestIdentity(response.headers.get("x-github-request-id")),
      nextUrl: nextLink(response.headers.get("link"), this.#apiBaseUrl, admitted),
    };
  }
}

function parseRun(value: unknown, admitted: AdmittedCall): Readonly<Record<string, unknown>> {
  const run = jsonRecord(value, "GitHub Actions workflow run");
  const repo = jsonRecord(run.repository, "GitHub Actions workflow-run repository");
  if (providerRepository(repo.full_name) !== admitted.repositoryFullName) {
    throw identityMismatch("GitHub Actions workflow run did not match the accepted repository");
  }
  if (providerCommitSha(run.head_sha, "workflow-run head SHA") !== admitted.commitSha) {
    throw identityMismatch("GitHub Actions workflow run did not match the requested commit");
  }
  const createdAt = timestamp(run.created_at, "workflow-run creation time");
  const updatedAt = timestamp(run.updated_at, "workflow-run update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalid("GitHub Actions workflow-run timestamps were inconsistent");
  return Object.freeze({
    id: integer(run.id, "workflow run ID", 1, Number.MAX_SAFE_INTEGER),
    attempt: integer(run.run_attempt, "workflow run attempt", 1, Number.MAX_SAFE_INTEGER),
    workflowId: integer(run.workflow_id, "workflow ID", 1, Number.MAX_SAFE_INTEGER),
    workflowName: text(run.name, "workflow name", 256),
    event: text(run.event, "workflow event", 64),
    status: status(run.status),
    conclusion: conclusion(run.conclusion),
    headSha: admitted.commitSha,
    createdAt,
    updatedAt,
    runStartedAt: nullableTimestamp(run.run_started_at, "workflow-run start time"),
  });
}

function parseJob(
  value: unknown,
  admitted: AdmittedCall,
  base: string,
): Readonly<Record<string, unknown>> {
  const job = jsonRecord(value, "GitHub Actions workflow job");
  const runId = integer(job.run_id, "workflow job run ID", 1, Number.MAX_SAFE_INTEGER);
  if (runId !== admitted.runId) throw identityMismatch("GitHub Actions workflow job did not match the requested run");
  verifyJobUrl(job.url, base, admitted.repositoryFullName, job.id);
  const startedAt = nullableTimestamp(job.started_at, "workflow-job start time");
  const completedAt = nullableTimestamp(job.completed_at, "workflow-job completion time");
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalid("GitHub Actions workflow-job timestamps were inconsistent");
  }
  return Object.freeze({
    id: integer(job.id, "workflow job ID", 1, Number.MAX_SAFE_INTEGER),
    runId,
    runAttempt: integer(job.run_attempt, "workflow job run attempt", 1, Number.MAX_SAFE_INTEGER),
    headSha: providerCommitSha(job.head_sha, "workflow-job head SHA"),
    name: text(job.name, "workflow job name", 256),
    status: status(job.status),
    conclusion: conclusion(job.conclusion),
    startedAt,
    completedAt,
    labels: Object.freeze(denseArray(job.labels, "workflow job labels", 32).map((entry) => text(entry, "workflow job label", 128))),
  });
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) {
    await discard(response);
    throw tooLarge(`GitHub delegated provider response exceeds ${maxResponseBytes} bytes`);
  }
  if (!response.body) throw invalid("GitHub delegated provider returned an empty response");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { throw responseFailure(); }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let prior = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        prior = true;
        try { await reader.cancel(); } catch {}
        throw invalid("GitHub delegated provider returned a non-byte response chunk");
      }
      total += item.value.byteLength;
      if (total > maxResponseBytes) {
        prior = true;
        try { await reader.cancel(); } catch {}
        throw tooLarge(`GitHub delegated provider response exceeds ${maxResponseBytes} bytes`);
      }
      chunks.push(item.value.slice());
    }
  } catch (error) {
    prior = true;
    if (error instanceof GitHubProviderRejectedError) throw error;
    throw responseFailure();
  } finally {
    try { reader.releaseLock(); } catch { if (!prior) throw responseFailure(); }
  }
  let decoded: string;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw invalid("GitHub delegated provider response was not valid UTF-8"); }
  try { return JSON.parse(decoded) as unknown; } catch { throw invalid("GitHub delegated provider returned invalid JSON"); }
}

function nextLink(value: string | null, base: string, admitted: AdmittedCall): string | null {
  if (!value) return null;
  if (value.length > 8_192 || credentialPattern.test(value)) throw invalid("GitHub delegated provider pagination header was invalid");
  let next: string | null = null;
  for (const part of value.split(",").map((entry) => entry.trim())) {
    const match = /^<([^>]+)>;\s*rel="([a-z]+)"$/.exec(part);
    if (!match) throw invalid("GitHub delegated provider pagination header was invalid");
    if (match[2] === "next") {
      if (next !== null) throw invalid("GitHub delegated provider pagination repeated next");
      next = match[1]!;
    }
  }
  if (next) verifyUrl(next, base, admitted);
  return next;
}

function verifyUrl(url: string, base: string, admitted: AdmittedCall): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw invalid("GitHub delegated pagination URL was invalid"); }
  const root = new URL(base);
  const [owner, name] = admitted.repositoryFullName.split("/");
  const expected = admitted.tool === "fetch_commit_workflow_runs"
    ? `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/runs`
    : `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/runs/${admitted.runId}/jobs`;
  const page = parsed.searchParams.get("page");
  const expectedSize = admitted.tool === "fetch_commit_workflow_runs" ? runsPageSize : jobsPageSize;
  if (
    parsed.protocol !== root.protocol || parsed.host !== root.host
    || parsed.username || parsed.password || parsed.hash
    || parsed.pathname.toLowerCase() !== expected.toLowerCase()
    || parsed.searchParams.get("per_page") !== String(expectedSize)
    || page === null || !/^\d+$/.test(page) || Number(page) < 1
    || parsed.searchParams.size !== 3
    || (admitted.tool === "fetch_commit_workflow_runs" && parsed.searchParams.get("head_sha") !== admitted.commitSha)
    || (admitted.tool === "fetch_workflow_run_jobs" && parsed.searchParams.get("filter") !== "latest")
  ) throw invalid("GitHub delegated pagination URL escaped the accepted request");
}

function verifyJobUrl(value: unknown, base: string, repositoryFullName: string, jobId: unknown): void {
  if (typeof value !== "string") throw identityMismatch("GitHub Actions workflow job lacked repository identity evidence");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw identityMismatch("GitHub Actions workflow job identity URL was invalid"); }
  const root = new URL(base);
  const [owner, name] = repositoryFullName.split("/");
  const id = integer(jobId, "workflow job ID", 1, Number.MAX_SAFE_INTEGER);
  const expected = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/jobs/${id}`;
  if (parsed.protocol !== root.protocol || parsed.host !== root.host || parsed.pathname.toLowerCase() !== expected.toLowerCase() || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw identityMismatch("GitHub Actions workflow job did not match the accepted repository");
  }
}

function runsUrl(base: string, repo: string, sha: string, page: number): string {
  const [owner, name] = repo.split("/");
  return `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/runs?head_sha=${sha}&per_page=${runsPageSize}&page=${page}`;
}
function jobsUrl(base: string, repo: string, runId: number, page: number): string {
  const [owner, name] = repo.split("/");
  return `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/runs/${runId}/jobs?filter=latest&per_page=${jobsPageSize}&page=${page}`;
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw adapterInvalid(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw adapterInvalid(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length) throw adapterInvalid(`${label} contains symbol decoration`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw adapterInvalid(`${label} fields are invalid`);
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw adapterInvalid(`${label} field ${field} must be enumerable data`);
    output[field] = descriptor.value;
  }
  return output;
}
function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} was invalid`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid(`${label} was invalid`);
  if (Object.getOwnPropertySymbols(value).length) throw invalid(`${label} was invalid`);
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) throw invalid(`${label} was invalid`);
    output[key] = descriptor.value;
  }
  return output;
}
function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length) throw invalid(`${label} was invalid`);
  for (let index = 0; index < value.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value, index)) throw invalid(`${label} was invalid`);
  return value;
}
function inputRepository(value: unknown): string {
  if (typeof value !== "string") throw adapterInvalid("GitHub delegated repository binding is invalid");
  try { return normalizeGitHubRepository(value); } catch { throw adapterInvalid("GitHub delegated repository binding is invalid"); }
}
function providerRepository(value: unknown): string {
  if (typeof value !== "string") throw invalid("GitHub Actions repository identity was invalid");
  try { return normalizeGitHubRepository(value); } catch { throw invalid("GitHub Actions repository identity was invalid"); }
}
function inputCommitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value) || value !== value.trim()) throw adapterInvalid("GitHub delegated commit SHA is invalid");
  return value.toLowerCase();
}
function providerCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value) || value !== value.trim()) throw invalid(`GitHub Actions ${label} was invalid`);
  return value.toLowerCase();
}
function inputInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw adapterInvalid(`GitHub delegated ${label} is invalid`);
  return value;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`GitHub Actions ${label} was invalid`);
  return value;
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || credentialPattern.test(value)) throw invalid(`GitHub Actions ${label} was invalid`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || new Date(value).toISOString() !== value.replace("Z", ".000Z")) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value) return value;
    throw invalid(`GitHub Actions ${label} was invalid`);
  }
  return new Date(value).toISOString();
}
function nullableTimestamp(value: unknown, label: string): string | null { return value === null ? null : timestamp(value, label); }
function status(value: unknown): RunStatus {
  if (value !== "queued" && value !== "in_progress" && value !== "completed" && value !== "requested" && value !== "waiting" && value !== "pending") throw invalid("GitHub Actions status was invalid");
  return value;
}
function conclusion(value: unknown): Conclusion {
  if (value === null || value === "action_required" || value === "cancelled" || value === "failure" || value === "neutral" || value === "skipped" || value === "stale" || value === "startup_failure" || value === "success" || value === "timed_out") return value;
  throw invalid("GitHub Actions conclusion was invalid");
}
function identity(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim() || !/^[A-Za-z0-9._:/@-]+$/.test(value)) throw new RangeError(`GitHub Actions ${label} identity is invalid`);
  return value;
}
function credentialReference(value: unknown): string { return identity(value, "credential reference", 512); }
function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw adapterInvalid("GitHub delegated catalogue fingerprint is invalid");
  return value;
}
function apiBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RangeError("GitHub Actions API base URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) throw new RangeError("GitHub Actions API base URL is invalid");
  return parsed.origin;
}
function requestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!value || value.length > 240 || !/^[A-Za-z0-9._:-]+$/.test(value) || credentialPattern.test(value)) throw invalid("GitHub delegated provider request identity was invalid");
  return value;
}
async function discard(response: Response): Promise<void> { try { await response.body?.cancel(); } catch {} }
function adapterInvalid(message: string) { return reject("github_delegated_adapter_invalid_input", message); }
function invalid(message: string) { return reject("github_delegated_provider_invalid_response", message); }
function identityMismatch(message: string) { return reject("github_delegated_provider_identity_mismatch", message); }
function tooLarge(message: string) { return reject("github_delegated_provider_result_too_large", message); }
function responseFailure() { return reject("github_delegated_provider_response_failed", "GitHub delegated provider response failed before bounded admission completed"); }
function reject(code: string, message: string) { return new GitHubProviderRejectedError(code, message); }
