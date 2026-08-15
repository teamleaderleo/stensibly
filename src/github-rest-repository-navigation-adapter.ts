import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import { admitGitHubDelegatedCallerRecord } from "./github-rest-delegated-caller-admission.js";
import {
  GitHubRestDelegatedReadAdapter,
  type GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { stableJson } from "./canonical-json.js";
import { parseStrictJson } from "./strict-json.js";

export interface GitHubRestRepositoryNavigationAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {
  maximumDirectoryEntries?: number;
}

interface AdmittedNavigationCall {
  tool: "list_directory" | "resolve_ref";
  arguments: Readonly<Record<string, unknown>>;
  repositoryFullName: string;
}

interface ProviderResponse {
  payload: unknown;
  providerRequestId?: string;
}

const githubApiVersion = "2022-11-28";
const defaultMaximumDirectoryEntries = 256;
const maximumDirectoryResponseBytes = 512 * 1024;
const maximumNavigationResultBytes = 224 * 1024;
const maximumTagPeelDepth = 8;
const credentialShapedPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

/**
 * Additive read-only repository navigation for the guarded delegated surface.
 * Mutable ref names are resolved independently; directory reads require an
 * already immutable commit SHA.
 */
export class GitHubRestRepositoryNavigationAdapter
  extends GitHubRestDelegatedReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maximumDirectoryEntries: number;

  constructor(options: GitHubRestRepositoryNavigationAdapterOptions) {
    super(options);
    this.#connectionId = exactIdentity(options.connectionId, "GitHub delegated connection ID", 240);
    this.#installationId = exactIdentity(options.installationId, "GitHub delegated installation ID", 64);
    this.#credentialRef = exactCredentialReference(options.credentialRef);
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(options.apiBaseUrl ?? "https://api.github.com");
    this.#fetch = receiverSafeFetch(options.fetch);
    const maximumDirectoryEntries = options.maximumDirectoryEntries
      ?? defaultMaximumDirectoryEntries;
    if (
      !Number.isSafeInteger(maximumDirectoryEntries)
      || maximumDirectoryEntries < 1
      || maximumDirectoryEntries > defaultMaximumDirectoryEntries
    ) {
      throw new RangeError("GitHub directory entry limit must be between 1 and 256");
    }
    this.#maximumDirectoryEntries = maximumDirectoryEntries;
  }

  override async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = admitGitHubDelegatedCallerRecord(
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
      invalidCaller,
    );
    if (envelope.tool !== "list_directory" && envelope.tool !== "resolve_ref") {
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

    const admitted = this.#admitNavigationCall(envelope);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "contents", access: "read" },
    });
    return admitted.tool === "list_directory"
      ? await this.#listDirectory(admitted, token.token)
      : await this.#resolveRef(admitted, token.token);
  }

  #admitNavigationCall(envelope: Record<string, unknown>): AdmittedNavigationCall {
    if (
      envelope.connectionId !== this.#connectionId
      || envelope.installationId !== this.#installationId
      || envelope.credentialRef !== this.#credentialRef
    ) {
      throw rejected(
        "github_delegated_adapter_binding_mismatch",
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(envelope.repositoryFullName);
    exactFingerprint(envelope.catalogueFingerprint);
    if (envelope.tool === "list_directory") {
      const args = admitGitHubDelegatedCallerRecord(
        envelope.arguments,
        ["path", "ref"],
        ["path", "ref"],
        "GitHub delegated list_directory arguments",
        invalidCaller,
      );
      return Object.freeze({
        tool: "list_directory",
        repositoryFullName,
        arguments: Object.freeze({
          path: directoryPath(args.path),
          ref: commitSha(args.ref),
        }),
      });
    }
    const args = admitGitHubDelegatedCallerRecord(
      envelope.arguments,
      ["ref"],
      ["ref"],
      "GitHub delegated resolve_ref arguments",
      invalidCaller,
    );
    return Object.freeze({
      tool: "resolve_ref",
      repositoryFullName,
      arguments: Object.freeze({ ref: qualifiedGitRef(args.ref) }),
    });
  }

  async #listDirectory(
    admitted: AdmittedNavigationCall,
    token: string,
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const path = admitted.arguments.path as string;
    const ref = admitted.arguments.ref as string;
    const provider = await this.#getJson(
      contentsPath(admitted.repositoryFullName, path, ref),
      token,
      maximumDirectoryResponseBytes,
    );
    if (!Array.isArray(provider.payload)) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated directory response was not an array",
      );
    }
    if (provider.payload.length > this.#maximumDirectoryEntries) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        `GitHub delegated directory exceeds ${this.#maximumDirectoryEntries} entries`,
      );
    }
    const seen = new Set<string>();
    const entries = provider.payload.map((entry) => {
      const parsed = directoryEntry(
        entry,
        path,
        ref,
        admitted.repositoryFullName,
        this.#apiBaseUrl,
      );
      if (seen.has(parsed.path)) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated directory response contained a duplicate path",
        );
      }
      seen.add(parsed.path);
      return parsed;
    }).sort((left, right) => codeUnitCompare(left.path, right.path));
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      path,
      commitSha: ref,
      entries: Object.freeze(entries),
      truncated: false as const,
    });
    if (Buffer.byteLength(stableJson(result), "utf8") > maximumNavigationResultBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        "GitHub delegated directory result exceeds the retained result budget",
      );
    }
    return Object.freeze({
      result,
      ...(provider.providerRequestId ? { providerRequestId: provider.providerRequestId } : {}),
    });
  }

  async #resolveRef(
    admitted: AdmittedNavigationCall,
    token: string,
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const ref = admitted.arguments.ref as string;
    const initial = await this.#getJson(
      gitRefPath(admitted.repositoryFullName, ref),
      token,
      64 * 1024,
    );
    const observed = refObject(initial.payload, admitted.repositoryFullName, ref, this.#apiBaseUrl);
    let objectType = observed.objectType;
    let objectSha = observed.objectSha;
    let providerRequestId = initial.providerRequestId;
    let peeledTagDepth = 0;
    const visited = new Set<string>();

    while (objectType === "tag") {
      if (peeledTagDepth >= maximumTagPeelDepth || visited.has(objectSha)) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated tag resolution exceeded its bounded object chain",
        );
      }
      visited.add(objectSha);
      const tag = await this.#getJson(
        gitTagPath(admitted.repositoryFullName, objectSha),
        token,
        64 * 1024,
      );
      const peeled = tagObject(tag.payload, admitted.repositoryFullName, objectSha, this.#apiBaseUrl);
      objectType = peeled.objectType;
      objectSha = peeled.objectSha;
      providerRequestId = tag.providerRequestId ?? providerRequestId;
      peeledTagDepth += 1;
    }
    if (objectType !== "commit") {
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated ref did not resolve to a commit",
      );
    }
    const refType = ref.startsWith("refs/heads/") ? "branch" as const : "tag" as const;
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      ref,
      refType,
      refObjectSha: observed.objectSha,
      commitSha: objectSha,
      peeledTagDepth,
    });
    return Object.freeze({
      result,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
  }

  async #getJson(
    relativePath: string,
    token: string,
    maximumBytes: number,
  ): Promise<ProviderResponse> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}/${relativePath}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
      });
    } catch {
      throw rejected(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }
    if (!response.ok) {
      void cancelResponseBody(response);
      throw providerHttpError(response.status);
    }
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("json")) {
      void cancelResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider returned an unsupported content type",
      );
    }
    const payload = await readBoundedJson(response, maximumBytes);
    const providerRequestId = providerRequestIdentity(response.headers.get("x-github-request-id"));
    return { payload, ...(providerRequestId ? { providerRequestId } : {}) };
  }
}

