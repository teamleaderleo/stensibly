import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestDelegatedReadAdapter,
  type GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { parseStrictJson } from "./strict-json.js";

export interface GitHubRestCommitStatusAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {}

type StatusState = "error" | "failure" | "pending" | "success";

interface AdmittedCall {
  repositoryFullName: string;
  commitSha: string;
}

interface AdmittedStatus {
  id: number;
  state: StatusState;
  context: string;
  description: string | null;
  targetUrlPresent: boolean;
  creatorLogin: string;
  creatorId: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderPage {
  payload: unknown;
  nextUrl: string | null;
  requestId?: string;
}

const apiVersion = "2022-11-28";
const pageSize = 100;
const maxPages = 10;
const maxStatuses = 500;
const maxResponseBytes = 256 * 1024;
const credentialPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

/** Native exact-SHA combined-status read behind the delegated read contract. */
export class GitHubRestCommitStatusAdapter extends GitHubRestDelegatedReadAdapter {
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestCommitStatusAdapterOptions) {
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
    const envelope = exactRecord(
      input,
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      "GitHub delegated adapter call",
    );
    if (envelope.tool !== "get_commit_combined_status") {
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
      permission: { name: "statuses", access: "read" },
    });
    return this.#readAll(admitted, token.token);
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
      ["commit_sha"],
      "GitHub delegated get_commit_combined_status arguments",
    );
    return Object.freeze({
      repositoryFullName: inputRepository(envelope.repositoryFullName),
      commitSha: inputCommitSha(args.commit_sha),
    });
  }

  async #readAll(
    admitted: AdmittedCall,
    token: string,
  ): Promise<Readonly<{
    result: Readonly<Record<string, unknown>>;
    providerRequestId?: string;
  }>> {
    let nextUrl: string | null = pageUrl(
      this.#apiBaseUrl,
      admitted.repositoryFullName,
      admitted.commitSha,
      1,
    );
    const visited = new Set<string>();
    const contexts = new Set<string>();
    const statuses: AdmittedStatus[] = [];
    let state: StatusState | null = null;
    let totalCount: number | null = null;
    let requestId: string | undefined;

    for (let page = 1; nextUrl !== null; page += 1) {
      if (page > maxPages || visited.has(nextUrl)) {
        throw invalid("GitHub delegated provider pagination was invalid");
      }
      visited.add(nextUrl);
      const provider = await this.#getPage(nextUrl, token, admitted);
      requestId ??= provider.requestId;
      const parsed = parsePage(provider.payload, admitted);
      state ??= parsed.state;
      totalCount ??= parsed.totalCount;
      if (state !== parsed.state || totalCount !== parsed.totalCount) {
        throw invalid("GitHub delegated combined status pages disagreed");
      }
      for (const status of parsed.statuses) {
        const key = status.context.toLowerCase();
        if (contexts.has(key)) {
          throw invalid("GitHub delegated combined status contained a duplicate context");
        }
        contexts.add(key);
        statuses.push(status);
        if (statuses.length > maxStatuses) {
          throw tooLarge(`GitHub delegated combined status exceeds ${maxStatuses} entries`);
        }
      }
      nextUrl = provider.nextUrl;
    }

    if (state === null || totalCount === null || statuses.length !== totalCount) {
      throw invalid("GitHub delegated combined status count was inconsistent");
    }
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      commitSha: admitted.commitSha,
      state,
      totalCount,
      statuses: Object.freeze(statuses.map((status) => Object.freeze({ ...status }))),
    });
    return Object.freeze({
      result,
      ...(requestId ? { providerRequestId: requestId } : {}),
    });
  }

  async #getPage(
    url: string,
    token: string,
    admitted: AdmittedCall,
  ): Promise<ProviderPage> {
    verifyPageUrl(url, this.#apiBaseUrl, admitted);
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

    if (response.redirected || response.url !== url) {
      await discard(response);
      throw invalid("GitHub delegated provider redirected the commit-status request");
    }
    if (response.status !== 200) {
      await discard(response);
      throw reject(
        "github_delegated_provider_http_error",
        `GitHub delegated provider returned HTTP ${response.status}`,
      );
    }
    if (!isJsonMediaType(response.headers.get("content-type"))) {
      await discard(response);
      throw invalid("GitHub delegated provider returned an unsupported content type");
    }

    const payload = await readStrictJson(response);
    const requestId = providerRequestIdentity(
      response.headers.get("x-github-request-id"),
    );
    const nextUrl = parseNextLink(
      response.headers.get("link"),
      this.#apiBaseUrl,
      admitted,
    );
    return {
      payload,
      nextUrl,
      ...(requestId ? { requestId } : {}),
    };
  }
}

