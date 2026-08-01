import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestActionsRunAdapter,
} from "./github-rest-actions-run-adapter.js";
import type {
  GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { parseStrictJson } from "./strict-json.js";

export interface GitHubRestActionsJobDetailAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {
  maximumLogBytes?: number;
}

type JobDetailTool =
  | "fetch_workflow_job_steps"
  | "fetch_workflow_job_logs";
type RunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "requested"
  | "waiting"
  | "pending";
type Conclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out"
  | null;

interface AdmittedCall {
  tool: JobDetailTool;
  repositoryFullName: string;
  jobId: number;
}

interface JobIdentity {
  jobId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  name: string;
  status: RunStatus;
  conclusion: Conclusion;
  startedAt: string | null;
  completedAt: string | null;
}

interface JobStep {
  number: number;
  name: string;
  status: RunStatus;
  conclusion: Conclusion;
  startedAt: string | null;
  completedAt: string | null;
}

interface JobObservation {
  identity: Readonly<JobIdentity>;
  steps: readonly Readonly<JobStep>[];
  requestId: string;
}

const apiVersion = "2022-11-28";
const maxJobResponseBytes = 256 * 1024;
const defaultMaximumLogBytes = 128 * 1024;
const maxSteps = 256;
const maxLogLines = 4_000;
const maxLogLineBytes = 4_096;
const credentialPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

/** Native bounded GitHub Actions job-step and text-log reads. */
export class GitHubRestActionsJobDetailAdapter
  extends GitHubRestActionsRunAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maximumLogBytes: number;

  constructor(options: GitHubRestActionsJobDetailAdapterOptions) {
    super(options);
    this.#connectionId = identity(options.connectionId, "connection", 240);
    this.#installationId = identity(options.installationId, "installation", 64);
    this.#credentialRef = credentialReference(options.credentialRef);
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? "https://api.github.com");
    this.#fetch = options.fetch ?? globalThis.fetch;
    const maximumLogBytes = options.maximumLogBytes
      ?? defaultMaximumLogBytes;
    if (
      !Number.isSafeInteger(maximumLogBytes)
      || maximumLogBytes < 1
      || maximumLogBytes > defaultMaximumLogBytes
    ) {
      throw new RangeError(
        "GitHub Actions maximum log bytes must be between 1 and 131072",
      );
    }
    this.#maximumLogBytes = maximumLogBytes;
  }

  override async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = exactRecord(input, [
      "tool",
      "arguments",
      "repositoryFullName",
      "connectionId",
      "installationId",
      "credentialRef",
      "catalogueFingerprint",
    ], "GitHub delegated adapter call");
    if (
      envelope.tool !== "fetch_workflow_job_steps"
      && envelope.tool !== "fetch_workflow_job_logs"
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
    const job = await this.#readJob(admitted, token.token);
    if (admitted.tool === "fetch_workflow_job_steps") {
      const result = Object.freeze({
        repositoryFullName: admitted.repositoryFullName,
        jobId: job.identity.jobId,
        runId: job.identity.runId,
        runAttempt: job.identity.runAttempt,
        headSha: job.identity.headSha,
        name: job.identity.name,
        status: job.identity.status,
        conclusion: job.identity.conclusion,
        startedAt: job.identity.startedAt,
        completedAt: job.identity.completedAt,
        totalCount: job.steps.length,
        steps: job.steps,
      });
      return Object.freeze({
        result,
        providerRequestId: job.requestId,
      });
    }

    const logs = await this.#readLogs(admitted, token.token);
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      jobId: job.identity.jobId,
      runId: job.identity.runId,
      runAttempt: job.identity.runAttempt,
      headSha: job.identity.headSha,
      byteCount: logs.byteCount,
      lineCount: logs.lineCount,
      text: logs.text,
    });
    return Object.freeze({
      result,
      providerRequestId: logs.requestId,
    });
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
    const args = exactRecord(
      envelope.arguments,
      ["job_id"],
      `GitHub delegated ${String(envelope.tool)} arguments`,
    );
    return Object.freeze({
      tool: envelope.tool as JobDetailTool,
      repositoryFullName: inputRepository(envelope.repositoryFullName),
      jobId: inputInteger(
        args.job_id,
        "workflow job ID",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    });
  }

  async #readJob(
    admitted: AdmittedCall,
    token: string,
  ): Promise<JobObservation> {
    const url = jobUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.jobId,
    );
    const response = await this.#providerFetch(url, token, "error");
    if (response.redirected || (response.url && response.url !== url)) {
      await discard(response);
      throw invalid("GitHub delegated provider redirected the workflow-job request");
    }
    if (response.status !== 200) {
      await discard(response);
      throw providerHttp(response.status);
    }
    requireJsonContentType(response.headers.get("content-type"));
    const requestId = requiredRequestIdentity(
      response.headers.get("x-github-request-id"),
      "workflow-job",
    );
    const payload = await readStrictJson(response, maxJobResponseBytes);
    const record = jsonRecord(payload, "GitHub Actions workflow job");
    const identityValue = parseJobIdentity(
      record,
      admitted,
      this.#apiBaseUrl,
    );
    const steps = parseSteps(record.steps);
    return Object.freeze({
      identity: identityValue,
      steps,
      requestId,
    });
  }

  async #readLogs(
    admitted: AdmittedCall,
    token: string,
  ): Promise<Readonly<{
    byteCount: number;
    lineCount: number;
    text: string;
    requestId: string;
  }>> {
    const url = logUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.jobId,
    );
    const redirect = await this.#providerFetch(url, token, "manual");
    if (redirect.redirected || (redirect.url && redirect.url !== url)) {
      await discard(redirect);
      throw invalid("GitHub delegated provider redirected the log request implicitly");
    }
    if (redirect.status !== 302) {
      await discard(redirect);
      throw providerHttp(redirect.status);
    }
    const requestId = requiredRequestIdentity(
      redirect.headers.get("x-github-request-id"),
      "workflow-job log",
    );
    const location = admittedLogLocation(redirect.headers.get("location"));
    await discard(redirect);

    let response: Response;
    try {
      response = await this.#fetch(location, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "text/plain",
          "User-Agent": "stensibly",
        },
      });
    } catch {
      throw reject(
        "github_delegated_provider_request_failed",
        "GitHub delegated log request failed before a response was available",
      );
    }
    if (
      response.redirected
      || (response.url && response.url !== location)
    ) {
      await discard(response);
      throw invalid("GitHub delegated log download escaped its admitted redirect");
    }
    if (response.status !== 200) {
      await discard(response);
      throw providerHttp(response.status);
    }
    requireTextContentType(response.headers.get("content-type"));
    requireIdentityEncoding(response.headers.get("content-encoding"));
    requireSafeDisposition(response.headers.get("content-disposition"));
    const bytes = await readBoundedBytes(response, this.#maximumLogBytes);
    const decoded = decodeUtf8(bytes);
    const text = admitLogText(decoded);
    const lines = text === "" ? [] : text.split("\n");
    if (lines.length > maxLogLines) {
      throw tooLarge(`GitHub Actions log exceeds ${maxLogLines} lines`);
    }
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > maxLogLineBytes) {
        throw tooLarge(
          `GitHub Actions log line exceeds ${maxLogLineBytes} UTF-8 bytes`,
        );
      }
      if (credentialPattern.test(line)) {
        throw invalid("GitHub Actions log contained credential-shaped content");
      }
    }
    return Object.freeze({
      byteCount: Buffer.byteLength(text, "utf8"),
      lineCount: lines.length,
      text,
      requestId,
    });
  }

  async #providerFetch(
    url: string,
    token: string,
    redirect: RequestRedirect,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect,
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
    return response;
  }
}

