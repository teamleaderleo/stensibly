import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 25;
const collectionLimit = 24 * 1024 * 1024;
const issueLimit = 512 * 1024;
const commentLimit = 256 * 1024;

describe("GitHub provider facade per-route byte ceilings", () => {
  test("admits the exact issue-collection declaration ceiling", async () => {
    const response = await wrappedResponse(
      "https://api.github.com/repos/teamleaderleo/stensibly/issues?page=1",
      collectionLimit,
    );

    await expect(response.text()).resolves.toBe("");
  });

  test("rejects a single-issue declaration above 512 KiB", async () => {
    const response = await wrappedResponse(
      "https://api.github.com/repos/teamleaderleo/stensibly/issues/7",
      issueLimit + 1,
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("rejects a single-comment declaration above 256 KiB", async () => {
    const response = await wrappedResponse(
      "https://api.github.com/repos/teamleaderleo/stensibly/issues/comments/9",
      commentLimit + 1,
    );

    const error = await capture(response.text());
    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("applies the collection ceiling to search results", async () => {
    const response = await wrappedResponse(
      "https://api.github.com/search/issues?q=repo%3Ateamleaderleo%2Fstensibly",
      collectionLimit,
    );

    await expect(response.text()).resolves.toBe("");
  });
});

async function wrappedResponse(
  url: string,
  declaredBytes: number,
): Promise<Response> {
  const raw = {
    headers: new Headers({
      "content-length": String(declaredBytes),
    }),
    ok: true,
    status: 200,
    body: null,
  } as unknown as Response;
  const fetcher = withGitHubProviderResponseDeadline(
    (async () => raw) as unknown as typeof fetch,
    deadlineMs,
  );
  return await fetcher(url);
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected readback byte-limit rejection");
}
