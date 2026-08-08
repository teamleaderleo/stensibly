import { describe, expect, test } from "bun:test";
import {
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function contractHeaders(requestId: string): Headers {
  return new Headers({
    "content-type": "application/json",
    "content-length": "1",
    "x-request-id": requestId,
    [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: MCP_TOOL_MANIFEST_FINGERPRINT,
    [MCP_TOOL_COUNT_HEADER]: String(MCP_TOOL_NAMES.length),
  });
}

describe("hosted MCP tool-contract chunk prototype inspection", () => {
  test("copies typed-array internal bytes without walking caller prototype state", async () => {
    let prototypeReads = 0;
    const chunk = new Uint8Array([0x7b]);
    const hostilePrototype = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("provider chunk prototype must not execute");
      },
    });
    Object.setPrototypeOf(chunk, hostilePrototype);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = {
      status: 200,
      headers: contractHeaders("tool-contract-chunk-prototype"),
      body,
    } as unknown as Response;
    const fetchImpl: FetchLike = async () => response;

    const result = await verifyHostedToolContract(options, fetchImpl);

    expect(prototypeReads).toBe(0);
    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list returned invalid JSON",
    });
  });
});
