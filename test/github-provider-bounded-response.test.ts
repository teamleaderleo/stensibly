import { describe, expect, test } from "bun:test";
import {
  GITHUB_PROVIDER_RESPONSE_READ_FAILED,
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";

const secret = `github_pat_${"s".repeat(32)}`;

describe("bounded GitHub provider response reader", () => {
  test("reads one valid multi-chunk UTF-8 body and detaches chunks", async () => {
    const first = new TextEncoder().encode("hello ");
    const second = new TextEncoder().encode("world");
    const response = streamResponse([first, second], {
      "content-length": String(first.byteLength + second.byteLength),
    });

    const text = await readBoundedGitHubProviderResponseText(response, 64);
    first.fill(0);
    second.fill(0);

    expect(text).toBe("hello world");
  });

  test("rejects malformed and unsafe declared lengths before body reads", async () => {
    for (const declared of ["12x", "-1", "1.5", "9007199254740993", "65"]) {
      const state = { pulls: 0, cancellations: 0 };
      const response = trackedStreamResponse(
        [new TextEncoder().encode(secret)],
        state,
        { "content-length": declared },
      );

      await expectFixedFailure(
        readBoundedGitHubProviderResponseText(response, 64),
      );
      expect(state.pulls).toBe(0);
      expect(state.cancellations).toBe(1);
    }
  });

  test("cancels absent-length streams immediately after absolute overflow", async () => {
    const state = { pulls: 0, cancellations: 0 };
    const response = trackedStreamResponse([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new TextEncoder().encode(secret),
    ], state);

    await expectFixedFailure(
      readBoundedGitHubProviderResponseText(response, 5),
    );
    expect(state.pulls).toBe(2);
    expect(state.cancellations).toBe(1);
  });

  test("cancels when streamed bytes exceed an understated declaration", async () => {
    const state = { pulls: 0, cancellations: 0 };
    const response = trackedStreamResponse([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new TextEncoder().encode(secret),
    ], state, { "content-length": "3" });

    await expectFixedFailure(
      readBoundedGitHubProviderResponseText(response, 64),
    );
    expect(state.pulls).toBe(2);
    expect(state.cancellations).toBe(1);
  });

  test("rejects an overstated declaration after bounded end-of-stream", async () => {
    const response = streamResponse(
      [new Uint8Array([1, 2, 3])],
      { "content-length": "4" },
    );

    await expectFixedFailure(
      readBoundedGitHubProviderResponseText(response, 64),
    );
  });

  test("rejects invalid UTF-8 and an absent body with fixed prose", async () => {
    await expectFixedFailure(
      readBoundedGitHubProviderResponseText(
        streamResponse([new Uint8Array([0xc3, 0x28])]),
        64,
      ),
    );
    await expectFixedFailure(
      readBoundedGitHubProviderResponseText(new Response(null), 64),
    );
  });

  test("rejects an invalid caller byte ceiling", async () => {
    await expect(
      readBoundedGitHubProviderResponseText(new Response("ok"), -1),
    ).rejects.toThrow("byte limit is invalid");
  });
});

async function expectFixedFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected bounded provider response failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(GITHUB_PROVIDER_RESPONSE_READ_FAILED);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
}

function streamResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }), { headers });
}

function trackedStreamResponse(
  chunks: readonly Uint8Array[],
  state: { pulls: number; cancellations: number },
  headers: Record<string, string> = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancellations += 1;
    },
  }), { headers });
}
