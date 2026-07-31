import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  assertGitHubOfficialMcpReadMappingMatchesPolicy,
  type GitHubOfficialMcpMappedRead,
} from "./github-official-mcp-read-mapping.js";

export const githubOfficialMcpRemoteEndpoint =
  "https://api.githubcopilot.com/mcp/" as const;
export const githubOfficialMcpRemoteMaximumTextBytes = 256 * 1024;
export const githubOfficialMcpRemoteMaximumResponseBytes = 2 * 1024 * 1024;

export type GitHubOfficialMcpRemoteErrorCode =
  | "github_official_mcp_mapping_rejected"
  | "github_official_mcp_credential_unavailable"
  | "github_official_mcp_transport_failed"
  | "github_official_mcp_invalid_result"
  | "github_official_mcp_close_failed";

export class GitHubOfficialMcpRemoteError extends Error {
  readonly code: GitHubOfficialMcpRemoteErrorCode;

  constructor(code: GitHubOfficialMcpRemoteErrorCode, message: string) {
    super(message);
    this.name = "GitHubOfficialMcpRemoteError";
    this.code = code;
  }
}

export interface GitHubOfficialMcpBearerResolver {
  resolveGitHubOfficialMcpBearer(input: {
    credentialRef: string;
    repositoryFullName: string;
    officialTool: string;
  }): Promise<string>;
}

export interface GitHubOfficialMcpRemoteSession {
  connect(): Promise<void>;
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    timeoutMs: number;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface GitHubOfficialMcpRemoteSessionFactoryInput {
  endpoint: URL;
  headers: Readonly<Record<string, string>>;
  fetch: typeof fetch;
}

export interface GitHubOfficialMcpRemoteSessionFactory {
  create(
    input: GitHubOfficialMcpRemoteSessionFactoryInput,
  ): GitHubOfficialMcpRemoteSession;
}

export interface GitHubOfficialMcpRemoteTransportOptions {
  credentials: GitHubOfficialMcpBearerResolver;
  endpoint?: string;
  fetch?: typeof fetch;
  sessionFactory?: GitHubOfficialMcpRemoteSessionFactory;
  timeoutMs?: number;
}

export interface GitHubOfficialMcpRemoteCallInput {
  mapping: GitHubOfficialMcpMappedRead;
  credentialRef: string;
}

export interface GitHubOfficialMcpRemoteCallResult {
  result: unknown;
}

interface AdmittedRemoteCallInput {
  mapping: unknown;
  credentialRef: string;
}

/**
 * Executes one already-mapped read through the official GitHub Streamable HTTP
 * MCP endpoint. Mapping evidence remains non-authorizing; the caller must
 * complete Stensibly authority and binding checks before entering this
 * transport boundary.
 */
export class GitHubOfficialMcpRemoteTransport {
  readonly #credentials: GitHubOfficialMcpBearerResolver;
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  readonly #sessionFactory: GitHubOfficialMcpRemoteSessionFactory;
  readonly #timeoutMs: number;

