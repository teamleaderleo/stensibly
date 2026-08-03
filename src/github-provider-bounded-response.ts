export class GitHubProviderResponseReadError extends Error {
  constructor() {
    super("GitHub provider response could not be read within its bounds");
    this.name = "GitHubProviderResponseReadError";
  }
}

export const maximumGitHubProviderResponseChunks = 4_096;
export const defaultGitHubProviderResponseDeadlineMs = 30_000;
export const maximumGitHubProviderResponseDeadlineMs = 120_000;

interface GitHubProviderResponseDeadline {
  readonly controller: AbortController;
  readonly deadline: Promise<never>;
  readonly deadlineAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeExternalAbort: () => void;
  finished: boolean;
}

const responseDeadlines = new WeakMap<Response, GitHubProviderResponseDeadline>();

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
 */
export function withGitHubProviderResponseDeadline(
  fetchImplementation: typeof fetch,
  value: unknown,
): typeof fetch {
  const deadlineMs = admitGitHubProviderResponseDeadlineMs(value);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const context = createDeadline(deadlineMs, init?.signal ?? null);
    try {
      const response = await Promise.race([
        fetchImplementation(input, {
          ...init,
          signal: context.controller.signal,
        }),
        context.deadline,
      ]);
      responseDeadlines.set(response, context);
      return response;
    } catch (error) {
      finishDeadline(context);
      throw error;
    }
  }) as typeof fetch;
}

/**
 * Reads one provider response body under independent byte, work, and total
 * lifetime bounds.
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
  const inherited = responseDeadlines.get(response);
  const context = inherited ?? createDeadline(
    admitGitHubProviderResponseDeadlineMs(providerResponseDeadlineMs),
    null,
  );

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      discardGitHubProviderResponse(response);
      finishDeadline(context);
      throw new GitHubProviderResponseReadError();
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      discardGitHubProviderResponse(response);
      finishDeadline(context);
      throw new GitHubProviderResponseReadError();
    }
  }

  if (response.body === null) {
    finishResponseDeadline(response, context);
    return "";
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    discardGitHubProviderResponse(response);
    finishDeadline(context);
    throw new GitHubProviderResponseReadError();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let totalChunks = 0;
  let failed = false;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), context.deadline]);
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

      if (!(next.value instanceof Uint8Array)) {
        failed = true;
        cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }

      let detached: Uint8Array;
      try {
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
  const context = responseDeadlines.get(response);
  if (context) finishResponseDeadline(response, context);
  try {
    suppressCancellation(response.body?.cancel());
  } catch {
    // The caller-owned status/error remains authoritative.
  }
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
  const deadlineAt = Date.now() + deadlineMs;
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // Direct Promise settlement remains authoritative.
    }
    rejectDeadline(new GitHubProviderResponseReadError());
  }, deadlineMs);

  let removeExternalAbort = () => {};
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
      removeExternalAbort = () =>
        externalSignal.removeEventListener("abort", forwardAbort);
    }
  }

  return {
    controller,
    deadline,
    deadlineAt,
    timer,
    removeExternalAbort,
    finished: false,
  };
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
