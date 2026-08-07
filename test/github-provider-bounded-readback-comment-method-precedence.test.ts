import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 25;
const commentLimit = 256 * 1024;
const commentCollectionUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues/958/comments";

describe("GitHub provider facade comment method precedence", () => {
  test("normalizes lowercase POST for comment creation", async () => {
    const response = await wrappedResponse(
      commentCollectionUrl,
      commentLimit + 1,
      { method: "post" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("lets RequestInit POST override a Request whose method is GET", async () => {
    const request = new Request(commentCollectionUrl, { method: "GET" });
    const response = await wrappedResponse(
      request,
      commentLimit + 1,
      { method: "POST" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
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