function directoryEntry(
  value: unknown,
  requestedPath: string,
  requestedCommitSha: string,
  repositoryFullName: string,
  apiBaseUrl: string,
): Readonly<{
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  objectSha: string;
  size: number | null;
}> {
  const record = jsonRecord(value, "GitHub directory entry");
  const type = directoryEntryType(record.type);
  const path = repositoryPath(record.path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (record.name !== name) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated directory entry name did not match its path",
    );
  }
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent !== requestedPath) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated directory entry was outside the requested directory",
    );
  }
  const objectSha = commitSha(record.sha);
  if (typeof record.url === "string") {
    verifyApiUrl(
      record.url,
      apiBaseUrl,
      contentsResourcePath(repositoryFullName, path),
      requestedCommitSha,
    );
  }
  let size: number | null = null;
  if (type === "file" && record.size !== undefined) {
    size = nonNegativeSafeInteger(record.size, "GitHub directory file size");
  }
  return Object.freeze({ name, path, type, objectSha, size });
}

function refObject(
  value: unknown,
  repositoryFullName: string,
  requestedRef: string,
  apiBaseUrl: string,
): { objectType: "commit" | "tag"; objectSha: string } {
  const record = jsonRecord(value, "GitHub ref response");
  if (record.ref !== requestedRef) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated ref response did not match the requested ref",
    );
  }
  if (typeof record.url === "string") {
    verifyApiUrl(record.url, apiBaseUrl, gitRefResourcePath(repositoryFullName, requestedRef));
  }
  const object = jsonRecord(record.object, "GitHub ref object");
  const objectType = gitObjectType(object.type);
  const objectSha = commitSha(object.sha);
  if (typeof object.url === "string") {
    verifyApiUrl(
      object.url,
      apiBaseUrl,
      objectType === "commit"
        ? gitCommitResourcePath(repositoryFullName, objectSha)
        : gitTagResourcePath(repositoryFullName, objectSha),
    );
  }
  return { objectType, objectSha };
}

