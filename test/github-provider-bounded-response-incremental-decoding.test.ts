import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 100;

describe("bounded GitHub provider incremental UTF-8 decoding", () => {
  test("decodes one multibyte code point split across detached chunks", async () => {
    const encoded = new TextEncoder().encode("A😀Z");
    const response = responseFromChunks([
      encoded.slice(0, 2),
      encoded.slice(2, 4),
      encoded.slice(4),
    ]);

    await expect(readBoundedGitHubProviderResponseText(
      response.value,
      encoded.byteLength,
      deadlineMs,
    )).resolves.toBe("A😀Z");
    expect(response.cancelled()).toBe(false);
  });

  test("rejects an incomplete final UTF-8 sequence and cancels the reader", async () => {
    const response = responseFromChunks([
      new Uint8Array([0xf0, 0x9f, 0x98]),
    ]);

    await expect(readBoundedGitHubProviderResponseText(
      response.value,
      3,
      deadlineMs,
    )).rejects.toBeInstanceOf(GitHubProviderResponseReadError);
    expect(response.cancelled()).toBe(true);
  });

  test("retains no all-chunk array or second full-size byte buffer", async () => {
    const source = await Bun.file(
      "src/github-provider-bounded-response.ts",
    ).text();

    expect(source).not.toContain("const chunks: Uint8Array[]");
    expect(source).not.toContain("new Uint8Array(totalBytes)");
    expect(source).toContain("decoder.decode(detached, { stream: true })");
    expect(source).toContain("text += decoder.decode()");
  });
});

function responseFromChunks(chunks: readonly Uint8Array[]) {
  let index = 0;
  let wasCancelled = false;
  const reader = {
    async read() {
      const value = chunks[index];
      if (value === undefined) return { done: true };
      index += 1;
      return { done: false, value };
    },
    cancel() {
      wasCancelled = true;
    },
    releaseLock() {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const body = {
    getReader() {
      return reader;
    },
    cancel() {
      wasCancelled = true;
    },
  } as unknown as ReadableStream<Uint8Array>;
  const value = {
    headers: {
      get() {
        return null;
      },
    },
    body,
  } as unknown as Response;
  return {
    value,
    cancelled: () => wasCancelled,
  };
}
