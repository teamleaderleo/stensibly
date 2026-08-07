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
import {
  redactSecrets,
  type CheckResult,
  type FetchLike,
  type VerifyHostedOptions,
} from "./verify-hosted.js";

const DEFAULT_TIMEOUT_MS = 10_000;
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
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: options.origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }, timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 200);

    const tools = isRecord(body)
      && isRecord(body.result)
      && Array.isArray(body.result.tools)
      ? body.result.tools
      : null;
    if (!tools) {
      throw responseError(response, "Expected an MCP tools/list result");
    }

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
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
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
