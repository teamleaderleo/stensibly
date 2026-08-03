export class GitHubProviderResponseReadError extends Error {
  constructor() {
    super("GitHub provider response could not be read within its bounds");
    this.name = "GitHubProviderResponseReadError";
  }
}

export const maximumGitHubProviderResponseChunks = 4_096;
export const defaultGitHubProviderResponseDeadlineMs = 30_000;
export const maximumGitHubProviderResponseDeadlineMs = 120_000;

const maximumIssueCollectionFacadeTextBytes = 24 * 1024 * 1024;
const maximumSingleIssueFacadeTextBytes = 512 * 1024;
const maximumSingleCommentFacadeTextBytes = 256 * 1024;
const maximumLinkHeaderBytes = 16 * 1024;
const unsafeHeaderTextPattern = /[\u0000-\u001f\u007f]/u;

interface GitHubProviderResponseDeadline {
  readonly controller: AbortController;
  readonly deadline: Promise<never>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeExternalAbort: () => void;
  expired: boolean;
  finished: boolean;
}

interface AdmittedReadResult {
  readonly done: boolean;
  readonly value: unknown;
}

const responseDeadlines = new WeakMap<Response, GitHubProviderResponseDeadline>();
const wrappedFetchDeadlines = new WeakMap<typeof fetch, number>();

export function admitGitHubProviderResponseDeadlineMs(
  value: unknown,
): number {
  const deadline = value === undefined
    ? defaultGitHubProviderResponseDeadlineMs
    : value;
  if (
    typeof deadline !== "number"
    || !Number.isSafeInteger(deadline)
    || deadline < 1
    || deadline > maximumGitHubProviderResponseDeadlineMs
  ) {
    throw new RangeError("GitHub provider response deadline is invalid");
  }
  return deadline;
}

/**
 * Starts one total provider-response deadline before dispatch. The returned
 * fetch supplies an AbortSignal but also races the implementation directly,
 * so a hostile or injected fetch cannot defeat settlement by ignoring abort.
 * A successful Response retains the same deadline context for bounded body
 * consumption; no second or per-chunk timer is created.
 *
 * Before returning, provider-owned response metadata is snapshotted into a
 * safe facade. Metadata failure before request identity rejects the fetch and
 * is classified by the adapter as unattributed ambiguity. Failure after raw
 * request identity is available becomes a synthetic retryable response so the
 * adapter can re-admit that identity and preserve attributed ambiguity.
 *
 * A composed adapter that forwards an already wrapped fetch without an
 * explicit override preserves the existing deadline instead of nesting or
 * replacing it with the production default.
 */
export function withGitHubProviderResponseDeadline(
  fetchImplementation: typeof fetch,
  value?: unknown,
): typeof fetch {
  if (value === undefined && wrappedFetchDeadlines.has(fetchImplementation)) {
    return fetchImplementation;
  }
  const deadlineMs = admitGitHubProviderResponseDeadlineMs(value);
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const context = createDeadline(deadlineMs, init?.signal ?? null);
    const facadeTextMaximumBytes = maximumFacadeTextBytesForRequest(input);
    try {
      const providerCall = Promise.resolve(fetchImplementation(input, {
        ...init,
        signal: context.controller.signal,
      }));
      void providerCall.then(
        (lateResponse) => {
          if (context.expired || context.finished) {
            discardGitHubProviderResponse(lateResponse);
          }
        },
        () => undefined,
      );
      const response = await Promise.race([
        providerCall,
        context.deadline,
      ]);
      if (!isObjectLike(response)) {
        throw new GitHubProviderResponseReadError();
      }
      responseDeadlines.set(response, context);
      return admitGitHubProviderResponseFacade(
        response,
        facadeTextMaximumBytes,
      );
    } catch (error) {
      finishDeadline(context);
      throw error;
    }
  }) as typeof fetch;
  wrappedFetchDeadlines.set(wrapped, deadlineMs);
  return wrapped;
}

/**
 * Reads one provider response body under independent byte, work, metadata,
 * and total lifetime bounds.
 *
 * Content-Length is an early encoded-size signal only. Fetch may expose
 * decoded bytes, so the declared length is not compared with decoded stream
 * length. Every delivered chunk is detached immediately, including tiny
 * views over large provider-owned buffers. A direct call creates one body
 * deadline; a wrapped provider call reuses the deadline that began before
 * fetch. Failure-path cancellation is best-effort and never awaited.
 */