function parseJobIdentity(
  job: Record<string, unknown>,
  admitted: AdmittedCall,
  base: string,
): Readonly<JobIdentity> {
  const jobId = integer(job.id, "workflow job ID", 1, Number.MAX_SAFE_INTEGER);
  if (jobId !== admitted.jobId) {
    throw identityMismatch(
      "GitHub Actions workflow job did not match the requested job",
    );
  }
  const runId = integer(
    job.run_id,
    "workflow job run ID",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  verifyApiUrl(
    job.url,
    base,
    admitted.repositoryFullName,
    `/actions/jobs/${jobId}`,
    "workflow job",
  );
  verifyApiUrl(
    job.run_url,
    base,
    admitted.repositoryFullName,
    `/actions/runs/${runId}`,
    "workflow run",
  );
  const startedAt = nullableTimestamp(job.started_at, "workflow-job start time");
  const completedAt = nullableTimestamp(
    job.completed_at,
    "workflow-job completion time",
  );
  if (
    startedAt
    && completedAt
    && Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw invalid("GitHub Actions workflow-job timestamps were inconsistent");
  }
  return Object.freeze({
    jobId,
    runId,
    runAttempt: integer(
      job.run_attempt,
      "workflow job run attempt",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    headSha: providerCommitSha(job.head_sha),
    name: text(job.name, "workflow job name", 256),
    status: status(job.status),
    conclusion: conclusion(job.conclusion),
    startedAt,
    completedAt,
  });
}

function parseSteps(value: unknown): readonly Readonly<JobStep>[] {
  const source = denseArray(value, "GitHub Actions workflow steps", maxSteps);
  const numbers = new Set<number>();
  let prior = 0;
  const steps = source.map((entry) => {
    const step = jsonRecord(entry, "GitHub Actions workflow step");
    const number = integer(step.number, "workflow step number", 1, maxSteps);
    if (numbers.has(number) || number <= prior) {
      throw invalid("GitHub Actions workflow steps were not uniquely ordered");
    }
    numbers.add(number);
    prior = number;
    const startedAt = nullableTimestamp(step.started_at, "workflow-step start time");
    const completedAt = nullableTimestamp(
      step.completed_at,
      "workflow-step completion time",
    );
    if (
      startedAt
      && completedAt
      && Date.parse(completedAt) < Date.parse(startedAt)
    ) {
      throw invalid("GitHub Actions workflow-step timestamps were inconsistent");
    }
    return Object.freeze({
      number,
      name: text(step.name, "workflow step name", 256),
      status: status(step.status),
      conclusion: conclusion(step.conclusion),
      startedAt,
      completedAt,
    });
  });
  return Object.freeze(steps);
}

async function readStrictJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maximumBytes);
  const decoded = decodeUtf8(bytes);
  try {
    return parseStrictJson(decoded, {
      maxBytes: maximumBytes,
      maxDepth: 16,
      maxStringLength: 4_096,
      maxObjectKeys: 256,
      maxArrayLength: maxSteps,
      prefix: "GITHUB_ACTIONS_JOB_JSON",
    });
  } catch {
    throw invalid("GitHub delegated provider returned invalid JSON");
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await discard(response);
      throw invalid("GitHub delegated provider response length was invalid");
    }
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maximumBytes) {
      await discard(response);
      throw tooLarge(
        `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
      );
    }
  }
  if (!response.body) {
    throw invalid("GitHub delegated provider returned an empty response");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw responseFailed();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let priorFailure = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        priorFailure = true;
        try { await reader.cancel(); } catch {}
        throw invalid("GitHub delegated provider returned a non-byte response chunk");
      }
      total += item.value.byteLength;
      if (total > maximumBytes) {
        priorFailure = true;
        try { await reader.cancel(); } catch {}
        throw tooLarge(
          `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(item.value.slice());
    }
  } catch (error) {
    priorFailure = true;
    if (error instanceof GitHubProviderRejectedError) throw error;
    throw responseFailed();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      if (!priorFailure) throw responseFailed();
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("GitHub delegated provider response was not valid UTF-8");
  }
}

