export {};

declare global {
  interface ServiceWorkerGlobalScope {
    fetch(
      this: ServiceWorkerGlobalScope,
      input: string,
    ): Promise<unknown>;
  }

  const self: ServiceWorkerGlobalScope;

  function fetch(
    this: typeof globalThis | null | void,
    input: string,
  ): Promise<unknown>;
}

const url = "data:text/plain,receiver-ok";

fetch(url);
globalThis.fetch(url);
self.fetch(url);

const detached = fetch;
detached(url);
detached.call(undefined, url);
detached.call(null, url);
detached.call(globalThis, url);

// @ts-expect-error An unrelated object is not a legal Worker global receiver.
detached.call({}, url);

const holder = { fetch: detached };
// @ts-expect-error Property-call syntax supplies holder as the receiver.
holder.fetch(url);

class ReceiverFixtureClient {
  fetchImpl = fetch;

  run() {
    // @ts-expect-error The client instance is not a legal Worker global receiver.
    return this.fetchImpl(url);
  }
}

// Static methods and deliberate receiver-free overrides retain ordinary
// callback semantics.
declare namespace ReceiverFixture {
  function detachable(value: string): string;
}

const detachable = ReceiverFixture.detachable;
detachable("ok");
({ detachable }).detachable("ok");
