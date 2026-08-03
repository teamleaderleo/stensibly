export class GitHubProviderResponseReadError extends Error {
  constructor() {
    super("GitHub provider response could not be read within its bounds");
    this.name = "GitHubProviderResponseReadError";
  }
}

export const maximumGitHubProviderResponseChunks = 4_096;

/**
 * Reads one provider response body under independent byte and work bounds.
 *
 * Content-Length is an early encoded-size signal only. Fetch may expose
 * decoded bytes, so the declared length is not compared with decoded stream
 * length. Every delivered chunk is detached immediately, including tiny
 * views over large provider-owned buffers. Failure-path cancellation is
 * best-effort and never awaited.
 */
export async function readBoundedGitHubProviderResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("GitHub provider response byte limit is invalid");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      discardGitHubProviderResponse(response);
      throw new GitHubProviderResponseReadError();
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      discardGitHubProviderResponse(response);
      throw new GitHubProviderResponseReadError();
    }
  }

  if (response.body === null) return "";

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    discardGitHubProviderResponse(response);
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
        next = await reader.read();
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
  try {
    suppressCancellation(response.body?.cancel());
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
