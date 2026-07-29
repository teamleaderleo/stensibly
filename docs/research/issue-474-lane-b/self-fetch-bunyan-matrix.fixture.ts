declare const receiverBrand: unique symbol;

interface ServiceWorkerGlobalScopeFixture {
  readonly [receiverBrand]: "ServiceWorkerGlobalScopeFixture";
  fetch(
    this: ServiceWorkerGlobalScopeFixture | typeof globalThis | null | void,
    input: string,
  ): Promise<string>;
}

type ContextGlobalFetch = ServiceWorkerGlobalScopeFixture["fetch"];

declare const self: ServiceWorkerGlobalScopeFixture;
declare const fetch: ContextGlobalFetch;

const url = "data:text/plain,receiver-ok";

// Both declaration surfaces must expose the same context-global receiver policy.
fetch(url);
self.fetch(url);

const fromSelf = self.fetch;

// Bunyan runtime matrix: detached direct call succeeds.
fromSelf(url);

// Bunyan runtime matrix: call(undefined/null/globalThis) succeeds.
fromSelf.call(undefined, url);
fromSelf.call(null, url);
fromSelf.call(globalThis, url);

// Bunyan runtime matrix: call(unrelated) throws Illegal invocation.
// @ts-expect-error TS2345: unrelated receiver is outside the context-global union.
fromSelf.call({}, url);

// Bunyan runtime matrix: an unrelated property holder throws Illegal invocation.
const unrelatedHolder = { fetch: fromSelf };
// @ts-expect-error TS2684: property-call syntax supplies unrelatedHolder as this.
unrelatedHolder.fetch(url);

// Bunyan runtime matrix: apply(undefined/null/globalThis) succeeds.
fromSelf.apply(undefined, [url]);
fromSelf.apply(null, [url]);
fromSelf.apply(globalThis, [url]);

// Bunyan runtime matrix: apply(unrelated) throws Illegal invocation.
// @ts-expect-error TS2345: unrelated receiver is outside the context-global union.
fromSelf.apply({}, [url]);

// Bunyan runtime matrix: bind(undefined/null/globalThis), then invoke, succeeds.
fromSelf.bind(undefined)(url);
fromSelf.bind(null)(url);
fromSelf.bind(globalThis)(url);

// Bunyan runtime matrix: bind(unrelated), then invoke, throws Illegal invocation.
// The declaration rejects the invalid receiver earlier, at bind time.
// @ts-expect-error TS2345: unrelated receiver is outside the context-global union.
fromSelf.bind({})(url);

// Contextual widening is intentionally a separate lint/provenance limitation.
type PlainFetch = (input: string) => Promise<string>;
const widened: PlainFetch = fromSelf;
({ fetch: widened }).fetch(url);
