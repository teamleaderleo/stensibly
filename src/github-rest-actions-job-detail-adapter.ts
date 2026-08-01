import { gunzipSync } from "node:zlib";
import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestDelegatedReadAdapter,
  type GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubRestActionsJobDetailAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {}

type JobDetailTool = "fetch_workflow_job_steps" | "fetch_workflow_job_logs";
type ActionsStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "requested"
  | "waiting"
  | "pending";
type ActionsConclusion =
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

interface AdmittedJob {
  id: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  name: string;
  status: ActionsStatus;
  conclusion: ActionsConclusion;
  startedAt: string | null;
  completedAt: string | null;
  steps: readonly Readonly<Record<string, unknown>>[];
}

const apiVersion = "2022-11-28";
const maxMetadataBytes = 256 * 1024;
const maxWireLogBytes = 1024 * 1024;
const maxRetainedLogBytes = 256 * 1024;
const maxSteps = 200;
const maxLogLines = 4_000;
const maxLogLineBytes = 4_096;
const credentialPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
const unsafeLogText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** Native bounded GitHub Actions step metadata and job-log reads. */
export class GitHubRestActionsJobDetailAdapter
  extends GitHubRestDelegatedReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestActionsJobDetailAdapterOptions) {
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
    const metadata = await this.#readJob(admitted, token.token);
    return admitted.tool === "fetch_workflow_job_steps"
      ? Object.freeze({
        result: Object.freeze({
          repositoryFullName: admitted.repositoryFullName,
          jobId: metadata.job.id,
          runId: metadata.job.runId,
          runAttempt: metadata.job.runAttempt,
          headSha: metadata.job.headSha,
          name: metadata.job.name,
          status: metadata.job.status,
          conclusion: metadata.job.conclusion,
          startedAt: metadata.job.startedAt,
          completedAt: metadata.job.completedAt,
          steps: metadata.job.steps,
        }),
        ...(metadata.requestId ? { providerRequestId: metadata.requestId } : {}),
      })
      : this.#readLogs(admitted, metadata.job, token.token, metadata.requestId);
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
      jobId: inputInteger(args.job_id, "workflow job ID", 1, Number.MAX_SAFE_INTEGER),
    });
  }

  async #readJob(
    admitted: AdmittedCall,
    token: string,
  ): Promise<Readonly<{ job: AdmittedJob; requestId?: string }>> {
    const url = jobUrl(this.#apiBaseUrl, admitted.repositoryFullName, admitted.jobId);
    const response = await this.#request(url, {
      method: "GET",
      redirect: "error",
      headers: providerHeaders(token, "application/vnd.github+json"),
    });
    if (response.redirected || (response.url && response.url !== url)) {
      await discard(response);
      throw invalid("GitHub delegated provider redirected the workflow-job request");
    }
    if (response.status !== 200) {
      await discard(response);
      throw reject(
        "github_delegated_provider_http_error",
        `GitHub delegated provider returned HTTP ${response.status}`,
      );
    }
    if (!jsonMediaType(response.headers.get("content-type"))) {
      await discard(response);
      throw invalid("GitHub delegated provider returned an unsupported job content type");
    }
    const payload = await readJson(response, maxMetadataBytes);
    const job = parseJob(payload, admitted, this.#apiBaseUrl);
    const requestId = requestIdentity(response.headers.get("x-github-request-id"));
    return Object.freeze({ job, ...(requestId ? { requestId } : {}) });
  }

  async #readLogs(
    admitted: AdmittedCall,
    job: AdmittedJob,
    token: string,
    metadataRequestId?: string,
  ): Promise<Readonly<{ result: Readonly<Record<string, unknown>>; providerRequestId?: string }>> {
    const endpoint = logsUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.jobId,
    );
    const initial = await this.#request(endpoint, {
      method: "GET",
      redirect: "manual",
      headers: providerHeaders(token, "text/plain"),
    });

    let response = initial;
    if ([301, 302, 303, 307, 308].includes(initial.status)) {
      const downloadUrl = admittedDownloadUrl(initial.headers.get("location"));
      await discard(initial);
      response = await this.#request(downloadUrl, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "text/plain",
          "User-Agent": "stensibly",
        },
      });
      if (response.redirected || (response.url && response.url !== downloadUrl)) {
        await discard(response);
        throw invalid("GitHub delegated log download redirected unexpectedly");
      }
    } else if (initial.status !== 200) {
      await discard(initial);
      throw reject(
        "github_delegated_provider_http_error",
        `GitHub delegated provider returned HTTP ${initial.status}`,
      );
    }

    if (response.status !== 200) {
      await discard(response);
      throw reject(
        "github_delegated_provider_http_error",
        `GitHub delegated provider returned HTTP ${response.status}`,
      );
    }
    if (!logMediaType(response.headers.get("content-type"))) {
      await discard(response);
      throw invalid("GitHub delegated provider returned an unsupported log content type");
    }
    validateContentDisposition(response.headers.get("content-disposition"));
    const wire = await readBytes(response, maxWireLogBytes);
    const decodedBytes = decodeContentEncoding(
      wire,
      response.headers.get("content-encoding"),
    );
    if (decodedBytes.byteLength > maxRetainedLogBytes) {
      throw tooLarge(
        `GitHub delegated job log exceeds ${maxRetainedLogBytes} retained bytes`,
      );
    }
    const content = admitLogText(decodedBytes);
    const providerRequestId = requestIdentity(
      response.headers.get("x-github-request-id"),
    ) ?? metadataRequestId;
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      jobId: admitted.jobId,
      runId: job.runId,
      runAttempt: job.runAttempt,
      headSha: job.headSha,
      byteLength: Buffer.byteLength(content, "utf8"),
      lineCount: logLineCount(content),
      truncated: false,
      content,
    });
    return Object.freeze({
      result,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch {
      throw reject(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }
  }
}

function parseJob(
  value: unknown,
  admitted: AdmittedCall,
  base: string,
): AdmittedJob {
  const job = jsonRecord(value, "GitHub Actions workflow job");
  const id = integer(job.id, "workflow job ID", 1, Number.MAX_SAFE_INTEGER);
  if (id !== admitted.jobId) {
    throw identityMismatch("GitHub Actions workflow job did not match the requested job");
  }
  verifyJobUrl(job.url, base, admitted.repositoryFullName, admitted.jobId);
  const startedAt = nullableTimestamp(job.started_at, "workflow-job start time");
  const completedAt = nullableTimestamp(job.completed_at, "workflow-job completion time");
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalid("GitHub Actions workflow-job timestamps were inconsistent");
  }

  const steps = denseArray(job.steps, "workflow job steps", maxSteps)
    .map(parseStep);
  let priorNumber = 0;
  for (const step of steps) {
    const number = step.number as number;
    if (number <= priorNumber) {
      throw invalid("GitHub Actions workflow-job steps were not strictly ordered");
    }
    priorNumber = number;
  }

  return Object.freeze({
    id,
    runId: integer(job.run_id, "workflow job run ID", 1, Number.MAX_SAFE_INTEGER),
    runAttempt: integer(
      job.run_attempt,
      "workflow job run attempt",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    headSha: providerCommitSha(job.head_sha, "workflow-job head SHA"),
    name: text(job.name, "workflow job name", 256),
    status: status(job.status),
    conclusion: conclusion(job.conclusion),
    startedAt,
    completedAt,
    steps: Object.freeze(steps),
  });
}

function parseStep(value: unknown): Readonly<Record<string, unknown>> {
  const step = jsonRecord(value, "GitHub Actions workflow step");
  const startedAt = nullableTimestamp(step.started_at, "workflow-step start time");
  const completedAt = nullableTimestamp(step.completed_at, "workflow-step completion time");
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalid("GitHub Actions workflow-step timestamps were inconsistent");
  }
  return Object.freeze({
    number: integer(step.number, "workflow step number", 1, maxSteps),
    name: text(step.name, "workflow step name", 256),
    status: status(step.status),
    conclusion: conclusion(step.conclusion),
    startedAt,
    completedAt,
  });
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const bytes = await readBytes(response, maximum);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("GitHub delegated provider response was not valid UTF-8");
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw invalid("GitHub delegated provider returned invalid JSON");
  }
}

