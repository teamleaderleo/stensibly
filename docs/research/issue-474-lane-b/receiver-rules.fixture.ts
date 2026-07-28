declare const receiverBrand: unique symbol;

type Input = string;
type Result = Promise<string>;

interface WorkerGlobalReceiver {
  readonly [receiverBrand]: "WorkerGlobalReceiver";
}

interface EmptyReceiver {}

type PlainFetch = (input: Input) => Result;
type OwnerOnlyFetch = (this: WorkerGlobalReceiver, input: Input) => Result;
type GlobalFetch = (
  this: void | WorkerGlobalReceiver,
  input: Input,
) => Result;
type EmptyReceiverFetch = (
  this: void | EmptyReceiver,
  input: Input,
) => Result;

interface CallableGlobalFetch {
  (this: void | WorkerGlobalReceiver, input: Input): Result;
}

interface OverloadedGlobalFetch {
  (this: void, input: Input): Result;
  (this: WorkerGlobalReceiver, input: Input): Result;
}

type IntersectedGlobalFetch =
  & ((this: void, input: Input) => Result)
  & ((this: WorkerGlobalReceiver, input: Input) => Result);

type UnionGlobalFetch =
  | ((this: void, input: Input) => Result)
  | ((this: WorkerGlobalReceiver, input: Input) => Result);

type ThisTypeAttempt = PlainFetch & ThisType<WorkerGlobalReceiver>;

declare const ownerOnlyFetch: OwnerOnlyFetch;
declare const globalFetch: GlobalFetch;
declare const emptyReceiverFetch: EmptyReceiverFetch;
declare const callableGlobalFetch: CallableGlobalFetch;
declare const overloadedGlobalFetch: OverloadedGlobalFetch;
declare const intersectedGlobalFetch: IntersectedGlobalFetch;
declare const unionGlobalFetch: UnionGlobalFetch;
declare const thisTypeFetch: ThisTypeAttempt;

declare const workerGlobal: WorkerGlobalReceiver & {
  ownerOnlyFetch: OwnerOnlyFetch;
  globalFetch: GlobalFetch;
  callableGlobalFetch: CallableGlobalFetch;
  overloadedGlobalFetch: OverloadedGlobalFetch;
  intersectedGlobalFetch: IntersectedGlobalFetch;
  unionGlobalFetch: UnionGlobalFetch;
};

const unrelated = {
  ownerOnlyFetch,
  globalFetch,
  emptyReceiverFetch,
  callableGlobalFetch,
  overloadedGlobalFetch,
  intersectedGlobalFetch,
  unionGlobalFetch,
  thisTypeFetch,
};

// Explicit owner-only receiver rejects a bare call and an unrelated owner.
// @ts-expect-error TS2684: bare call supplies void.
ownerOnlyFetch("https://example.test");
workerGlobal.ownerOnlyFetch("https://example.test");
// @ts-expect-error TS2684: unrelated lacks the receiver brand.
unrelated.ownerOnlyFetch("https://example.test");

// A single union receiver expresses the target global call matrix.
globalFetch("https://example.test");
workerGlobal.globalFetch("https://example.test");
// @ts-expect-error TS2684: unrelated is neither void nor the owning global.
unrelated.globalFetch("https://example.test");

// A callable interface containing the same signature behaves identically.
callableGlobalFetch("https://example.test");
workerGlobal.callableGlobalFetch("https://example.test");
// @ts-expect-error TS2684.
unrelated.callableGlobalFetch("https://example.test");

// An empty interface is structurally satisfied by the unrelated object.
emptyReceiverFetch("https://example.test");
unrelated.emptyReceiverFetch("https://example.test"); // Incorrectly accepted.

// Separate overloads and callable intersections admit the unrelated call through
// their this:void signature.
overloadedGlobalFetch("https://example.test");
workerGlobal.overloadedGlobalFetch("https://example.test");
unrelated.overloadedGlobalFetch("https://example.test"); // Incorrectly accepted.

intersectedGlobalFetch("https://example.test");
workerGlobal.intersectedGlobalFetch("https://example.test");
unrelated.intersectedGlobalFetch("https://example.test"); // Incorrectly accepted.

// A union of callable types requires a receiver valid for every constituent.
// @ts-expect-error TS2684: inferred receiver requirement is void & WorkerGlobalReceiver.
unionGlobalFetch("https://example.test");
// @ts-expect-error TS2684.
workerGlobal.unionGlobalFetch("https://example.test");
// @ts-expect-error TS2684.
unrelated.unionGlobalFetch("https://example.test");

// ThisType only supplies contextual this inside object literals; it adds no call-site rule.
unrelated.thisTypeFetch("https://example.test"); // Incorrectly accepted.

// Receiver erasure through widening.
const widened: PlainFetch = globalFetch;
const callbackHolder = { fetch: widened };
callbackHolder.fetch("https://example.test"); // Incorrectly accepted.

const omitted: OmitThisParameter<GlobalFetch> = globalFetch;
const omittedHolder = { fetch: omitted };
omittedHolder.fetch("https://example.test"); // Explicitly receiver-free.

type ExtractedReceiver = ThisParameterType<GlobalFetch>;
const legalBareReceiver: ExtractedReceiver = undefined;
const legalOwnerReceiver: ExtractedReceiver = workerGlobal;
// @ts-expect-error TS2741: unrelated lacks the receiver brand.
const illegalReceiver: ExtractedReceiver = unrelated;

// A brand on the raw function records provenance but still widens away.
declare const rawHostFetchBrand: unique symbol;
type BrandedRawHostFetch = GlobalFetch & {
  readonly [rawHostFetchBrand]: "raw-host-fetch";
};
declare const brandedRawHostFetch: BrandedRawHostFetch;
const widenedBrandedRaw: PlainFetch = brandedRawHostFetch;
const brandedHolder = { fetch: widenedBrandedRaw };
brandedHolder.fetch("https://example.test"); // Incorrectly accepted.

// Application-owned safe wrapper brand.
declare const safeFetchBrand: unique symbol;
type ReceiverSafeFetch = PlainFetch & {
  readonly [safeFetchBrand]: "receiver-safe-fetch";
};
declare function makeReceiverSafeFetch(fetchImpl: PlainFetch): ReceiverSafeFetch;

const safeFetch = makeReceiverSafeFetch(globalFetch);
const safeHolder = { fetch: safeFetch };
safeHolder.fetch("https://example.test");
makeReceiverSafeFetch(async (input) => input); // Test injection remains easy.

// @ts-expect-error TS2322: raw host fetch lacks the safe-wrapper brand.
const rejectsRaw: ReceiverSafeFetch = globalFetch;
// @ts-expect-error TS2322: plain callback lacks the safe-wrapper brand.
const rejectsPlain: ReceiverSafeFetch = widened;

void legalBareReceiver;
void legalOwnerReceiver;
void illegalReceiver;
void rejectsRaw;
void rejectsPlain;
