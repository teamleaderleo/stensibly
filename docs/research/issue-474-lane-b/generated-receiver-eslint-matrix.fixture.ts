declare const receiverBrand: unique symbol;

interface ServiceWorkerGlobalScopeFixture {
  readonly [receiverBrand]: "ServiceWorkerGlobalScopeFixture";
  fetch(
    this: ServiceWorkerGlobalScopeFixture | typeof globalThis | null | void,
    input: string,
  ): Promise<string>;
}

type ReceiverAwareFetch = ServiceWorkerGlobalScopeFixture["fetch"];
type PlainFetch = (input: string) => Promise<string>;

declare const self: ServiceWorkerGlobalScopeFixture;
declare function fetch(
  this: ServiceWorkerGlobalScopeFixture | typeof globalThis | null | void,
  input: string,
): Promise<string>;
declare function acceptsPlain(callback: PlainFetch): void;
declare function acceptsAware(callback: ReceiverAwareFetch): void;

// G01 bare global call: accepted.
fetch("bare");

// G02 actual global property call: accepted.
globalThis.fetch("global");

// G03 self property call: accepted.
self.fetch("self");

// G04 unrelated property call with the precise type: rejected by TypeScript.
const preciseHolder = { fetch };
// @ts-expect-error TS2684: unrelated holder is outside the receiver union.
preciseHolder.fetch("wrong owner");

class PlainSink {
  fetchImpl: PlainFetch = async input => input;

  // G05 bare assignment into a plain callback property: receiver is erased.
  installBare(): void {
    this.fetchImpl = fetch;
  }

  // G06 self-member assignment into a plain callback property: receiver is erased.
  installMember(): void {
    this.fetchImpl = self.fetch;
  }

  run(): Promise<string> {
    return this.fetchImpl("stored");
  }
}

// G07 inferred object literal preserves the precise receiver.
const inferredObject = { fetchImpl: fetch };
// @ts-expect-error TS2684: inferred property retains ReceiverAwareFetch.
inferredObject.fetchImpl("inferred");

// G08 contextual object literal widens to a plain callback.
const widenedObject: { fetchImpl: PlainFetch } = { fetchImpl: fetch };
widenedObject.fetchImpl("widened object");

// G09 inferred self-member object preserves the precise receiver.
const memberObject = { fetchImpl: self.fetch };
// @ts-expect-error TS2684: property retains ReceiverAwareFetch.
memberObject.fetchImpl("member object");

// G10 contextually widened self-member object erases the receiver.
const widenedMemberObject: { fetchImpl: PlainFetch } = {
  fetchImpl: self.fetch,
};
widenedMemberObject.fetchImpl("widened member object");

// G11 destructuring self.fetch permits legal bare detachment.
const { fetch: destructuredFetch } = self;
destructuredFetch("destructured bare");

// G12 moving that precise detached value onto an unrelated holder is rejected.
const destructuredHolder = { fetch: destructuredFetch };
// @ts-expect-error TS2684: unrelated holder is outside the receiver union.
destructuredHolder.fetch("destructured holder");

// G13 bare callback parameter widening erases the receiver.
acceptsPlain(fetch);

// G14 self-member callback parameter widening erases the receiver.
acceptsPlain(self.fetch);

// G15 receiver-aware callback parameter preserves the contract.
acceptsAware(fetch);

// G16 explicit widening variable from the bare global erases the receiver.
const widenedBare: PlainFetch = fetch;
const widenedBareHolder = { fetch: widenedBare };
widenedBareHolder.fetch("widened bare");

// G17 explicit widening variable from self.fetch erases the receiver.
const widenedMember: PlainFetch = self.fetch;
const widenedMemberHolder = { fetch: widenedMember };
widenedMemberHolder.fetch("widened member");

// G18 bind accepts every runtime-legal receiver.
const boundUndefined = fetch.bind(undefined);
const boundNull = fetch.bind(null);
const boundGlobal = fetch.bind(globalThis);
const boundSelf = fetch.bind(self);
boundUndefined("bound undefined");
boundNull("bound null");
boundGlobal("bound global");
boundSelf("bound self");

// G19 bind rejects an unrelated receiver.
// @ts-expect-error TS2345: unrelated receiver is outside the receiver union.
const boundWrong = fetch.bind({});

// G20 binding the self member to self is accepted.
const boundMember = self.fetch.bind(self);
boundMember("bound member");

// G21 call accepts undefined, null, globalThis, and self.
fetch.call(undefined, "call undefined");
fetch.call(null, "call null");
fetch.call(globalThis, "call global");
fetch.call(self, "call self");

// G22 call rejects an unrelated receiver; self-member call through self is legal.
// @ts-expect-error TS2345: unrelated receiver is outside the receiver union.
fetch.call({}, "call wrong");
self.fetch.call(self, "member call owner");

void PlainSink;
void boundWrong;
