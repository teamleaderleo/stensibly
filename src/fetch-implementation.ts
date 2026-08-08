/**
 * Wrap a fetch implementation so callers cannot accidentally rebind a
 * Web-IDL receiver by storing it on a class or object.
 */
export function receiverSafeFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input, init)) as typeof fetch;
  }
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch;
}
