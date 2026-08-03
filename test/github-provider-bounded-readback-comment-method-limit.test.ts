import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 25;
const commentLimit = 256 * 1024;
const issueCommentCollectionUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues/958/comments";
const singleCommentUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues/comments/123";

describe("GitHub provider facade comment method ceilings", () => {
  test("uses the comment ceiling for POST comment responses", async () => {
    for (const method of ["POST", "post"] as const) {
      const response = await wrappedResponse(
        issueCommentCollectionUrl,
        commentLimit + 1,
        { method },
      );

      await expect(response.text()).rejects.toThrow(
        "GitHub provider response could not be read within its bounds",
      );
    }
  });

  test("uses RequestInit method override when a Request says GET", async () => {
    const request = new Request(issueCommentCollectionUrl, {
      method: "GET",
    });
    const response = await wrappedResponse(
      request,
      commentLimit + 1,
      { method: "POST" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("keeps the same ceiling for one GET comment", async () => {
    const response = await wrappedResponse(
      singleCommentUrl,
      commentLimit + 1,
      { method: "GET" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("admits an exact-bound POST comment response", async () => {
    const response = await wrappedResponse(
      issueCommentCollectionUrl,
      commentLimit,
      { method: "POST" },
    );

    await expect(response.text()).resolves.toBe("");
  });
});

async function wrappedResponse(
  input: RequestInfo | URL,
  declaredBytes: number,
  init?: RequestInit,
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
  return await fetcher(input, init);
}
