import { describe, expect, test } from "bun:test";
import { RunnerMcpHttpClient } from "../src/runner-mcp-http-client.ts";

const token = `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`;

describe("bounded runner MCP HTTP client", () => {
  test("requires a credential-free HTTPS endpoint outside loopback", () => {
    expect(() => new RunnerMcpHttpClient({
      endpoint: "http://api.stensibly.com/runner/mcp",
      token,
    })).toThrow(/HTTPS/);
    expect(() => new RunnerMcpHttpClient({
      endpoint: "https://user:password@api.stensibly.com/runner/mcp",
      token,
    })).toThrow(/credentials/);
  });

  test("posts one no-store, no-redirect tool call and admits bounded JSON", async () => {
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token,
      fetch: async (input, init) => {
        expect(String(input)).toBe("http://localhost/runner/mcp");
        expect(init?.redirect).toBe("error");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        });
      },
    });

    await expect(client.call("probe", {})).resolves.toEqual({ ok: true });
  });

  test("cancels a chunked response as soon as it crosses the byte ceiling", async () => {
    let cancelled = false;
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(700_000));
          controller.enqueue(new Uint8Array(700_000));
        },
        cancel() {
          cancelled = true;
        },
      })),
    });

    await expect(client.call("probe", {})).rejects.toThrow(/byte ceiling/);
    expect(cancelled).toBe(true);
  });

  test("bounds a stalled transport without retaining endpoint or token", async () => {
    const client = new RunnerMcpHttpClient({
      endpoint: "http://localhost/runner/mcp",
      token,
      timeoutMilliseconds: 5,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private provider detail")));
      }),
    });

    const captured: unknown = await client.call("probe", {}).catch((value: unknown) => value);
    expect(captured).toBeInstanceOf(Error);
    const error = captured as Error;
    expect(error.message).toBe("Runner MCP probe transport timed out");
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("localhost");
    expect(error.message).not.toContain("provider detail");
  });
});
