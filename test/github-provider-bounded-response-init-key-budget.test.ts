import { expect, test } from "bun:test";
import { withGitHubProviderResponseDeadline } from "../src/github-provider-bounded-response.ts";

const issueCollectionUrl =
  "https://api.github.com/repos/teamleaderleo/stensibly/issues";

test("snapshots declared RequestInit fields without caller key enumeration", async () => {
  let ownKeysCalls = 0;
  let decorationReads = 0;
  let fetchCalls = 0;
  let dispatchedMethod: unknown;
  let dispatchedHeaders: unknown;

  const target = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(target, "method", {
    value: "GET",
    enumerable: true,
  });
  const headers = new Headers({ accept: "application/json" });
  Object.defineProperty(target, "headers", {
    value: headers,
    enumerable: true,
  });
  Object.defineProperty(target, "decoration", {
    enumerable: true,
    get() {
      decorationReads += 1;
      throw new Error("RequestInit decoration must remain unreachable");
    },
  });
  const init = new Proxy(target, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("RequestInit ownKeys must remain unreachable");
    },
  });

  const wrapped = withGitHubProviderResponseDeadline(
    (async (_input, dispatchInit) => {
      fetchCalls += 1;
      dispatchedMethod = dispatchInit?.method;
      dispatchedHeaders = dispatchInit?.headers;
      return {
        headers: new Headers({ "content-length": "0" }),
        ok: true,
        status: 200,
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch,
    120_000,
  );

  const response = await wrapped(
    issueCollectionUrl,
    init as unknown as RequestInit,
  );
  await expect(response.text()).resolves.toBe("");

  expect(fetchCalls).toBe(1);
  expect(dispatchedMethod).toBe("GET");
  expect(dispatchedHeaders).toBe(headers);
  expect(ownKeysCalls).toBe(0);
  expect(decorationReads).toBe(0);
});
