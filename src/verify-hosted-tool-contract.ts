import { readFileSync } from "node:fs";
import {
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
} from "./mcp-diagnostics.js";
import {
  createMcpReleaseManifest,
  type McpToolContract,
} from "./mcp-release-manifest.js";
import { parseStrictJson } from "./strict-json.js";
import {
  redactSecrets,
  type CheckResult,
  type FetchLike,
  type VerifyHostedOptions,
} from "./verify-hosted.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_RESPONSE_CHUNKS = 4096;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_PATH = new URL("../docs/chatgpt-app-actions.json", import.meta.url);

interface ChatGptAppContractSnapshot {
  snapshotVersion: number;
  toolCount: number;
  toolContractFingerprint: string;
}

export async function verifyHostedToolContract(
  options: VerifyHostedOptions,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error("timeoutMs must be an integer between 100 and 60000");
    }

    const snapshot = readSnapshot();
    const response = await request(fetchImpl, new URL("/mcp", `${options.endpoint}/`), {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: options.origin,
      },
      redirect: "error",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }, timeoutMs);
    if (response.status !== 200) {
      void cancelResponseBody(response);
    }
    expectStatus(response, 200);
    const body = await readBoundedJson(response, timeoutMs);
    const tools = readToolsListTools(response, body);

    const contracts = tools.map((tool, index) => readToolContract(tool, index));
    const manifest = compileManifest(response, contracts);
    if (manifest.tools.length !== snapshot.toolCount) {
      throw responseError(
        response,
        `Expected ChatGPT tool count ${snapshot.toolCount}; received ${manifest.tools.length}`,
      );
    }
    if (manifest.digest !== snapshot.toolContractFingerprint) {
      throw responseError(
        response,
        `Expected ChatGPT tool contract ${snapshot.toolContractFingerprint}; received ${manifest.digest}`,
      );
    }

    const coarseFingerprint = response.headers
      .get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)
      ?.trim();
    if (coarseFingerprint !== MCP_TOOL_MANIFEST_FINGERPRINT) {
      throw responseError(
        response,
        `Expected ${MCP_TOOL_MANIFEST_FINGERPRINT_HEADER}=${MCP_TOOL_MANIFEST_FINGERPRINT}; received ${coarseFingerprint || "missing"}`,
      );
    }
    const count = response.headers.get(MCP_TOOL_COUNT_HEADER)?.trim();
    if (count !== String(snapshot.toolCount)) {
      throw responseError(
        response,
        `Expected ${MCP_TOOL_COUNT_HEADER}=${snapshot.toolCount}; received ${count || "missing"}`,
      );
    }

    return {
      name: "remote MCP tool contract",
      ok: true,
      detail: `200 tools=${snapshot.toolCount} snapshot=v${snapshot.snapshotVersion} contract=${manifest.digest}`,
    };
  } catch (error) {
    return {
      name: "remote MCP tool contract",
      ok: false,
      detail: redactSecrets(error, options.token),
    };
  }
}

function readSnapshot(): ChatGptAppContractSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as unknown;
  } catch {
    throw new Error("ChatGPT app action snapshot is unreadable");
  }
  if (!isRecord(parsed)) {
    throw new Error("ChatGPT app action snapshot is invalid");
  }

  const snapshotVersion = parsed.snapshotVersion;
  const toolCount = parsed.toolCount;
  const toolContractFingerprint = parsed.toolContractFingerprint;
  if (!Number.isInteger(snapshotVersion) || (snapshotVersion as number) < 1) {
    throw new Error("ChatGPT app action snapshot version is invalid");
  }
  if (!Number.isInteger(toolCount) || (toolCount as number) < 0) {
    throw new Error("ChatGPT app action snapshot tool count is invalid");
  }
  if (typeof toolContractFingerprint !== "string" || !SHA256_PATTERN.test(toolContractFingerprint)) {
    throw new Error("ChatGPT app action snapshot contract fingerprint is invalid");
  }

  return {
    snapshotVersion: snapshotVersion as number,
    toolCount: toolCount as number,
    toolContractFingerprint,
  };
}

function readToolsListTools(response: Response, value: unknown): unknown[] {
  if (
    !isRecord(value)
    || value.jsonrpc !== "2.0"
    || value.id !== 2
    || value.error !== undefined
    || !isRecord(value.result)
    || !Array.isArray(value.result.tools)
  ) {
    throw responseError(
      response,
      "Expected matching MCP tools/list JSON-RPC response",
    );
  }
  return value.result.tools;
}

function readToolContract(value: unknown, index: number): McpToolContract {
  if (!isRecord(value)) {
    throw new Error(`MCP tools/list tool ${index + 1} is invalid`);
  }
  if (typeof value.name !== "string") {
    throw new Error(`MCP tools/list tool ${index + 1} has an invalid name`);
  }
  if (!isRecord(value.inputSchema)) {
    throw new Error(`MCP tools/list tool ${index + 1} has an invalid input schema`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`MCP tools/list tool ${index + 1} has an invalid description`);
  }
  if (value.annotations !== undefined && !isRecord(value.annotations)) {
    throw new Error(`MCP tools/list tool ${index + 1} has invalid annotations`);
  }

  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description as string }),
    ...(value.annotations === undefined
      ? {}
      : { annotations: value.annotations as Record<string, unknown> }),
    inputSchema: value.inputSchema,
  };
}