export async function readBoundedGitHubProviderResponseText(
  response: Response,
  maximumBytes: number,
  providerResponseDeadlineMs?: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("GitHub provider response byte limit is invalid");
  }
  const admittedDeadlineMs = admitGitHubProviderResponseDeadlineMs(
    providerResponseDeadlineMs,
  );
  if (!isObjectLike(response)) {
    throw new GitHubProviderResponseReadError();
  }
  const inherited = responseDeadlines.get(response);
  const context = inherited ?? createDeadline(admittedDeadlineMs, null);

  let headers: Headers;
  let declared: string | null;
  try {
    headers = response.headers;
    declared = headers.get("content-length");
    if (declared !== null && typeof declared !== "string") {
      throw new TypeError("invalid content-length metadata");
    }
  } catch {
    failResponseRead(response, context);
  }

  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      failResponseRead(response, context);
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      failResponseRead(response, context);
    }
  }

  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    finishResponseDeadline(response, context);
    throw new GitHubProviderResponseReadError();
  }
  if (body === null) {
    finishResponseDeadline(response, context);
    return "";
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    cancelBody(body);
    finishResponseDeadline(response, context);
    throw new GitHubProviderResponseReadError();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let totalChunks = 0;
  let failed = false;
  try {
    while (true) {
      let rawResult: unknown;
      try {
        rawResult = await Promise.race([reader.read(), context.deadline]);
      } catch {
        failed = true;
        cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }

      let next: AdmittedReadResult;
      try {
        next = admitReadResult(rawResult);
      } catch {
        failed = true;
        cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }
      if (next.done) break;

      totalChunks += 1;
      if (totalChunks > maximumGitHubProviderResponseChunks) {
        failed = true;
        cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }

      let detached: Uint8Array;
      try {
        if (!(next.value instanceof Uint8Array)) {
          throw new GitHubProviderResponseReadError();
        }
        const nextTotal = totalBytes + next.value.byteLength;
        if (!Number.isSafeInteger(nextTotal) || nextTotal > maximumBytes) {
          throw new GitHubProviderResponseReadError();
        }
        detached = new Uint8Array(next.value.byteLength);
        Uint8Array.prototype.set.call(detached, next.value);
        totalBytes = nextTotal;
      } catch {
        failed = true;
        cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }
      chunks.push(detached);
    }
  } finally {
    finishResponseDeadline(response, context);
    try {
      reader.releaseLock();
    } catch {
      if (!failed) throw new GitHubProviderResponseReadError();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubProviderResponseReadError();
  }
}

export function discardGitHubProviderResponse(response: Response): void {
  if (!isObjectLike(response)) return;
  const context = responseDeadlines.get(response);
  if (context) finishResponseDeadline(response, context);
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    return;
  }
  cancelBody(body);
}

function admitGitHubProviderResponseFacade(
  response: Response,
  facadeTextMaximumBytes: number,
): Response {
  let headers: Headers;
  let requestId: string | null;
  try {
    headers = response.headers;
    requestId = headers.get("x-github-request-id");
    if (requestId !== null && typeof requestId !== "string") {
      throw new TypeError("invalid request ID metadata");
    }
  } catch {
    discardGitHubProviderResponse(response);
    throw new GitHubProviderResponseReadError();
  }

  let contentLength: string | null;
  let link: string | null;
  try {
    contentLength = headers.get("content-length");
    if (contentLength !== null && typeof contentLength !== "string") {
      throw new TypeError("invalid content-length metadata");
    }
    link = boundedOptionalHeader(
      headers.get("link"),
      maximumLinkHeaderBytes,
    );
  } catch {
    return metadataFailureResponse(
      response,
      requestId,
      null,
      null,
      facadeTextMaximumBytes,
    );
  }

  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    return metadataFailureResponse(
      response,
      requestId,
      contentLength,
      link,
      facadeTextMaximumBytes,
      null,
    );
  }

  let ok: boolean;
  let status: number;
  try {
    ok = response.ok;
    status = response.status;
    if (
      typeof ok !== "boolean"
      || !Number.isSafeInteger(status)
      || status < 100
      || status > 599
      || ok !== (status >= 200 && status <= 299)
    ) {
      throw new TypeError("invalid response status metadata");
    }
  } catch {
    return metadataFailureResponse(
      response,
      requestId,
      contentLength,
      link,
      facadeTextMaximumBytes,
      body,
    );
  }

  return responseFacade(
    response,
    requestId,
    contentLength,
    link,
    ok,
    status,
    body,
    facadeTextMaximumBytes,
  );
}

function metadataFailureResponse(
  response: Response,
  requestId: string | null,
  contentLength: string | null,
  link: string | null,
  facadeTextMaximumBytes: number,
  bodyValue?: ReadableStream<Uint8Array> | null,
): Response {
  let body = bodyValue;
  if (body === undefined) {
    try {
      body = response.body;
    } catch {
      body = null;
    }
  }
  cancelBody(body);
  return responseFacade(
    response,
    requestId,
    contentLength,
    link,
    false,
    503,
    null,
    facadeTextMaximumBytes,
  );
}

function responseFacade(
  original: Response,
  requestId: string | null,
  contentLength: string | null,
  link: string | null,
  ok: boolean,
  status: number,
  body: ReadableStream<Uint8Array> | null,
  facadeTextMaximumBytes: number,
): Response {
  const headers = readOnlyResponseHeaders(requestId, contentLength, link);
  let consumed = false;
  let facade: Response;
  facade = Object.freeze({
    headers,
    ok,
    status,
    body,
    async text(): Promise<string> {
      if (consumed) throw new GitHubProviderResponseReadError();
      consumed = true;
      return await readBoundedGitHubProviderResponseText(
        facade,
        facadeTextMaximumBytes,
      );
    },
  }) as unknown as Response;
  transferResponseDeadline(original, facade);
  return facade;
}