  constructor(options: GitHubOfficialMcpRemoteTransportOptions) {
    this.#credentials = options.credentials;
    this.#endpoint = admittedEndpoint(
      options.endpoint ?? githubOfficialMcpRemoteEndpoint,
    );
    this.#fetch = confinedFetch(this.#endpoint, options.fetch ?? globalThis.fetch);
    this.#sessionFactory = options.sessionFactory ?? sdkSessionFactory;
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? 15_000);
  }

  async callMappedRead(
    value: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult> {
    const input = admittedCallInput(value);
    let mapping: GitHubOfficialMcpMappedRead;
    try {
      mapping = admittedMappedRead(input.mapping);
    } catch {
      throw remoteError(
        "github_official_mcp_mapping_rejected",
        "Official GitHub MCP read mapping is stale or unsupported",
      );
    }

    let bearer: string;
    try {
      bearer = admittedBearer(await withPhaseDeadline(
        () => this.#credentials.resolveGitHubOfficialMcpBearer({
          credentialRef: input.credentialRef,
          repositoryFullName: mapping.repositoryFullName,
          officialTool: mapping.officialTool,
        }),
        this.#timeoutMs,
      ));
    } catch {
      throw remoteError(
        "github_official_mcp_credential_unavailable",
        "Official GitHub MCP credential is unavailable",
      );
    }

    const headers = Object.freeze({
      Authorization: `Bearer ${bearer}`,
      "User-Agent": "stensibly-github-official-mcp/1",
      "X-MCP-Readonly": "true",
      "X-MCP-Tools": mapping.officialTool,
    });

    let session: GitHubOfficialMcpRemoteSession;
    try {
      session = this.#sessionFactory.create({
        endpoint: new URL(this.#endpoint.href),
        headers,
        fetch: this.#fetch,
      });
    } catch {
      throw remoteError(
        "github_official_mcp_transport_failed",
        "Official GitHub MCP transport could not be created",
      );
    }

    let result: GitHubOfficialMcpRemoteCallResult | undefined;
    let failure: GitHubOfficialMcpRemoteError | undefined;
    try {
      await withPhaseDeadline(() => session.connect(), this.#timeoutMs);
      const envelope = await withPhaseDeadline(
        () => session.callTool({
          name: mapping.officialTool,
          arguments: mapping.officialArguments,
          timeoutMs: this.#timeoutMs,
        }),
        this.#timeoutMs,
      );
      result = Object.freeze({ result: admittedToolResult(envelope) });
    } catch (error) {
      failure = error instanceof GitHubOfficialMcpRemoteError
        ? error
        : remoteError(
          "github_official_mcp_transport_failed",
          "Official GitHub MCP read failed before a verified result was available",
        );
    }

    let closeFailed = false;
    try {
      await withPhaseDeadline(() => session.close(), this.#timeoutMs);
    } catch {
      closeFailed = true;
    }

    if (failure) throw failure;
    if (closeFailed) {
      throw remoteError(
        "github_official_mcp_close_failed",
        "Official GitHub MCP session could not be closed",
      );
    }
    if (!result) {
      throw remoteError(
        "github_official_mcp_transport_failed",
        "Official GitHub MCP read failed before a verified result was available",
      );
    }
    return result;
  }
}

const sdkSessionFactory: GitHubOfficialMcpRemoteSessionFactory = Object.freeze({
  create(
    input: GitHubOfficialMcpRemoteSessionFactoryInput,
  ): GitHubOfficialMcpRemoteSession {
    const transport = new StreamableHTTPClientTransport(input.endpoint, {
      fetch: input.fetch,
      requestInit: { headers: new Headers(input.headers) },
      reconnectionOptions: {
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 0,
      },
    });
    const client = new Client({
      name: "stensibly-github-official-mcp",
      version: "1.0.0",
    });
    client.onerror = () => {
      // SDK/provider diagnostics remain inside this content-minimizing boundary.
    };
    return {
      connect: () => client.connect(transport),
      callTool: ({
        name,
        arguments: args,
        timeoutMs,
      }: {
        name: string;
        arguments: Readonly<Record<string, unknown>>;
        timeoutMs: number;
      }) =>
        client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
      close: () => client.close(),
    };
  },
});

function admittedCallInput(value: unknown): AdmittedRemoteCallInput {
  const record = exactDataRecord(
    value,
    ["credentialRef", "mapping"],
    "Official GitHub MCP call",
  );
  return Object.freeze({
    mapping: record.mapping,
    credentialRef: admittedCredentialReference(record.credentialRef),
  });
}

