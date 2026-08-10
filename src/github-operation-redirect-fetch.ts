import { receiverSafeFetch } from "./fetch-implementation.js";

const maximumRedirects = 2;

/**
 * Adapt hosted GitHub operation requests to Cloudflare's redirect semantics.
 * Reads may follow a tiny same-origin chain. Writes never follow redirects.
 */
export function githubOperationRedirectFetch(fetchImpl?: typeof fetch): typeof fetch {
  const dispatch = receiverSafeFetch(fetchImpl);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const initial = requestUrl(input);
    const origin = initial.origin;
    const method = (init?.method ?? "GET").toUpperCase();
    let current = initial;

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await dispatch(current, { ...init, redirect: "manual" });
      if (response.status < 300 || response.status > 399) return response;

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (method !== "GET" || location === null || redirectCount >= maximumRedirects) {
        throw new TypeError("GitHub operation provider redirect was rejected");
      }
      current = admittedRedirect(location, current, origin);
    }
  }) as typeof fetch;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.toString());
  return new URL(input.url);
}

function admittedRedirect(location: string, current: URL, origin: string): URL {
  const next = new URL(location, current);
  if (next.origin !== origin || next.username || next.password || next.hash) {
    throw new TypeError("GitHub operation provider redirect was rejected");
  }
  return next;
}
