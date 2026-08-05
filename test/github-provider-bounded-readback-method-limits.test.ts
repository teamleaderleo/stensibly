import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const deadlineMs = 25;
const collectionLimit = 24 * 1024 * 1024;
const issueLimit = 512 * 1024;
const issueCollectionUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues";

describe("GitHub provider facade method-sensitive route ceilings", () => {
  test("keeps the collection ceiling for GET issue pages", async () => {
    for (const init of [undefined, { method: "get" } satisfies RequestInit]) {
      const response = await wrappedResponse(
        issueCollectionUrl,
        collectionLimit,
        init,
      );

      await expect(response.text()).resolves.toBe("");
    }
  });

  test("uses the single-issue ceiling for POST create responses", async () => {
    const response = await wrappedResponse(
      issueCollectionUrl,
      issueLimit + 1,
      { method: "POST" },
    );

    await expect(response.text()).rejects.toThrow(
      "GitHub provider response could not be read within its bounds",
    );
  });

  test("uses the single-issue ceiling for a POST Request input", async () => {
    const request = new Request(issueCollectionUrl, { method: "POST" });
    const response = await wrappedResponse(request, issueLimit + 1);

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
