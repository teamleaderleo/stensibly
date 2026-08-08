import { describe, expect, test } from "bun:test";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

describe("hosted stable-read chunk detachment", () => {
  test("copies response bytes without consulting caller byteLength, constructor, or species", async () => {
    let byteLengthReads = 0;
    let constructorReads = 0;
    const chunk = new Uint8Array([0x7b]);
    Object.defineProperty(chunk, "byteLength", {
      configurable: true,
      get() {
        byteLengthReads += 1;
        throw new Error("provider byteLength must not execute");
      },
    });
    Object.defineProperty(chunk, "constructor", {
      configurable: true,
      get() {
        constructorReads += 1;
        throw new Error("provider constructor must not execute");
      },
    });

    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "1",
          "x-request-id": "stable-read-chunk-detachment",
        },
      });

    const result = await verifyHostedStableRead(options, fetchImpl);

    expect(byteLengthReads).toBe(0);
    expect(constructorReads).toBe(0);
    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace returned invalid JSON",
    });
  });

  test("does not wait for stalled body cleanup after a fixed rejection", async () => {
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const neverSettles = new Promise<void>(() => {});
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        cancel() {
          markCancelStarted();
          return neverSettles;
        },
      }), {
        status: 200,
        headers: {
          "content-length": "01",
          "x-request-id": "stable-read-cleanup-stall",
        },
      });

    const verification = verifyHostedStableRead(options, fetchImpl);
    await cancelStarted;
    const stillPending = Symbol("still-pending");
    const result = await Promise.race([
      verification,
      new Promise<typeof stillPending>((resolve) => {
        setTimeout(() => resolve(stillPending), 100);
      }),
    ]);

    expect(result).not.toBe(stillPending);
    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace returned an invalid Content-Length",
    });
  });
});