function tagObject(
  value: unknown,
  repositoryFullName: string,
  expectedTagSha: string,
  apiBaseUrl: string,
): { objectType: "commit" | "tag"; objectSha: string } {
  const record = jsonRecord(value, "GitHub tag response");
  if (commitSha(record.sha) !== expectedTagSha) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated tag response did not match the requested tag object",
    );
  }
  if (typeof record.url === "string") {
    verifyApiUrl(record.url, apiBaseUrl, gitTagResourcePath(repositoryFullName, expectedTagSha));
  }
  const object = jsonRecord(record.object, "GitHub tag target");
  const objectType = gitObjectType(object.type);
  const objectSha = commitSha(object.sha);
  if (typeof object.url === "string") {
    verifyApiUrl(
      object.url,
      apiBaseUrl,
      objectType === "commit"
        ? gitCommitResourcePath(repositoryFullName, objectSha)
        : gitTagResourcePath(repositoryFullName, objectSha),
    );
  }
  return { objectType, objectSha };
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = contentLength(response.headers.get("content-length"));
  if (declared !== null && declared > maximumBytes) {
    void cancelResponseBody(response);
    throw rejected(
      "github_delegated_provider_result_too_large",
      `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
    );
  }
  const body = response.body;
  if (!body) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an empty response",
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await ReadableStreamDefaultReader.prototype.read.call(reader) as ReadableStreamReadResult<Uint8Array>;
      } catch {
        void reader.cancel();
        throw rejected(
          "github_delegated_provider_response_failed",
          "GitHub delegated provider response could not be read",
        );
      }
      if (read.done) break;
      if (!(read.value instanceof Uint8Array)) {
        void reader.cancel();
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated provider returned an invalid response chunk",
        );
      }
      total += read.value.byteLength;
      if (total > maximumBytes) {
        void reader.cancel();
        throw rejected(
          "github_delegated_provider_result_too_large",
          `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(new Uint8Array(read.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== total) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider response length did not match Content-Length",
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider response was not valid UTF-8",
    );
  }
  try {
    return parseStrictJson(text, {
      maxBytes: maximumBytes,
      maxDepth: 64,
      maxStringLength: maximumBytes,
      maxObjectKeys: 8_192,
      maxArrayLength: defaultMaximumDirectoryEntries + 1,
      prefix: "GITHUB_REPOSITORY_NAVIGATION_PROVIDER_JSON",
    });
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned invalid JSON",
    );
  }
}

function contentsPath(repository: string, path: string, ref: string): string {
  const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `repos/${encodedRepository(repository)}/contents${suffix}?ref=${encodeURIComponent(ref)}`;
}

function gitRefPath(repository: string, ref: string): string {
  const tail = ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
  return `repos/${encodedRepository(repository)}/git/ref/${tail}`;
}

function gitTagPath(repository: string, sha: string): string {
  return `repos/${encodedRepository(repository)}/git/tags/${sha}`;
}

function contentsResourcePath(repository: string, path: string): string {
  return `/repos/${encodedRepository(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function gitRefResourcePath(repository: string, ref: string): string {
  const tail = ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
  return `/repos/${encodedRepository(repository)}/git/refs/${tail}`;
}

function gitCommitResourcePath(repository: string, sha: string): string {
  return `/repos/${encodedRepository(repository)}/git/commits/${sha}`;
}

function gitTagResourcePath(repository: string, sha: string): string {
  return `/repos/${encodedRepository(repository)}/git/tags/${sha}`;
}

function encodedRepository(repository: string): string {
  const [owner, name] = repository.split("/");
  return `${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
}

function verifyApiUrl(
  value: string,
  apiBaseUrl: string,
  expectedPath: string,
  expectedRef?: string,
): void {
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(apiBaseUrl);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an invalid API URL",
    );
  }
  const expectedSearch = expectedRef === undefined
    ? ""
    : `?ref=${encodeURIComponent(expectedRef)}`;
  if (
    url.protocol !== base.protocol
    || url.host.toLowerCase() !== base.host.toLowerCase()
    || url.username
    || url.password
    || url.search !== expectedSearch
    || url.hash
    || url.pathname !== `${base.pathname.replace(/\/$/u, "")}${expectedPath}`
  ) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated provider API URL did not match the accepted repository resource",
    );
  }
}

