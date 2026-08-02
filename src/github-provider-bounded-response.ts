export const GITHUB_PROVIDER_RESPONSE_READ_FAILED =
  "GitHub provider response could not be read within its byte budget";

export class GitHubProviderResponseReadError extends Error {
  constructor() {
    super(GITHUB_PROVIDER_RESPONSE_READ_FAILED);
    this.name = "GitHubProviderResponseReadError";
  }
}

/**
 * Reads one provider response body without trusting Content-Length.
 *
 * The declared length, when present, must be one exact safe decimal within
 * the admitted ceiling and must equal the streamed byte count. The stream is
 * cancelled immediately when its declared or absolute ceiling is exceeded.
 * Returned text is detached and decoded as strict UTF-8. Provider body prose
 * is never included in diagnostics.
 */
export async function readBoundedGitHubProviderResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("GitHub provider response byte limit is invalid");
  }

  const declaredHeader = response.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declaredHeader !== null) {
    if (!/^\d+$/.test(declaredHeader)) {
      await discardResponse(response);
      throw new GitHubProviderResponseReadError();
    }
    declaredLength = Number(declaredHeader);
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength > maximumBytes
    ) {
      await discardResponse(response);
      throw new GitHubProviderResponseReadError();
    }
  }

  if (!response.body) {
    throw new GitHubProviderResponseReadError();
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new GitHubProviderResponseReadError();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let failed = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        failed = true;
        await cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }
      total += item.value.byteLength;
      if (
        total > maximumBytes
        || (declaredLength !== null && total > declaredLength)
      ) {
        failed = true;
        await cancelReader(reader);
        throw new GitHubProviderResponseReadError();
      }
      chunks.push(item.value.slice());
    }
    if (declaredLength !== null && total !== declaredLength) {
      failed = true;
      throw new GitHubProviderResponseReadError();
    }
  } catch (error) {
    failed = true;
    if (error instanceof GitHubProviderResponseReadError) throw error;
    throw new GitHubProviderResponseReadError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      if (!failed) throw new GitHubProviderResponseReadError();
    }
  }

  const bytes = new Uint8Array(total);
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

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The fixed caller-owned error remains authoritative.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The fixed caller-owned error remains authoritative.
  }
}
