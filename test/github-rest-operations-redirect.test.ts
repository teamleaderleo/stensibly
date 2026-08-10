import { describe, expect, test } from "bun:test";
import { githubOperationRedirectFetch } from "../src/github-operation-redirect-fetch.js";

const api = "https://api.github.test/repos/teamleaderleo/stensibly/git/ref/heads/main";

describe("hosted GitHub operation redirect fetch", () => {
  test("follows a bounded same-origin read redirect manually", async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined; authorization: string | null }> = [];
    const fetchImpl = githubOperationRedirectFetch((async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        redirect: init?.redirect,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (requests.length === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: "/repos/teamleaderleo/stensibly/git/refs/heads/main" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch);

    const response = await fetchImpl(api, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer installation-token" },
    });

    expect(response.status).toBe(200);
    expect(requests).toEqual([
      {
        url: api,
        redirect: "manual",
        authorization: "Bearer installation-token",
      },
      {
        url: "https://api.github.test/repos/teamleaderleo/stensibly/git/refs/heads/main",
        redirect: "manual",
        authorization: "Bearer installation-token",
      },
    ]);
  });

  test("rejects a cross-origin redirect before forwarding authorization", async () => {
    const urls: string[] = [];
    const fetchImpl = githubOperationRedirectFetch((async (input) => {
      urls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.test/collect" },
      });
    }) as typeof fetch);

    await expect(fetchImpl(api, {
      method: "GET",
      headers: { Authorization: "Bearer installation-token" },
    })).rejects.toThrow("GitHub operation provider redirect was rejected");
    expect(urls).toEqual([api]);
  });

  test("rejects write redirects before a second provider request", async () => {
    let requests = 0;
    const fetchImpl = githubOperationRedirectFetch((async () => {
      requests += 1;
      return new Response(null, {
        status: 307,
        headers: { location: "/repos/teamleaderleo/stensibly/pulls/42/merge" },
      });
    }) as unknown as typeof fetch);

    await expect(fetchImpl("https://api.github.test/repos/teamleaderleo/stensibly/pulls/42/merge", {
      method: "PUT",
      body: "{}",
    })).rejects.toThrow("GitHub operation provider redirect was rejected");
    expect(requests).toBe(1);
  });
});