async function readBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await discard(response);
      throw invalid("GitHub delegated provider response length was invalid");
    }
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maximum) {
      await discard(response);
      throw tooLarge(`GitHub delegated provider response exceeds ${maximum} bytes`);
    }
  }
  if (!response.body) {
    throw invalid("GitHub delegated provider returned an empty response");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw responseFailure();
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
      if (total > maximum) {
        priorFailure = true;
        try { await reader.cancel(); } catch {}
        throw tooLarge(`GitHub delegated provider response exceeds ${maximum} bytes`);
      }
      chunks.push(item.value.slice());
    }
  } catch (error) {
    priorFailure = true;
    if (error instanceof GitHubProviderRejectedError) throw error;
    throw responseFailure();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      if (!priorFailure) throw responseFailure();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeContentEncoding(bytes: Uint8Array, value: string | null): Uint8Array {
  if (value === null || value === "" || value.toLowerCase() === "identity") {
    return bytes;
  }
  if (value.toLowerCase() !== "gzip") {
    throw invalid("GitHub delegated provider returned unsupported log compression");
  }
  try {
    return Uint8Array.from(gunzipSync(bytes));
  } catch {
    throw invalid("GitHub delegated provider returned malformed compressed logs");
  }
}

function admitLogText(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("GitHub delegated job log was not valid UTF-8");
  }
  value = value.replace(/\r\n/g, "\n");
  if (value.includes("\r")) {
    throw invalid("GitHub delegated job log used unsupported line endings");
  }
  if (unsafeLogText.test(value)) {
    throw invalid("GitHub delegated job log contained unsafe control text");
  }
  if (credentialPattern.test(value)) {
    throw invalid("GitHub delegated job log contained credential-shaped content");
  }
  const lines = value.split("\n");
  const count = logLineCount(value);
  if (count > maxLogLines) {
    throw tooLarge(`GitHub delegated job log exceeds ${maxLogLines} lines`);
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > maxLogLineBytes) {
      throw tooLarge(
        `GitHub delegated job log line exceeds ${maxLogLineBytes} bytes`,
      );
    }
  }
  return value;
}