function admitLogText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  if (
    normalized.includes("\r")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw invalid("GitHub Actions log contained unsafe control text");
  }
  return normalized;
}

function requireJsonContentType(value: string | null): void {
  if (!value || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;.*)?$/i.test(value)) {
    throw invalid("GitHub delegated provider returned an unsupported content type");
  }
}

function requireTextContentType(value: string | null): void {
  if (!value) {
    throw invalid("GitHub delegated log response lacked a content type");
  }
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "text/plain") {
    throw invalid("GitHub delegated log response was not plain text");
  }
  for (const parameter of parts.slice(1)) {
    if (parameter !== "charset=utf-8" && parameter !== "charset=\"utf-8\"") {
      throw invalid("GitHub delegated log response charset was unsupported");
    }
  }
}

function requireIdentityEncoding(value: string | null): void {
  if (value !== null && value.trim().toLowerCase() !== "identity") {
    throw invalid("GitHub delegated log response used unsupported compression");
  }
}

function requireSafeDisposition(value: string | null): void {
  if (value === null) return;
  if (
    value.length > 512
    || /[\r\n]/.test(value)
    || /(?:^|[;=])\s*[^;]*[\\/]/.test(value)
    || value.includes("..")
  ) {
    throw invalid("GitHub delegated log response disposition was unsafe");
  }
}

