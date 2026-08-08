import { describe, expect, test } from "bun:test";
import {
  PROCESSING_STAGE_HEADER,
  WORKER_VERSION_ID_HEADER,
} from "../src/worker-observability.ts";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const fingerprint = `sha256:${"c".repeat(64)}`;

function survey(project: string | null = null) {
  return {
    version: 1,
    generatedAt: "2026-08-07T16:40:00.000Z",
    fingerprint,
    changed: null,
    notifyRecommended: false,
    scope: { project },
    counts: {
      total: 7,
      ready: 1,
      active: 2,
      blocked: 1,
      done: 3,
      archived: 0,
    },
  };
}

function toolResponse(
  value: unknown = survey(),
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "stable-read-request-1",
      [PROCESSING_STAGE_HEADER]: "response_produced",
      [WORKER_VERSION_ID_HEADER]: "worker-version-1",
      ...headers,
    },
  });
}

describe("hosted MCP stable read verification", () => {
  test("executes one bounded survey_workspace read and retains only bounded receipts", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (input, init = {}) => {
      calls += 1;
      expect(new URL(String(input)).pathname).toBe("/mcp");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("origin")).toBe("https://www.stensibly.com");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(JSON.parse(String(init.body))).toEqual({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "survey_workspace",
          arguments: {
            project: "stensibly",
            limit: 1,
            expiringWithinSeconds: 900,
          },
        },
      });
      return toolResponse(survey("stensibly"));
    };

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      project: "stensibly",
    }, fetchImpl);

    expect(calls).toBe(1);
    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: true,
      detail: `200 survey=${fingerprint} items=7 project=stensibly workerVersion=worker-version-1 requestId=stable-read-request-1`,
    });
  });

  test("supports an unscoped survey while preserving the null survey scope", async () => {
    const fetchImpl: FetchLike = async (_input, init = {}) => {
      const payload = JSON.parse(String(init.body)) as {
        params: { arguments: Record<string, unknown> };
      };
      expect(payload.params.arguments).toEqual({
        limit: 1,
        expiringWithinSeconds: 900,
      });
      return toolResponse(survey());
    };

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: true,
      detail: `200 survey=${fingerprint} items=7 workerVersion=worker-version-1 requestId=stable-read-request-1`,
    });
  });

  test("requires the exact JSON-RPC response identity", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [{ type: "text", text: JSON.stringify(survey()) }],
        },
      }), {
        status: 200,
        headers: {
          "x-request-id": "stable-read-wrong-id",
          [PROCESSING_STAGE_HEADER]: "response_produced",
          [WORKER_VERSION_ID_HEADER]: "worker-version-1",
        },
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace returned an invalid JSON-RPC envelope",
    });
  });

  test("rejects malformed non-boolean tool error state", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          isError: "false",
          content: [{ type: "text", text: JSON.stringify(survey()) }],
        },
      }), {
        status: 200,
        headers: {
          "x-request-id": "stable-read-bad-is-error",
          [PROCESSING_STAGE_HEADER]: "response_produced",
          [WORKER_VERSION_ID_HEADER]: "worker-version-1",
        },
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "Expected a successful MCP survey_workspace result",
    });
  });

  test("rejects a survey whose returned scope differs from the requested project", async () => {
    const fetchImpl: FetchLike = async () => toolResponse(survey("other-project"));

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      project: "stensibly",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace scope did not match the requested project",
    });
  });

  test("normalizes a tool-level failure without retaining provider text", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          isError: true,
          content: [{
            type: "text",
            text: `provider denied ${token} secret://private-reference`,
          }],
        },
      }), {
        status: 200,
        headers: {
          "x-request-id": "stable-read-denied",
          [PROCESSING_STAGE_HEADER]: "response_produced",
          [WORKER_VERSION_ID_HEADER]: "worker-version-1",
        },
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "Expected a successful MCP survey_workspace result",
    });
    expect(result.detail).not.toContain(token);
    expect(result.detail).not.toContain("secret://");
  });

  test("requires bounded Worker and request receipts on the successful read", async () => {
    const fetchImpl: FetchLike = async () =>
      toolResponse(survey(), {
        "x-request-id": "",
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "Expected a bounded x-request-id on MCP survey_workspace",
    });
  });

  test("rejects a declared response above the verifier byte ceiling before parsing", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-length": String(1024 * 1024 + 1),
          "x-request-id": "stable-read-oversized",
          [PROCESSING_STAGE_HEADER]: "response_produced",
          [WORKER_VERSION_ID_HEADER]: "worker-version-1",
        },
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace response exceeded 1 MiB",
    });
  });

  test("rejects an oversized inner survey text without echoing it", async () => {
    const huge = `secret://${"x".repeat(512 * 1024)}`;
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: huge }] },
      }), {
        status: 200,
        headers: {
          "x-request-id": "stable-read-inner-oversized",
          [PROCESSING_STAGE_HEADER]: "response_produced",
          [WORKER_VERSION_ID_HEADER]: "worker-version-1",
        },
      });

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace text exceeded 512 KiB",
    });
    expect(result.detail).not.toContain("secret://");
  });

  test("normalizes transport failures without retaining thrown provider prose", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`provider failure ${token} secret://private-reference`);
    };

    const result = await verifyHostedStableRead({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace request failed",
    });
  });
});
