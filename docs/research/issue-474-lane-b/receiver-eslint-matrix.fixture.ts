declare const receiverBrand: unique symbol;

interface WorkerGlobalReceiver {
  readonly [receiverBrand]: "WorkerGlobalReceiver";
  fetch(
    this: void | null | WorkerGlobalReceiver,
    input: string,
  ): Promise<string>;
}

type ReceiverAwareFetch = WorkerGlobalReceiver["fetch"];
type PlainFetch = (input: string) => Promise<string>;

declare const workerGlobal: WorkerGlobalReceiver;
declare const fetch: ReceiverAwareFetch;
declare function acceptsPlain(callback: PlainFetch): void;
declare function acceptsAware(callback: ReceiverAwareFetch): void;

// T01 bare global call: TypeScript accepts; ESLint has no member reference.
fetch("bare");

// T02 owning-global property call: TypeScript accepts; ESLint treats direct calls as safe.
workerGlobal.fetch("owner");

// T03 unrelated property call with precise type: TypeScript rejects; ESLint treats direct calls as safe.
const preciseHolder = { fetch };
// @ts-expect-error TS2684: unrelated holder is outside the receiver union.
preciseHolder.fetch("wrong owner");

class PlainSink {
  fetchImpl: PlainFetch = async input => input;

  // T04 bare assignment into plain callback property: TypeScript permits receiver erasure; ESLint sees only an identifier.
  installBare(): void {
    this.fetchImpl = fetch;
  }

  // T05 owner-member assignment into plain callback property: TypeScript permits receiver erasure; unbound-method sees the member extraction.
  installMember(): void {
    this.fetchImpl = workerGlobal.fetch;
  }

  run(): Promise<string> {
    return this.fetchImpl("stored");
  }
}

// T06 inferred object literal preserves receiver: TypeScript rejects later unrelated property call; ESLint sees only bare identifier creation.
const inferredObject = { fetchImpl: fetch };
// @ts-expect-error TS2684: inferred property retains ReceiverAwareFetch.
inferredObject.fetchImpl("inferred");

// T07 contextual object literal widens receiver: TypeScript permits later property call; ESLint sees only bare identifier creation.
const widenedObject: { fetchImpl: PlainFetch } = { fetchImpl: fetch };
widenedObject.fetchImpl("widened object");

// T08 owner-member object literal: TypeScript preserves receiver and rejects later property call; unbound-method sees extraction.
const memberObject = { fetchImpl: workerGlobal.fetch };
// @ts-expect-error TS2684: property retains ReceiverAwareFetch.
memberObject.fetchImpl("member object");

// T09 contextually widened owner-member object literal: TypeScript permits later property call; unbound-method sees extraction.
const widenedMemberObject: { fetchImpl: PlainFetch } = {
  fetchImpl: workerGlobal.fetch,
};
widenedMemberObject.fetchImpl("widened member object");

// T10 destructuring owner method: TypeScript accepts detached bare call because void/null are legal; unbound-method reports the extraction.
const { fetch: destructuredFetch } = workerGlobal;
destructuredFetch("destructured bare");

// T11 destructured value moved to unrelated holder: TypeScript rejects while precise; unbound-method already reports destructuring.
const destructuredHolder = { fetch: destructuredFetch };
// @ts-expect-error TS2684: unrelated holder is outside the receiver union.
destructuredHolder.fetch("destructured holder");

// T12 bare callback parameter widening: TypeScript permits receiver erasure; ESLint sees only an identifier.
acceptsPlain(fetch);

// T13 owner-member callback parameter widening: TypeScript permits receiver erasure; unbound-method reports extraction.
acceptsPlain(workerGlobal.fetch);

// T14 receiver-aware callback parameter: TypeScript preserves the contract; ESLint sees only a bare identifier.
acceptsAware(fetch);

// T15 explicit widening variable from bare global: TypeScript permits receiver erasure; ESLint sees only an identifier.
const widenedBare: PlainFetch = fetch;
const widenedBareHolder = { fetch: widenedBare };
widenedBareHolder.fetch("widened bare");

// T16 explicit widening variable from owner member: TypeScript permits receiver erasure; unbound-method reports extraction.
const widenedMember: PlainFetch = workerGlobal.fetch;
const widenedMemberHolder = { fetch: widenedMember };
widenedMemberHolder.fetch("widened member");

// T17 bind legal bare receivers: TypeScript accepts; unbound-method does not report bind use.
const boundUndefined = fetch.bind(undefined);
const boundNull = fetch.bind(null);
const boundOwner = fetch.bind(workerGlobal);
boundUndefined("bound undefined");
boundNull("bound null");
boundOwner("bound owner");

// T18 bind unrelated receiver: TypeScript rejects under strictBindCallApply; ESLint does not report bind use.
// @ts-expect-error TS2345: unrelated receiver is outside the receiver union.
const boundWrong = fetch.bind({});

// T19 owner-member bind to owner: TypeScript accepts; unbound-method treats chained .bind as safe.
const boundMember = workerGlobal.fetch.bind(workerGlobal);
boundMember("bound member");

// T20 call legal receivers: TypeScript accepts; unbound-method has no member extraction for bare fetch.
fetch.call(undefined, "call undefined");
fetch.call(null, "call null");
fetch.call(workerGlobal, "call owner");

// T21 call unrelated receiver: TypeScript rejects; unbound-method does not add a diagnostic.
// @ts-expect-error TS2345: unrelated receiver is outside the receiver union.
fetch.call({}, "call wrong");

// T22 owner-member call with legal receiver: TypeScript accepts; unbound-method treats chained .call as safe.
workerGlobal.fetch.call(workerGlobal, "member call owner");

void PlainSink;
void boundWrong;