function logLineCount(value: string): number {
  if (!value) return 0;
  const parts = value.split("\n");
  return value.endsWith("\n") ? parts.length - 1 : parts.length;
}

function admittedDownloadUrl(value: string | null): string {
  if (
    value === null
    || !value
    || value.length > 8_192
    || credentialPattern.test(value)
  ) {
    throw invalid("GitHub delegated provider log redirect was invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("GitHub delegated provider log redirect was invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw invalid("GitHub delegated provider log redirect was invalid");
  }
  return parsed.toString();
}

function validateContentDisposition(value: string | null): void {
  if (value === null) return;
  if (!value || value.length > 512 || /[\r\n]/u.test(value)) {
    throw invalid("GitHub delegated provider log filename was invalid");
  }
  const match = /^attachment;\s*filename="?([^";]+)"?$/iu.exec(value);
  if (!match) {
    throw invalid("GitHub delegated provider log filename was invalid");
  }
  const filename = match[1]!;
  if (
    !filename
    || filename.length > 255
    || filename.includes("/")
    || filename.includes("\\")
    || filename === "."
    || filename === ".."
    || filename.includes("..")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(filename)
  ) {
    throw invalid("GitHub delegated provider log filename escaped its archive boundary");
  }
}

function providerHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "stensibly",
    "X-GitHub-Api-Version": apiVersion,
  };
}

function jobUrl(base: string, repo: string, jobId: number): string {
  const [owner, name] = repo.split("/");
  return `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/actions/jobs/${jobId}`;
}

function logsUrl(base: string, repo: string, jobId: number): string {
  return `${jobUrl(base, repo, jobId)}/logs`;
}

function verifyJobUrl(
  value: unknown,
  base: string,
  repositoryFullName: string,
  jobId: number,
): void {
  if (typeof value !== "string") {
    throw identityMismatch("GitHub Actions workflow job lacked repository identity evidence");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw identityMismatch("GitHub Actions workflow job identity URL was invalid");
  }
  const expected = new URL(jobUrl(base, repositoryFullName, jobId));
  if (
    parsed.protocol !== expected.protocol
    || parsed.host !== expected.host
    || parsed.pathname.toLowerCase() !== expected.pathname.toLowerCase()
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw identityMismatch(
      "GitHub Actions workflow job did not match the accepted repository",
    );
  }
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
  if (Object.getOwnPropertySymbols(value).length) {
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
  if (Object.getOwnPropertySymbols(value).length) {
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
    || Object.getOwnPropertySymbols(value).length
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

function providerCommitSha(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-fA-F]{40}$/.test(value)
    || value !== value.trim()
  ) {
    throw invalid(`GitHub Actions ${label} was invalid`);
  }
  return value.toLowerCase();
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

function status(value: unknown): ActionsStatus {
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

function conclusion(value: unknown): ActionsConclusion {
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

function jsonMediaType(value: string | null): boolean {
  return value !== null
    && /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/iu.test(value);
}

function logMediaType(value: string | null): boolean {
  return value !== null
    && /^(?:text\/plain|application\/octet-stream)(?:\s*;.*)?$/iu.test(value);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

function adapterInvalid(message: string): GitHubProviderRejectedError {
  return reject("github_delegated_adapter_invalid_input", message);
}

function invalid(message: string): GitHubProviderRejectedError {
  return reject("github_delegated_provider_invalid_response", message);
}

function identityMismatch(message: string): GitHubProviderRejectedError {
  return reject("github_delegated_provider_identity_mismatch", message);
}

function tooLarge(message: string): GitHubProviderRejectedError {
  return reject("github_delegated_provider_result_too_large", message);
}

function responseFailure(): GitHubProviderRejectedError {
  return reject(
    "github_delegated_provider_response_failed",
    "GitHub delegated provider response could not be read",
  );
}

function reject(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
