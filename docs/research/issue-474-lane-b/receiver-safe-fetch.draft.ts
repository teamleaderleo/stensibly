type FetchInput = string;
type FetchResult = Promise<string>;
type FetchLike = (input: FetchInput) => FetchResult;

const receiverSafeFetchBrand: unique symbol = Symbol("receiver-safe-fetch");

export type ReceiverSafeFetch = FetchLike & {
  readonly [receiverSafeFetchBrand]: true;
};

/**
 * Converts any legally bare-callable fetch implementation into an arrow wrapper.
 * Property calls on the returned function cannot forward the holder as `this`.
 */
export function makeReceiverSafeFetch(fetchImpl: FetchLike): ReceiverSafeFetch {
  const wrapped = ((input: FetchInput) => fetchImpl(input)) as ReceiverSafeFetch;
  Object.defineProperty(wrapped, receiverSafeFetchBrand, {
    value: true,
    enumerable: false,
  });
  return wrapped;
}

const injected = makeReceiverSafeFetch(async (input) => input);
const holder = { fetch: injected };
void holder.fetch("https://example.test");
