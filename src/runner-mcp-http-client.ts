const MAX_RESPONSE_BYTES = 1_000_000;
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

export type RunnerMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class RunnerMcpHttpClient {
  readonly endpoint: URL;
  readonly #token: string;
  readonly #fetch: RunnerMcpFetch;
  readonly #timeoutMilliseconds: number;
  #requestId = 0;

  constructor(input: {
    endpoint: string | URL;
    token: string;
    fetch?: RunnerMcpFetch;
    timeoutMilliseconds?: number;
  }) {
    this.endpoint = normalizeEndpoint(input.endpoint);
    this.#token = required(input.token, "Runner token");
    this.#fetch = input.fetch ?? ((request, init) => fetch(request, init));
    this.#timeoutMilliseconds = positiveInteger(
      input.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
      "Runner timeout",
    );
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    let response: Response;
    try {
      response = await this.#fetch(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.#token}`,
          "cache-control": "no-store",
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.#requestId,
          method: "tools/call",
          params: { name: required(name, "Runner tool name"), arguments: args },
        }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      clearTimeout(timeout);
      throw new Error(
        `Runner MCP ${required(name, "Runner tool name")} transport ${timedOut ? "timed out" : "failed"}`,
      );
    }
    let raw: string;
    try {
      raw = await boundedBody(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Runner MCP ${required(name, "Runner tool name")} transport timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`Runner MCP returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Runner MCP rejected ${name} (HTTP ${response.status})`);
    }
    const result = record(body).result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`Runner MCP returned no result for ${name}`);
    }
    const admitted = result as Record<string, unknown>;
    const first = Array.isArray(admitted.content) ? admitted.content[0] : null;
    if (!first || typeof first !== "object" || Array.isArray(first)) {
      throw new Error(`Runner MCP returned no bounded content for ${name}`);
    }
    const content = first as Record<string, unknown>;
    if (content.type !== "text" || typeof content.text !== "string") {
      throw new Error(`Runner MCP returned non-text content for ${name}`);
    }
    if (admitted.isError === true) {
      throw new Error(`Runner MCP ${name} failed: ${clip(content.text, 500)}`);
    }
    try {
      return JSON.parse(content.text) as T;
    } catch {
      throw new Error(`Runner MCP returned invalid tool JSON for ${name}`);
    }
  }
}

function normalizeEndpoint(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new RangeError("Runner MCP endpoint must use HTTPS outside loopback");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/runner/mcp";
  if (url.username || url.password || url.search || url.hash) {
    throw new RangeError("Runner MCP endpoint must not contain credentials, query, or fragment");
  }
  return url;
}

async function boundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Runner MCP response exceeds the fixed byte ceiling");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Runner MCP response exceeds the fixed byte ceiling");
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new Error("Runner MCP returned invalid UTF-8");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner MCP response must be an object");
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 300_000) {
    throw new RangeError(`${label} must be between 1 and 300000 milliseconds`);
  }
  return Number(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
