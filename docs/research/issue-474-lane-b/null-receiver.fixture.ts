declare const receiverBrand: unique symbol;

interface WorkerGlobalReceiver {
  readonly [receiverBrand]: "WorkerGlobalReceiver";
}

type ReceiverAwareFetch = (
  this: void | null | WorkerGlobalReceiver,
  input: string,
) => Promise<string>;

declare const receiverAwareFetch: ReceiverAwareFetch;
declare const workerGlobal: WorkerGlobalReceiver & {
  fetch: ReceiverAwareFetch;
};

const unrelated = { fetch: receiverAwareFetch };

receiverAwareFetch("https://example.test");
workerGlobal.fetch("https://example.test");
receiverAwareFetch.call(undefined, "https://example.test");
receiverAwareFetch.call(null, "https://example.test");
receiverAwareFetch.call(workerGlobal, "https://example.test");

// @ts-expect-error TS2684: unrelated holder is outside the receiver union.
unrelated.fetch("https://example.test");
// @ts-expect-error TS2345: unrelated object is outside the receiver union.
receiverAwareFetch.call({}, "https://example.test");

type ExtractedReceiver = ThisParameterType<ReceiverAwareFetch>;
const bareReceiver: ExtractedReceiver = undefined;
const nullReceiver: ExtractedReceiver = null;
const ownerReceiver: ExtractedReceiver = workerGlobal;
// @ts-expect-error TS2741: missing receiver brand.
const unrelatedReceiver: ExtractedReceiver = {};

void bareReceiver;
void nullReceiver;
void ownerReceiver;
void unrelatedReceiver;
