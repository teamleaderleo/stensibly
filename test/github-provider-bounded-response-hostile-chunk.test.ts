import { describe, expect, test } from "bun:test";
import {
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";

class HostileChunk extends Uint8Array {
  override slice(): Uint8Array {
    throw new Error("virtual slice must not execute");
  }
}

describe("bounded GitHub provider chunk detachment", () => {
  test("copies a Uint8Array subclass without invoking its virtual slice", async () => {
    const bytes = new TextEncoder().encode('[{"name":"area:github"}]');
    const chunk = new HostileChunk(bytes.byteLength);
    chunk.set(bytes);
    let delivered = false;
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return {
            async read() {
              if (delivered) return { done: true as const, value: undefined };
              delivered = true;
              return { done: false as const, value: chunk };
            },
            cancel() {},
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(
      readBoundedGitHubProviderResponseText(response, 512 * 1024),
    ).resolves.toBe('[{"name":"area:github"}]');
  });

  test("cancels without awaiting when reader acquisition throws", async () => {
    let cancelled = false;
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          throw new Error("synthetic reader acquisition failure");
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      },
    } as unknown as Response;

    await expect(
      readBoundedGitHubProviderResponseText(response, 512 * 1024),
    ).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
    expect(cancelled).toBe(true);
  });
});