function admittedLogLocation(value: string | null): string {
  if (!value || value.length > 8_192 || /[\r\n]/.test(value)) {
    throw invalid("GitHub delegated log redirect was invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("GitHub delegated log redirect was invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "results-receiver.actions.githubusercontent.com"
    || host.endsWith(".actions.githubusercontent.com")
    || host.endsWith(".blob.core.windows.net")
    || host.endsWith(".githubusercontent.com");
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.port
    || !allowed
  ) {
    throw invalid("GitHub delegated log redirect escaped the accepted provider");
  }
  return parsed.toString();
}

function verifyApiUrl(
  value: unknown,
  base: string,
  repositoryFullName: string,
  suffix: string,
  label: string,
): void {
  if (typeof value !== "string") {
    throw invalid(`GitHub Actions ${label} URL was invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`GitHub Actions ${label} URL was invalid`);
  }
  const root = new URL(base);
  const [owner, repo] = repositoryFullName.split("/");
  const expected = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}${suffix}`;
  if (
    parsed.protocol !== root.protocol
    || parsed.host !== root.host
    || parsed.pathname.toLowerCase() !== expected.toLowerCase()
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw identityMismatch(
      `GitHub Actions ${label} did not match the accepted repository`,
    );
  }
}

function jobUrl(base: string, repo: string, jobId: number): string {
  const [owner, name] = repo.split("/");
  return `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/jobs/${jobId}`;
}

function logUrl(base: string, repo: string, jobId: number): string {
  return `${jobUrl(base, repo, jobId)}/logs`;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterInvalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw adapterInvalid(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw adapterInvalid(`${label} contains symbol decoration`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw adapterInvalid(`${label} fields are invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw adapterInvalid(`${label} field ${field} must be enumerable data`);
    }
    output[field] = descriptor.value;
  }
  return output;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} was invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label} was invalid`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid(`${label} was invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalid(`${label} was invalid`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw invalid(`${label} was invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw invalid(`${label} was invalid`);
    }
  }
  return value;
}

function inputRepository(value: unknown): string {
  if (typeof value !== "string") {
    throw adapterInvalid("GitHub delegated repository binding is invalid");
  }
  try {
    return normalizeGitHubRepository(value);
  } catch {
    throw adapterInvalid("GitHub delegated repository binding is invalid");
  }
}

function providerCommitSha(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-fA-F]{40}$/.test(value)
    || value !== value.trim()
  ) {
    throw invalid("GitHub Actions workflow-job head SHA was invalid");
  }
  return value.toLowerCase();
}

function inputInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw adapterInvalid(`GitHub delegated ${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw invalid(`GitHub Actions ${label} was invalid`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || credentialPattern.test(value)
  ) {
    throw invalid(`GitHub Actions ${label} was invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  ) {
    return new Date(value).toISOString();
  }
  if (
    typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value
  ) {
    return value;
  }
  throw invalid(`GitHub Actions ${label} was invalid`);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function status(value: unknown): RunStatus {
  if (
    value !== "queued"
    && value !== "in_progress"
    && value !== "completed"
    && value !== "requested"
    && value !== "waiting"
    && value !== "pending"
  ) {
    throw invalid("GitHub Actions status was invalid");
  }
  return value;
}

function conclusion(value: unknown): Conclusion {
  if (
    value === null
    || value === "action_required"
    || value === "cancelled"
    || value === "failure"
    || value === "neutral"
    || value === "skipped"
    || value === "stale"
    || value === "startup_failure"
    || value === "success"
    || value === "timed_out"
  ) {
    return value;
  }
  throw invalid("GitHub Actions conclusion was invalid");
}

function identity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[A-Za-z0-9._:/@-]+$/.test(value)
  ) {
    throw new RangeError(`GitHub Actions ${label} identity is invalid`);
  }
  return value;
}

function credentialReference(value: unknown): string {
  return identity(value, "credential reference", 512);
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw adapterInvalid("GitHub delegated catalogue fingerprint is invalid");
  }
  return value;
}

function apiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError("GitHub Actions API base URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new RangeError("GitHub Actions API base URL is invalid");
  }
  return parsed.origin;
}

function requestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (
    !value
    || value.length > 240
    || !/^[A-Za-z0-9._:-]+$/.test(value)
    || credentialPattern.test(value)
  ) {
    throw invalid("GitHub delegated provider request identity was invalid");
  }
  return value;
}

function requiredRequestIdentity(
  value: string | null,
  label: string,
): string {
  const admitted = requestIdentity(value);
  if (admitted === undefined) {
    throw invalid(
      `GitHub delegated provider ${label} request identity was missing`,
    );
  }
  return admitted;
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

function adapterInvalid(message: string) {
  return reject("github_delegated_adapter_invalid_input", message);
}

function invalid(message: string) {
  return reject("github_delegated_provider_invalid_response", message);
}

function identityMismatch(message: string) {
  return reject("github_delegated_provider_identity_mismatch", message);
}

function tooLarge(message: string) {
  return reject("github_delegated_provider_result_too_large", message);
}

function responseFailed() {
  return reject(
    "github_delegated_provider_response_failed",
    "GitHub delegated provider response failed before bounded admission completed",
  );
}

function providerHttp(statusCode: number) {
  return reject(
    "github_delegated_provider_http_error",
    `GitHub delegated provider returned HTTP ${statusCode}`,
  );
}

function reject(code: string, message: string) {
  return new GitHubProviderRejectedError(code, message);
}