function compileManifest(response: Response, contracts: McpToolContract[]) {
  try {
    return createMcpReleaseManifest(contracts);
  } catch {
    throw responseError(response, "MCP tools/list contract is invalid");
  }
}

async function request(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw timeoutError(timeoutMs);
    }
    throw new Error("MCP tools/list request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, timeoutMs: number): Promise<unknown> {
  let declaredLength: number | null;
  try {
    declaredLength = admitContentLength(response.headers.get("content-length"));
  } catch (error) {
    void cancelResponseBody(response);
    throw error;
  }
  if (declaredLength !== null && declaredLength > MAXIMUM_RESPONSE_BYTES) {
    void cancelResponseBody(response);
    throw new Error("MCP tools/list response exceeded 1 MiB");
  }

  const reader = acquireResponseReader(response);
  if (!reader) {
    if (declaredLength !== null && declaredLength !== 0) {
      throw new Error("MCP tools/list response length did not match its declaration");
    }
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let deliveredChunks = 0;
  try {
    while (true) {
      const result = await readWithDeadline(reader, controller.signal, timeoutMs);
      if (result.done) break;
      deliveredChunks += 1;
      if (deliveredChunks > MAXIMUM_RESPONSE_CHUNKS) {
        void cancelReader(reader);
        throw new Error(
          `MCP tools/list response exceeded ${MAXIMUM_RESPONSE_CHUNKS} chunks`,
        );
      }
      let detached: Uint8Array;
      try {
        detached = detachResponseChunk(
          result.value,
          MAXIMUM_RESPONSE_BYTES - totalBytes,
        );
      } catch (error) {
        void cancelReader(reader);
        throw error;
      }
      totalBytes += detached.byteLength;
      chunks.push(detached);
    }
  } finally {
    clearTimeout(timer);
    releaseReaderLock(reader);
  }

  if (declaredLength !== null && declaredLength !== totalBytes) {
    throw new Error("MCP tools/list response length did not match its declaration");
  }
  if (totalBytes === 0) return null;

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("MCP tools/list returned invalid UTF-8");
  }
  try {
    return parseStrictJson(text, {
      maxBytes: MAXIMUM_RESPONSE_BYTES,
      maxDepth: 128,
      maxStringLength: MAXIMUM_RESPONSE_BYTES,
      maxObjectKeys: 100_000,
      maxArrayLength: 100_000,
      prefix: "MCP_TOOL_CONTRACT_JSON",
    });
  } catch {
    throw new Error("MCP tools/list returned invalid JSON");
  }
}

function acquireResponseReader(
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> | null {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    throw new Error("MCP tools/list response body could not be inspected");
  }
  if (!body) return null;
  try {
    return ReadableStream.prototype.getReader.call(body) as ReadableStreamDefaultReader<Uint8Array>;
  } catch {
    throw new Error("MCP tools/list response body could not be inspected");
  }
}

const RESPONSE_BYTE_LIMIT = Symbol("response-byte-limit");

function detachResponseChunk(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes: number[] = [];
  try {
    Uint8Array.prototype.forEach.call(value, (byte: number) => {
      if (bytes.length >= maximumBytes) throw RESPONSE_BYTE_LIMIT;
      bytes.push(byte);
    });
  } catch (error) {
    if (error === RESPONSE_BYTE_LIMIT) {
      throw new Error("MCP tools/list response exceeded 1 MiB");
    }
    throw new Error("MCP tools/list returned an invalid byte stream");
  }
  return new Uint8Array(bytes);
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
) {
  if (signal.aborted) {
    void cancelReader(reader);
    throw timeoutError(timeoutMs);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void cancelReader(reader);
      reject(timeoutError(timeoutMs));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      readFromReader(reader).catch(() => {
        void cancelReader(reader);
        if (signal.aborted) throw timeoutError(timeoutMs);
        throw new Error("MCP tools/list response stream failed");
      }),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function readFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return ReadableStreamDefaultReader.prototype.read.call(reader) as Promise<
      ReadableStreamReadResult<Uint8Array>
    >;
  } catch {
    return Promise.reject(new Error("MCP tools/list response stream failed"));
  }
}

function releaseReaderLock(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    ReadableStreamDefaultReader.prototype.releaseLock.call(reader);
  } catch {
    // A cancelled or failed stream can keep a pending read until cancellation settles.
  }
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Request timed out after ${timeoutMs}ms`);
}

function admitContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("MCP tools/list returned an invalid Content-Length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("MCP tools/list returned an invalid Content-Length");
  }
  return length;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    const body = response.body;
    if (!body || body.locked) return;
    await body.cancel();
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await ReadableStreamDefaultReader.prototype.cancel.call(reader);
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

function expectStatus(response: Response, expected: number): void {
  if (response.status !== expected) {
    throw responseError(response, `Expected HTTP ${expected}; received HTTP ${response.status}`);
  }
}

function responseError(response: Response, message: string): Error {
  const requestId = response.headers.get("x-request-id")?.trim();
  return new Error(
    requestId && REQUEST_ID_PATTERN.test(requestId)
      ? `${message}; requestId=${requestId}`
      : message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
