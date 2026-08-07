import {
  PROCESSING_STAGE_HEADER,
  WORKER_VERSION_CREATED_AT_HEADER,
  WORKER_VERSION_ID_HEADER,
  WORKER_VERSION_TAG_HEADER,
} from "./worker-observability.js";
import {
  redactSecrets,
  type CheckResult,
  type FetchLike,
  type VerifyHostedOptions,
} from "./verify-hosted.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_SURVEY_TEXT_BYTES = 512 * 1024;
const MAXIMUM_RESPONSE_CHUNKS = 4096;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIAGNOSTIC_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export async function verifyHostedStableRead(
  options: VerifyHostedOptions,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error("timeoutMs must be an integer between 100 and 60000");
    }

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
        id: 3,
        method: "tools/call",
        params: {
          name: "survey_workspace",
          arguments: {
            ...(options.project ? { project: options.project } : {}),
            limit: 1,
            expiringWithinSeconds: 900,
          },
        },
      }),
    }, timeoutMs);
    const body = await readBoundedJson(response, timeoutMs);
    expectStatus(response, 200);
    const receipt = requireWorkerReceipt(response);
    const survey = readSurvey(body, options.project);

    return {
      name: "remote MCP stable read",
      ok: true,
      detail: [
        "200",
        `survey=${survey.fingerprint}`,
        `items=${survey.total}`,
        ...(options.project ? [`project=${options.project}`] : []),
        `workerVersion=${receipt.workerVersionId}`,
        `requestId=${receipt.requestId}`,
      ].join(" "),
    };
  } catch (error) {
    return {
      name: "remote MCP stable read",
      ok: false,
      detail: redactSecrets(error, options.token),
    };
  }
}

function readSurvey(
  body: unknown,
  expectedProject: string | undefined,
): Readonly<{ fingerprint: string; total: number }> {
  if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== 3) {
    throw new Error("MCP survey_workspace returned an invalid JSON-RPC envelope");
  }
  const result = isRecord(body.result) ? body.result : null;
  if (
    !result
    || (result.isError !== undefined && result.isError !== false)
    || !Array.isArray(result.content)
  ) {
    throw new Error("Expected a successful MCP survey_workspace result");
  }
  if (result.content.length !== 1 || !isRecord(result.content[0])) {
    throw new Error("MCP survey_workspace returned an invalid content envelope");
  }
  const block = result.content[0];
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new Error("MCP survey_workspace returned an invalid text result");
  }
  if (Buffer.byteLength(block.text, "utf8") > MAXIMUM_SURVEY_TEXT_BYTES) {
    throw new Error("MCP survey_workspace text exceeded 512 KiB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text) as unknown;
  } catch {
    throw new Error("MCP survey_workspace returned invalid JSON text");
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("MCP survey_workspace returned an invalid survey version");
  }
  if (typeof parsed.generatedAt !== "string" || !isCanonicalTimestamp(parsed.generatedAt)) {
    throw new Error("MCP survey_workspace returned an invalid generated time");
  }
  if (typeof parsed.fingerprint !== "string" || !SHA256_PATTERN.test(parsed.fingerprint)) {
    throw new Error("MCP survey_workspace returned an invalid fingerprint");
  }
  if (!isRecord(parsed.scope)) {
    throw new Error("MCP survey_workspace returned an invalid scope");
  }
  const project = parsed.scope.project;
  if (project !== (expectedProject ?? null)) {
    throw new Error("MCP survey_workspace scope did not match the requested project");
  }
  if (!isRecord(parsed.counts)) {
    throw new Error("MCP survey_workspace returned invalid counts");
  }
  const total = parsed.counts.total;
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw new Error("MCP survey_workspace returned an invalid total count");
  }

  return Object.freeze({
    fingerprint: parsed.fingerprint,
    total: total as number,
  });
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
    if (controller.signal.aborted) throw timeoutError(timeoutMs);
    throw new Error("MCP survey_workspace request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, timeoutMs: number): Promise<unknown> {
  let declaredLength: number | null;
  try {
    declaredLength = admitContentLength(response.headers.get("content-length"));
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  if (declaredLength !== null && declaredLength > MAXIMUM_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error("MCP survey_workspace response exceeded 1 MiB");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    if (declaredLength !== null && declaredLength !== 0) {
      throw new Error("MCP survey_workspace response length did not match its declaration");
    }
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const result = await readWithDeadline(reader, controller.signal, timeoutMs);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw new Error("MCP survey_workspace returned an invalid byte stream");
      }
      chunkCount += 1;
      if (chunkCount > MAXIMUM_RESPONSE_CHUNKS) {
        await cancelReader(reader);
        throw new Error("MCP survey_workspace response exceeded 4096 chunks");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw new Error("MCP survey_workspace response exceeded 1 MiB");
      }
      chunks.push(result.value.slice());
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or failed stream can keep a pending read until cancellation settles.
    }
  }

  if (declaredLength !== null && declaredLength !== totalBytes) {
    throw new Error("MCP survey_workspace response length did not match its declaration");
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
    throw new Error("MCP survey_workspace returned invalid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("MCP survey_workspace returned invalid JSON");
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
) {
  if (signal.aborted) {
    await cancelReader(reader);
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
      reader.read().catch(async () => {
        await cancelReader(reader);
        if (signal.aborted) throw timeoutError(timeoutMs);
        throw new Error("MCP survey_workspace response stream failed");
      }),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function requireWorkerReceipt(response: Response): Readonly<{
  workerVersionId: string;
  requestId: string;
}> {
  const stage = response.headers.get(PROCESSING_STAGE_HEADER)?.trim();
  if (stage !== "response_produced") {
    throw responseError(
      response,
      `Expected ${PROCESSING_STAGE_HEADER}=response_produced`,
    );
  }

  const workerVersionId = response.headers.get(WORKER_VERSION_ID_HEADER)?.trim();
  if (!workerVersionId || !DIAGNOSTIC_VALUE_PATTERN.test(workerVersionId)) {
    throw responseError(response, `Expected a bounded ${WORKER_VERSION_ID_HEADER}`);
  }
  for (const header of [WORKER_VERSION_TAG_HEADER, WORKER_VERSION_CREATED_AT_HEADER]) {
    const value = response.headers.get(header)?.trim();
    if (value && !DIAGNOSTIC_VALUE_PATTERN.test(value)) {
      throw responseError(response, `Received malformed ${header}`);
    }
  }

  const requestId = response.headers.get("x-request-id")?.trim();
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Expected a bounded x-request-id on MCP survey_workspace");
  }
  return Object.freeze({ workerVersionId, requestId });
}

function expectStatus(response: Response, expected: number): void {
  if (response.status !== expected) {
    throw responseError(
      response,
      `Expected HTTP ${expected}; received HTTP ${response.status}`,
    );
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

function admitContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("MCP survey_workspace returned an invalid Content-Length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("MCP survey_workspace returned an invalid Content-Length");
  }
  return length;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Request timed out after ${timeoutMs}ms`);
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
