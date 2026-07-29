const FORMS = {
  bare: "fetch(url)",
  global: "globalThis.fetch(url)",
  self: "self.fetch(url)",
  detached: "detached(url)",
  undefinedReceiver: "detached.call(undefined, url)",
  globalReceiver: "detached.call(globalThis, url)",
  unrelatedReceiver: "detached.call({}, url)",
  holder: "holder.fetch(url)",
};

const SELF_FORMS = {
  detached: "fromSelf(url)",
  callUndefined: "fromSelf.call(undefined, url)",
  callNull: "fromSelf.call(null, url)",
  callGlobal: "fromSelf.call(globalThis, url)",
  callUnrelated: "fromSelf.call({}, url)",
  holder: "({ fetch: fromSelf }).fetch(url)",
  applyUndefined: "fromSelf.apply(undefined, [url])",
  applyNull: "fromSelf.apply(null, [url])",
  applyGlobal: "fromSelf.apply(globalThis, [url])",
  applyUnrelated: "fromSelf.apply({}, [url])",
  bindUndefined: "fromSelf.bind(undefined)(url)",
  bindNull: "fromSelf.bind(null)(url)",
  bindGlobal: "fromSelf.bind(globalThis)(url)",
  bindUnrelated: "fromSelf.bind({})(url)",
};

export const WORKERD_ILLEGAL_INVOCATION_ERROR =
  "TypeError: Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.";

export const FETCH_RECEIVER_FORMS = Object.freeze(Object.values(FORMS));
export const SELF_FETCH_RECEIVER_FORMS = Object.freeze(Object.values(SELF_FORMS));

function unavailable(form, error) {
  return {
    form,
    outcome: "unavailable",
    error: String(error),
  };
}