function parsePage(
  value: unknown,
  admitted: AdmittedCall,
): Readonly<{
  state: StatusState;
  totalCount: number;
  statuses: readonly AdmittedStatus[];
}> {
  const page = jsonRecord(value, "GitHub combined status response");
  const providerSha = providerCommitSha(page.sha);
  if (providerSha !== admitted.commitSha) {
    throw identityMismatch(
      "GitHub delegated combined status did not match the requested commit",
    );
  }
  const repo = jsonRecord(page.repository, "GitHub combined status repository");
  const providerRepository = providerRepositoryIdentity(repo.full_name);
  if (providerRepository !== admitted.repositoryFullName) {
    throw identityMismatch(
      "GitHub delegated combined status did not match the accepted repository",
    );
  }
  return Object.freeze({
    state: statusState(page.state),
    totalCount: integer(page.total_count, "total count", 0, maxStatuses),
    statuses: Object.freeze(
      denseArray(page.statuses, "GitHub combined statuses", pageSize)
        .map(parseStatus),
    ),
  });
}

function parseStatus(value: unknown): AdmittedStatus {
  const status = jsonRecord(value, "GitHub commit status");
  const creator = jsonRecord(status.creator, "GitHub commit status creator");
  const createdAt = timestamp(status.created_at, "created timestamp");
  const updatedAt = timestamp(status.updated_at, "updated timestamp");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalid("GitHub commit status timestamps were inconsistent");
  }
  return Object.freeze({
    id: integer(status.id, "status ID", 1, Number.MAX_SAFE_INTEGER),
    state: statusState(status.state),
    context: text(status.context, "status context", 512),
    description: status.description === null
      ? null
      : text(status.description, "status description", 1_024),
    targetUrlPresent: targetUrlPresence(status.target_url),
    creatorLogin: text(creator.login, "creator login", 120),
    creatorId: integer(creator.id, "creator ID", 1, Number.MAX_SAFE_INTEGER),
    createdAt,
    updatedAt,
  });
}

async function readStrictJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await discard(response);
      throw invalid("GitHub delegated provider response length was invalid");
    }
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maxResponseBytes) {
      await discard(response);
      throw tooLarge(`GitHub delegated provider response exceeds ${maxResponseBytes} bytes`);
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
      if (total > maxResponseBytes) {
        priorFailure = true;
        try { await reader.cancel(); } catch {}
        throw tooLarge(`GitHub delegated provider response exceeds ${maxResponseBytes} bytes`);
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

  let decoded: string;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("GitHub delegated provider response was not valid UTF-8");
  }

  try {
    return parseStrictJson(decoded, {
      maxBytes: maxResponseBytes,
      maxDepth: 16,
      maxStringLength: 4_096,
      maxObjectKeys: 128,
      maxArrayLength: pageSize,
      prefix: "GITHUB_STATUS_JSON",
    });
  } catch {
    throw invalid("GitHub delegated provider returned invalid JSON");
  }
}

function parseNextLink(
  value: string | null,
  base: string,
  admitted: AdmittedCall,
): string | null {
  if (value === null) return null;
  if (!value || value.length > 8_192 || credentialPattern.test(value)) {
    throw invalid("GitHub delegated provider pagination header was invalid");
  }
  let next: string | null = null;
  for (const part of value.split(",").map((entry) => entry.trim())) {
    const match = /^<([^>]+)>;\s*rel="([a-z]+)"$/.exec(part);
    if (!match) throw invalid("GitHub delegated provider pagination header was invalid");
    if (match[2] === "next") {
      if (next !== null) {
        throw invalid("GitHub delegated provider pagination repeated next");
      }
      next = match[1]!;
    }
  }
  if (next !== null) verifyPageUrl(next, base, admitted);
  return next;
}