function admittedMappedRead(value: unknown): GitHubOfficialMcpMappedRead {
  assertGitHubOfficialMcpReadMappingMatchesPolicy(value);
  const record = exactDataRecord(
    value,
    [
      "authorizesProviderCall",
      "mappingPolicyVersion",
      "mappingPolicyFingerprint",
      "sourceCommitSha",
      "sourceToolSnapshotBlobShas",
      "state",
      "stensiblyTool",
      "repositoryFullName",
      "officialToolset",
      "officialTool",
      "officialArguments",
      "resultContract",
      "maximumResultItems",
    ],
    "Official GitHub MCP mapped read",
  );
  if (record.state !== "mapped") throw new RangeError();
  return Object.freeze({
    authorizesProviderCall: record.authorizesProviderCall as false,
    mappingPolicyVersion: record.mappingPolicyVersion as 1,
    mappingPolicyFingerprint: record.mappingPolicyFingerprint as string,
    sourceCommitSha: record.sourceCommitSha as string,
    sourceToolSnapshotBlobShas: frozenStringArraySnapshot(
      record.sourceToolSnapshotBlobShas,
    ),
    state: "mapped",
    stensiblyTool: record.stensiblyTool as GitHubOfficialMcpMappedRead["stensiblyTool"],
    repositoryFullName: record.repositoryFullName as string,
    officialToolset: record.officialToolset as GitHubOfficialMcpMappedRead["officialToolset"],
    officialTool: record.officialTool as GitHubOfficialMcpMappedRead["officialTool"],
    officialArguments: frozenArgumentSnapshot(record.officialArguments),
    resultContract: record.resultContract as GitHubOfficialMcpMappedRead["resultContract"],
    maximumResultItems: record.maximumResultItems as 1,
  });
}

function admittedCredentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 240
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/.test(value)
  ) {
    throw remoteError(
      "github_official_mcp_credential_unavailable",
      "Official GitHub MCP credential reference is invalid",
    );
  }
  return value;
}

function admittedEndpoint(value: unknown): URL {
  let text: string;
  try {
    text = exactPrintableText(
      value,
      "Official GitHub MCP endpoint",
      2_048,
    );
  } catch {
    throw new Error("Official GitHub MCP endpoint is invalid");
  }
  if (text !== githubOfficialMcpRemoteEndpoint) {
    throw new Error("Official GitHub MCP endpoint is invalid");
  }
  return new URL(text);
}

function admittedBearer(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error("Official GitHub MCP bearer is invalid");
  }
  return value;
}

function boundedTimeout(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1_000
    || value > 60_000
  ) {
    throw new RangeError(
      "Official GitHub MCP timeout must be 1000 to 60000 milliseconds",
    );
  }
  return value;
}

function withPhaseDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Official GitHub MCP phase deadline exceeded"));
    }, timeoutMs);
    const complete = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    try {
      Promise.resolve(run()).then(
        (value) => complete(() => resolve(value)),
        (error) => complete(() => reject(error)),
      );
    } catch (error) {
      complete(() => reject(error));
    }
  });
}

function confinedFetch(endpoint: URL, delegate: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, {
      ...init,
      redirect: "manual",
    });
    if (request.url !== endpoint.href) {
      throw new Error("Official GitHub MCP request escaped its endpoint");
    }
    const response = await delegate(request);
    if (
      response.redirected
      || (response.status >= 300 && response.status < 400)
      || (response.url !== "" && response.url !== endpoint.href)
    ) {
      await disposeResponse(response);
      throw new Error("Official GitHub MCP redirect was rejected");
    }
    return boundedResponse(response);
  }) as typeof fetch;
}

async function boundedResponse(response: Response): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      await disposeResponse(response);
      throw new Error("Official GitHub MCP response length is invalid");
    }
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes > githubOfficialMcpRemoteMaximumResponseBytes
    ) {
      await disposeResponse(response);
      throw new Error("Official GitHub MCP response is oversized");
    }
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  let responseBytes = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // Reader release is best effort after the bounded result is settled.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          await cancelReader(reader);
          release();
          controller.error(new Error("Official GitHub MCP response body is invalid"));
          return;
        }
        responseBytes += next.value.byteLength;
        if (responseBytes > githubOfficialMcpRemoteMaximumResponseBytes) {
          await cancelReader(reader);
          release();
          controller.error(new Error("Official GitHub MCP response is oversized"));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        await cancelReader(reader);
        release();
        controller.error(new Error("Official GitHub MCP response could not be read"));
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Caller cancellation remains authoritative if the provider rejects it.
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The bounded rejection remains authoritative if cancellation fails.
  }
}

async function disposeResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Status and identity confinement remain authoritative if disposal fails.
  }
}

