import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 25;
const commentLimit = 256 * 1024;
const commentCollectionUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues/42/comments";
const commentReadUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues/comments/99";

describe("GitHub provider facade comment response ceilings", () => {
  test("uses the comment ceiling for string URL POST creation", async () => {
    const response = await wrappedResponse(
      commentCollectionUrl,
      commentLimit + 1,
      { method: "POST" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("uses the comment ceiling for native Request POST creation", async () => {
    const request = new Request(commentCollectionUrl, { method: "POST" });
    const response = await wrappedResponse(request, commentLimit + 1);

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("retains the comment ceiling for GET comment readback", async () => {
    const response = await wrappedResponse(
      commentReadUrl,
      commentLimit + 1,
      { method: "GET" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("admits the exact comment ceiling for creation", async () => {
    const response = await wrappedResponse(
      commentCollectionUrl,
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