function verifyPageUrl(url: string, base: string, admitted: AdmittedCall): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("GitHub delegated pagination URL was invalid");
  }
  const root = new URL(base);
  const [owner, repo] = admitted.repositoryFullName.split("/");
  const expectedPath = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/commits/${admitted.commitSha}/status`;
  const page = parsed.searchParams.get("page");
  if (
    parsed.protocol !== root.protocol
    || parsed.host !== root.host
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.pathname.toLowerCase() !== expectedPath.toLowerCase()
    || parsed.searchParams.get("per_page") !== String(pageSize)
    || page === null
    || !/^\d+$/.test(page)
    || Number(page) < 1
    || parsed.searchParams.size !== 2
  ) {
    throw invalid("GitHub delegated pagination URL escaped the accepted request");
  }
}

function pageUrl(base: string, repositoryFullName: string, commitSha: string, page: number): string {
  const [owner, name] = repositoryFullName.split("/");
  return `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/commits/${commitSha}/status?per_page=${pageSize}&page=${page}`;
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
    throw adapterInvalid(`${label} contains a symbol field`);
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

function denseArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length > 0
    || value.length > maximum
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
    throw adapterInvalid("GitHub delegated repository identity is invalid");
  }
  try {
    return normalizeGitHubRepository(value);
  } catch {
    throw adapterInvalid("GitHub delegated repository identity is invalid");
  }
}

function providerRepositoryIdentity(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("GitHub combined status repository identity was invalid");
  }
  try {
    return normalizeGitHubRepository(value);
  } catch {
    throw invalid("GitHub combined status repository identity was invalid");
  }
}

function inputCommitSha(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Fa-f0-9]{40}$/.test(value)
    || value !== value.trim()
  ) {
    throw adapterInvalid(
      "GitHub commit SHA must contain exactly 40 hexadecimal characters",
    );
  }
  return value.toLowerCase();
}

function providerCommitSha(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Fa-f0-9]{40}$/.test(value)
    || value !== value.trim()
  ) {
    throw invalid("GitHub combined status commit SHA was invalid");
  }
  return value.toLowerCase();
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw adapterInvalid("GitHub delegated catalogue fingerprint is invalid");
  }
  return value;
}

function identity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[A-Za-z0-9._:@/-]+$/.test(value)
  ) {
    throw new RangeError(`GitHub delegated ${label} ID is invalid`);
  }
  return value;
}

function credentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > 1_024
    || value !== value.trim()
    || !/^(?:env|secret):\/\/[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new RangeError("GitHub delegated credential reference is invalid");
  }
  return value;
}

function apiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new RangeError("GitHub delegated API base URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError("GitHub delegated API base URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new RangeError("GitHub delegated API base URL is invalid");
  }
  return parsed.origin;
}

function statusState(value: unknown): StatusState {
  if (
    value !== "error"
    && value !== "failure"
    && value !== "pending"
    && value !== "success"
  ) {
    throw invalid("GitHub commit status state is invalid");
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || credentialPattern.test(value)
  ) {
    throw invalid(`GitHub commit ${label} is invalid`);
  }
  return value;
}

function targetUrlPresence(value: unknown): boolean {
  if (value === null) return false;
  if (
    typeof value !== "string"
    || value.length > 4_096
    || credentialPattern.test(value)
  ) {
    throw invalid("GitHub commit status target URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("GitHub commit status target URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw invalid("GitHub commit status target URL is invalid");
  }
  return true;
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
    throw invalid(`GitHub commit ${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalid(`GitHub commit status ${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw invalid(`GitHub commit status ${label} is invalid`);
  }
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== value && canonical !== value.replace(/Z$/u, ".000Z")) {
    throw invalid(`GitHub commit status ${label} is invalid`);
  }
  return canonical;
}

function providerRequestIdentity(value: string | null): string | undefined {
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

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  const media = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!media) return false;
  return media === "application/json"
    || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/u.test(media);
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

function responseFailed(): GitHubProviderRejectedError {
  return reject(
    "github_delegated_provider_response_failed",
    "GitHub delegated provider response failed before bounded admission completed",
  );
}

function reject(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