async function invoke(form, call) {
  try {
    const response = await call();
    return {
      form,
      outcome: "response",
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    return {
      form,
      outcome: "error",
      error: String(error),
    };
  }
}

export async function runFetchReceiverMatrix(
  url = "data:text/plain,receiver-ok",
) {
  const detached = fetch;
  const holder = { fetch: detached };
  const results = [];

  results.push(await invoke(FORMS.bare, () => fetch(url)));
  results.push(await invoke(FORMS.global, () => globalThis.fetch(url)));

  if (typeof self === "undefined") {
    results.push(unavailable(FORMS.self, new ReferenceError("self is not defined")));
  } else {
    results.push(await invoke(FORMS.self, () => self.fetch(url)));
  }

  results.push(await invoke(FORMS.detached, () => detached(url)));
  results.push(await invoke(
    FORMS.undefinedReceiver,
    () => detached.call(undefined, url),
  ));
  results.push(await invoke(
    FORMS.globalReceiver,
    () => detached.call(globalThis, url),
  ));
  results.push(await invoke(
    FORMS.unrelatedReceiver,
    () => detached.call({}, url),
  ));
  results.push(await invoke(FORMS.holder, () => holder.fetch(url)));

  return results;
}

export async function runSelfFetchReceiverMatrix(
  url = "data:text/plain,receiver-ok",
) {
  if (typeof self === "undefined") {
    throw new ReferenceError("self is not defined");
  }

  const fromSelf = self.fetch;
  const results = [];

  results.push(await invoke(SELF_FORMS.detached, () => fromSelf(url)));
  results.push(await invoke(
    SELF_FORMS.callUndefined,
    () => fromSelf.call(undefined, url),
  ));
  results.push(await invoke(
    SELF_FORMS.callNull,
    () => fromSelf.call(null, url),
  ));
  results.push(await invoke(
    SELF_FORMS.callGlobal,
    () => fromSelf.call(globalThis, url),
  ));
  results.push(await invoke(
    SELF_FORMS.callUnrelated,
    () => fromSelf.call({}, url),
  ));
  results.push(await invoke(
    SELF_FORMS.holder,
    () => ({ fetch: fromSelf }).fetch(url),
  ));

  results.push(await invoke(
    SELF_FORMS.applyUndefined,
    () => fromSelf.apply(undefined, [url]),
  ));
  results.push(await invoke(
    SELF_FORMS.applyNull,
    () => fromSelf.apply(null, [url]),
  ));
  results.push(await invoke(
    SELF_FORMS.applyGlobal,
    () => fromSelf.apply(globalThis, [url]),
  ));
  results.push(await invoke(
    SELF_FORMS.applyUnrelated,
    () => fromSelf.apply({}, [url]),
  ));

  results.push(await invoke(
    SELF_FORMS.bindUndefined,
    () => fromSelf.bind(undefined)(url),
  ));
  results.push(await invoke(
    SELF_FORMS.bindNull,
    () => fromSelf.bind(null)(url),
  ));
  results.push(await invoke(
    SELF_FORMS.bindGlobal,
    () => fromSelf.bind(globalThis)(url),
  ));
  results.push(await invoke(
    SELF_FORMS.bindUnrelated,
    () => fromSelf.bind({})(url),
  ));

  return results;
}

function indexResults(results, expectedForms) {
  const indexed = new Map(results.map((result) => [result.form, result]));
  for (const form of expectedForms) {
    if (!indexed.has(form)) {
      throw new Error(`Receiver matrix omitted ${form}`);
    }
  }
  return indexed;
}

function expectResponse(indexed, form) {
  const result = indexed.get(form);
  if (result?.outcome !== "response") {
    throw new Error(
      `${form} should return a response; observed ${JSON.stringify(result)}`,
    );
  }
}

function expectTypeError(indexed, form) {
  const result = indexed.get(form);
  if (
    result?.outcome !== "error"
    || !result.error.includes("TypeError")
  ) {
    throw new Error(
      `${form} should throw TypeError; observed ${JSON.stringify(result)}`,
    );
  }
}

function expectExactError(indexed, form, errorText) {
  const result = indexed.get(form);
  if (result?.outcome !== "error" || result.error !== errorText) {
    throw new Error(
      `${form} should throw ${JSON.stringify(errorText)}; observed ${JSON.stringify(result)}`,
    );
  }
}

export function assertFetchReceiverProfile(results, profile) {
  const indexed = indexResults(results, FETCH_RECEIVER_FORMS);

  for (const form of [
    FORMS.bare,
    FORMS.global,
    FORMS.detached,
    FORMS.undefinedReceiver,
    FORMS.globalReceiver,
  ]) {
    expectResponse(indexed, form);
  }

  const selfResult = indexed.get(FORMS.self);
  if (selfResult?.outcome !== "response" && selfResult?.outcome !== "unavailable") {
    throw new Error(
      `${FORMS.self} should return a response or be unavailable; observed ${JSON.stringify(selfResult)}`,
    );
  }

  if (profile === "server-runtime") {
    expectResponse(indexed, FORMS.unrelatedReceiver);
    expectResponse(indexed, FORMS.holder);
    return;
  }

  if (profile === "web-idl") {
    expectResponse(indexed, FORMS.self);
    expectTypeError(indexed, FORMS.unrelatedReceiver);
    expectTypeError(indexed, FORMS.holder);
    return;
  }

  throw new Error(`Unknown receiver profile: ${profile}`);
}

export function assertWorkerdSelfFetchReceiverMatrix(results) {
  const indexed = indexResults(results, SELF_FETCH_RECEIVER_FORMS);

  for (const form of [
    SELF_FORMS.detached,
    SELF_FORMS.callUndefined,
    SELF_FORMS.callNull,
    SELF_FORMS.callGlobal,
    SELF_FORMS.applyUndefined,
    SELF_FORMS.applyNull,
    SELF_FORMS.applyGlobal,
    SELF_FORMS.bindUndefined,
    SELF_FORMS.bindNull,
    SELF_FORMS.bindGlobal,
  ]) {
    expectResponse(indexed, form);
  }

  for (const form of [
    SELF_FORMS.callUnrelated,
    SELF_FORMS.holder,
    SELF_FORMS.applyUnrelated,
    SELF_FORMS.bindUnrelated,
  ]) {
    expectExactError(indexed, form, WORKERD_ILLEGAL_INVOCATION_ERROR);
  }
}