function admittedToolResult(value: unknown): unknown {
  try {
    return admittedToolResultInner(value);
  } catch (error) {
    if (error instanceof GitHubOfficialMcpRemoteError) throw error;
    throw invalidResult();
  }
}

function admittedToolResultInner(value: unknown): unknown {
  const record = exactDataRecord(
    value,
    ["_meta", "content", "isError", "structuredContent"],
    "Official GitHub MCP tool result",
  );
  if (record.isError !== undefined && typeof record.isError !== "boolean") {
    throw invalidResult();
  }
  if (record.isError === true) {
    throw remoteError(
      "github_official_mcp_transport_failed",
      "Official GitHub MCP reported a tool execution error",
    );
  }
  if (
    Object.hasOwn(record, "_meta")
    || Object.hasOwn(record, "structuredContent")
  ) {
    throw invalidResult();
  }
  const content = denseDataArray(
    record.content,
    "Official GitHub MCP result content",
  );
  if (content.length !== 1) throw invalidResult();
  const item = exactDataRecord(
    content[0],
    ["text", "type"],
    "Official GitHub MCP result item",
  );
  if (item.type !== "text" || typeof item.text !== "string") {
    throw invalidResult();
  }
  const bytes = Buffer.byteLength(item.text, "utf8");
  if (bytes < 1 || bytes > githubOfficialMcpRemoteMaximumTextBytes) {
    throw invalidResult();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.text) as unknown;
  } catch {
    throw invalidResult();
  }
  return frozenJsonSnapshot(parsed, { nodes: 0 }, 0);
}

function frozenArgumentSnapshot(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Official GitHub MCP arguments must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError("Official GitHub MCP arguments must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError("Official GitHub MCP arguments contain a symbol field");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 16) {
    throw new RangeError("Official GitHub MCP arguments are oversized");
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        "Official GitHub MCP arguments must use enumerable data properties",
      );
    }
    const entry = descriptor.value;
    if (
      typeof entry !== "string"
      && typeof entry !== "number"
      && typeof entry !== "boolean"
    ) {
      throw new RangeError("Official GitHub MCP argument value is invalid");
    }
    if (
      typeof entry === "number"
      && (!Number.isFinite(entry) || Object.is(entry, -0))
    ) {
      throw new RangeError("Official GitHub MCP argument number is invalid");
    }
    output[key] = entry;
  }
  return Object.freeze(output);
}

function frozenStringArraySnapshot(value: unknown): readonly string[] {
  const entries = denseDataArray(value, "Official GitHub MCP source snapshots");
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new RangeError("Official GitHub MCP source snapshot is invalid");
  }
  return Object.freeze([...entries] as string[]);
}

function frozenJsonSnapshot(
  value: unknown,
  state: { nodes: number },
  depth: number,
): unknown {
  if (depth > 32 || ++state.nodes > 10_000) throw invalidResult();
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidResult();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) throw invalidResult();
    return Object.freeze(
      value.map((entry) => frozenJsonSnapshot(entry, state, depth + 1)),
    );
  }
  if (!value || typeof value !== "object") throw invalidResult();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidResult();
  const keys = Object.keys(value);
  if (keys.length > 4_096) throw invalidResult();
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    output[key] = frozenJsonSnapshot(
      (value as Record<string, unknown>)[key],
      state,
      depth + 1,
    );
  }
  return Object.freeze(output);
}

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new RangeError(`${label} has an unknown field`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} must be a dense array`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`${label} has an invalid length`);
  }
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Object.getOwnPropertyNames(value).some((key) => !expected.has(key))) {
    throw new RangeError(`${label} contains a decorated field`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} must contain dense data slots`);
    }
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function exactPrintableText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new RangeError(`${label} must use exact printable ASCII`);
  }
  return value;
}

function invalidResult(): GitHubOfficialMcpRemoteError {
  return remoteError(
    "github_official_mcp_invalid_result",
    "Official GitHub MCP returned an invalid or oversized result",
  );
}

function remoteError(
  code: GitHubOfficialMcpRemoteErrorCode,
  message: string,
): GitHubOfficialMcpRemoteError {
  return new GitHubOfficialMcpRemoteError(code, message);
}