function qualifiedGitRef(value: unknown): string {
  const ref = exactAscii(value, "GitHub ref", 240);
  const prefix = ref.startsWith("refs/heads/")
    ? "refs/heads/"
    : ref.startsWith("refs/tags/")
    ? "refs/tags/"
    : null;
  if (!prefix) throw invalidCaller("GitHub ref must be fully qualified");
  const tail = ref.slice(prefix.length);
  if (
    !tail
    || tail === "@"
    || tail === "HEAD"
    || tail.startsWith("-")
    || tail.startsWith("/")
    || tail.endsWith("/")
    || tail.includes("//")
    || tail.includes("..")
    || tail.includes("@{")
    || /[~^:?*\[\\\s]/u.test(tail)
    || tail.split("/").some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
      || segment.endsWith(".")
      || segment.endsWith(".lock")
    )
  ) {
    throw invalidCaller("GitHub ref is invalid");
  }
  return ref;
}

function directoryPath(value: unknown): string {
  if (value === "") return "";
  return repositoryPath(value);
}

function repositoryPath(value: unknown): string {
  if (typeof value !== "string") throw invalidCaller("GitHub repository path is invalid");
  if (
    !value
    || value !== value.trim()
    || value.includes("\\")
    || value.startsWith("/")
    || value.endsWith("/")
    || Buffer.byteLength(value, "utf8") > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw invalidCaller("GitHub repository path is invalid");
  return value;
}

function exactRepository(value: unknown): string {
  if (typeof value !== "string") throw invalidCaller("GitHub repository identity is invalid");
  let normalized: string;
  try {
    normalized = normalizeGitHubRepository(value);
  } catch {
    throw invalidCaller("GitHub repository identity is invalid");
  }
  if (value !== normalized) throw invalidCaller("GitHub repository identity is invalid");
  return normalized;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw invalidCaller("GitHub commit SHA is invalid");
  }
  return value;
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw invalidCaller("GitHub catalogue fingerprint is invalid");
  }
  return value;
}

function exactIdentity(value: unknown, label: string, maximum: number): string {
  return exactAscii(value, label, maximum);
}

function exactCredentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/u.test(value)
  ) {
    throw new RangeError(
      "GitHub delegated credential reference must use env:// or secret://",
    );
  }
  return value;
}

function exactAscii(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/u.test(value)
    || credentialShapedPattern.test(value)
  ) throw invalidCaller(`${label} is invalid`);
  return value;
}

function directoryEntryType(value: unknown): "file" | "dir" | "symlink" | "submodule" {
  if (value !== "file" && value !== "dir" && value !== "symlink" && value !== "submodule") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated directory response contained an unknown entry type",
    );
  }
  return value;
}

function gitObjectType(value: unknown): "commit" | "tag" {
  if (value !== "commit" && value !== "tag") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated ref response contained an unsupported object type",
    );
  }
  return value;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected("github_delegated_provider_invalid_response", `${label} was invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected("github_delegated_provider_invalid_response", `${label} was invalid`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw rejected("github_delegated_provider_invalid_response", `${label} was invalid`);
  }
  return value;
}

function providerRequestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (
    trimmed !== value
    || !trimmed
    || trimmed.length > 240
    || !/^[\x20-\x7e]+$/u.test(trimmed)
    || credentialShapedPattern.test(trimmed)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider request identity was invalid",
    );
  }
  return trimmed;
}

function contentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an invalid Content-Length",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an invalid Content-Length",
    );
  }
  return parsed;
}

function normalizedApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("GitHub delegated API base URL is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) throw new RangeError("GitHub delegated API base URL is invalid");
  return url.toString().replace(/\/$/u, "");
}

function providerHttpError(status: number): GitHubProviderRejectedError {
  if (status === 404) {
    return rejected("github_delegated_provider_not_found", "GitHub delegated provider resource was not found");
  }
  if (status === 401 || status === 403) {
    return rejected("github_delegated_provider_permission_denied", "GitHub delegated provider denied the read");
  }
  if (status === 429 || status >= 500) {
    return rejected("github_delegated_provider_temporarily_unavailable", "GitHub delegated provider is temporarily unavailable");
  }
  return rejected("github_delegated_provider_request_rejected", "GitHub delegated provider rejected the read");
}

function invalidCaller(message: string): Error {
  return rejected("github_delegated_provider_invalid_request", message);
}

function rejected(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}

function cancelResponseBody(response: Response): Promise<void> {
  try {
    return response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
