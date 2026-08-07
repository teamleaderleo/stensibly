import { expect, test } from "bun:test";
import {
  PROCESSING_STAGE_HEADER,
  WORKER_VERSION_ID_HEADER,
} from "../src/worker-observability.ts";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const fingerprint = `sha256:${"c".repeat(64)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function successHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-request-id": requestId,
    [PROCESSING_STAGE_HEADER]: "response_produced",
    [WORKER_VERSION_ID_HEADER]: "worker-version-1",
  };
}

function surveyText(): string {
  return JSON.stringify({
    version: 1,
    generatedAt: "2026-08-07T16:40:00.000Z",
    fingerprint,
    scope: { project: null },
    counts: { total: 7 },
  });
}

function successfulEnvelope(text = surveyText()): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [{ type: "text", text }],
    },
  });
}

test("classifies non-200 status before consuming a stalled body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl: FetchLike = async () =>
    new Response(body, {
      status: 401,
      headers: { "x-request-id": "stable-read-http-401" },
    });

  const result = await verifyHostedStableRead(
    { ...options, timeoutMs: 100 },
    fetchImpl,
  );

  expect(result).toEqual({
    name: "remote MCP stable read",
    ok: false,
    detail: "Expected HTTP 200; received HTTP 401; requestId=stable-read-http-401",
  });
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

test("rejects duplicate keys in the outer JSON-RPC envelope", async () => {
  const inner = surveyText();
  const body = `{"jsonrpc":"2.0","id":3,"id":3,"result":{"content":[{"type":"text","text":${JSON.stringify(inner)}}]}}`;
  const fetchImpl: FetchLike = async () =>
    new Response(body, {
      status: 200,
      headers: successHeaders("stable-read-duplicate-envelope"),
    });

  const result = await verifyHostedStableRead(options, fetchImpl);

  expect(result).toEqual({
    name: "remote MCP stable read",
    ok: false,
    detail: "MCP survey_workspace returned invalid JSON",
  });
});

test("rejects duplicate keys in the inner survey JSON", async () => {
  const inner = `{"version":1,"version":1,"generatedAt":"2026-08-07T16:40:00.000Z","fingerprint":"${fingerprint}","scope":{"project":null},"counts":{"total":7}}`;
  const fetchImpl: FetchLike = async () =>
    new Response(successfulEnvelope(inner), {
      status: 200,
      headers: successHeaders("stable-read-duplicate-survey"),
    });

  const result = await verifyHostedStableRead(options, fetchImpl);

  expect(result).toEqual({
    name: "remote MCP stable read",
    ok: false,
    detail: "MCP survey_workspace returned invalid JSON text",
  });
});

test("rejects contradictory JSON-RPC result and error envelopes", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: `provider ${token}` },
      result: {
        content: [{ type: "text", text: surveyText() }],
      },
    }), {
      status: 200,
      headers: successHeaders("stable-read-result-error"),
    });

  const result = await verifyHostedStableRead(options, fetchImpl);

  expect(result).toEqual({
    name: "remote MCP stable read",
    ok: false,
    detail: "MCP survey_workspace returned an invalid JSON-RPC envelope",
  });
  expect(result.detail).not.toContain(token);
});