function readOnlyResponseHeaders(
  requestId: string | null,
  contentLength: string | null,
  link: string | null,
): Headers {
  return Object.freeze({
    get(name: string) {
      const normalized = typeof name === "string" ? name.toLowerCase() : "";
      if (normalized === "x-github-request-id") return requestId;
      if (normalized === "content-length") return contentLength;
      if (normalized === "link") return link;
      return null;
    },
  }) as unknown as Headers;
}

function transferResponseDeadline(original: Response, facade: Response): void {
  const context = responseDeadlines.get(original);
  if (!context) return;
  responseDeadlines.delete(original);
  responseDeadlines.set(facade, context);
}

function admitReadResult(value: unknown): AdmittedReadResult {
  if (value === null || typeof value !== "object") {
    throw new GitHubProviderResponseReadError();
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new GitHubProviderResponseReadError();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GitHubProviderResponseReadError();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string" || (key !== "done" && key !== "value")
    )
  ) {
    throw new GitHubProviderResponseReadError();
  }
  const doneDescriptor = descriptors.done;
  if (
    !doneDescriptor
    || !("value" in doneDescriptor)
    || doneDescriptor.enumerable !== true
    || typeof doneDescriptor.value !== "boolean"
  ) {
    throw new GitHubProviderResponseReadError();
  }
  const valueDescriptor = descriptors.value;
  if (valueDescriptor && (
    !("value" in valueDescriptor)
    || valueDescriptor.enumerable !== true
  )) {
    throw new GitHubProviderResponseReadError();
  }
  if (doneDescriptor.value) {
    return Object.freeze({ done: true, value: undefined });
  }
  if (!valueDescriptor || !("value" in valueDescriptor)) {
    throw new GitHubProviderResponseReadError();
  }
  return Object.freeze({ done: false, value: valueDescriptor.value });
}

function boundedOptionalHeader(
  value: unknown,
  maximumBytes: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || unsafeHeaderTextPattern.test(value)
  ) {
    throw new GitHubProviderResponseReadError();
  }
  return value;
}

function maximumFacadeTextBytesForRequest(
  input: RequestInfo | URL,
): number {
  let urlText: string | null = null;
  if (typeof input === "string") {
    urlText = input;
  } else if (input instanceof URL) {
    urlText = input.toString();
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    urlText = input.url;
  }
  if (urlText === null) return maximumSingleIssueFacadeTextBytes;

  let pathname: string;
  try {
    pathname = new URL(urlText).pathname.replace(/\/+$/u, "");
  } catch {
    return maximumSingleIssueFacadeTextBytes;
  }
  if (
    /\/search\/issues$/u.test(pathname)
    || /\/repos\/[^/]+\/[^/]+\/issues$/u.test(pathname)
  ) {
    return maximumIssueCollectionFacadeTextBytes;
  }
  if (/\/issues\/comments\/[1-9][0-9]*$/u.test(pathname)) {
    return maximumSingleCommentFacadeTextBytes;
  }
  return maximumSingleIssueFacadeTextBytes;
}

function failResponseRead(
  response: Response,
  context: GitHubProviderResponseDeadline,
): never {
  discardGitHubProviderResponse(response);
  finishDeadline(context);
  throw new GitHubProviderResponseReadError();
}

function createDeadline(
  deadlineMs: number,
  externalSignal: AbortSignal | null,
): GitHubProviderResponseDeadline {
  const controller = new AbortController();
  let rejectDeadline: (error: GitHubProviderResponseReadError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const context: GitHubProviderResponseDeadline = {
    controller,
    deadline,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    removeExternalAbort: () => {},
    expired: false,
    finished: false,
  };
  context.timer = setTimeout(() => {
    context.expired = true;
    try {
      controller.abort();
    } catch {
      // Direct Promise settlement remains authoritative.
    }
    rejectDeadline(new GitHubProviderResponseReadError());
  }, deadlineMs);

  if (externalSignal) {
    const forwardAbort = () => {
      try {
        controller.abort();
      } catch {
        // The provider call owns final error classification.
      }
    };
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
      context.removeExternalAbort = () =>
        externalSignal.removeEventListener("abort", forwardAbort);
    }
  }

  return context;
}

function finishResponseDeadline(
  response: Response,
  context: GitHubProviderResponseDeadline,
): void {
  responseDeadlines.delete(response);
  finishDeadline(context);
}

function finishDeadline(context: GitHubProviderResponseDeadline): void {
  if (context.finished) return;
  context.finished = true;
  clearTimeout(context.timer);
  context.removeExternalAbort();
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null || !isObjectLike(body)) return;
  try {
    suppressCancellation(body.cancel());
  } catch {
    // The caller-owned status/error remains authoritative.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    suppressCancellation(reader.cancel());
  } catch {
    // The fixed reader error remains authoritative.
  }
}

function suppressCancellation(value: unknown): void {
  if (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && "then" in value
  ) {
    void Promise.resolve(value).catch(() => undefined);
  }
}

function isObjectLike(value: unknown): value is object {
  return value !== null
    && (typeof value === "object" || typeof value === "function");
}
