import { receiverSafeFetch } from "./fetch-implementation.js";

const maximumRedirects = 2;
const boundRepositoryPath = /^\/repos\/[^/]+\/[^/]+(\/.*)$/u;
const canonicalRepositoryPath = /^\/repositories\/[1-9]\d*(\/.*)$/u;

/**
 * Adapt hosted GitHub operation requests to Cloudflare's redirect semantics.
 * Reads may follow a tiny same-origin chain. Writes never follow redirects.
 * Canonical numeric-repository pagination links are rebound onto the accepted
 * repository route before the operations adapter validates page/query drift.
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
      if (response.status < 300 || response.status > 399) {
        return method === "GET"
          ? rebindCanonicalRepositoryPagination(response, initial, origin)
          : response;
      }

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

function rebindCanonicalRepositoryPagination(
  response: Response,
  acceptedRequest: URL,
  origin: string,
): Response {
  const link = response.headers.get("link");
  const bound = boundRepositoryPath.exec(acceptedRequest.pathname);
  if (!link || !bound) return response;

  const rewritten = link.replace(/<([^>]+)>/gu, (entry, target: string) => {
    let url: URL;
    try {
      url = new URL(target, acceptedRequest);
    } catch {
      return entry;
    }
    if (url.origin !== origin || url.username || url.password || url.hash) return entry;
    const canonical = canonicalRepositoryPath.exec(url.pathname);
    if (!canonical || canonical[1] !== bound[1]) return entry;
    url.pathname = acceptedRequest.pathname;
    return `<${url.toString()}>`;
  });
  if (rewritten === link) return response;

  const headers = new Headers(response.headers);
  headers.set("link", rewritten);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
