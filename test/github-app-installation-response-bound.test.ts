import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubAppInstallationTokenMinter } from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
const maximumBytes = 64 * 1024;
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("GitHub installation token response bounds", () => {
  test("accepts one bounded exact response and caches the admitted token", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse("bounded-token");
    });

    const first = await minter.getInstallationToken(request());
    const second = await minter.getInstallationToken(request());

    expect(first).toEqual({
      token: "bounded-token",
      expiresAt: "2026-07-31T01:00:00.000Z",
    });
    expect(second).toEqual(first);
    expect(providerCalls).toBe(1);
  });

  test("rejects declared overflow before reading and never caches it", async () => {
    let providerCalls = 0;
    let readerCalls = 0;
    let cancellations = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return controlledUnreadResponse({
        status: 201,
        contentLength: String(maximumBytes + 1),
        onReader: () => {
          readerCalls += 1;
        },
        onCancel: () => {
          cancellations += 1;
        },
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await capturedError(() =>
        minter.getInstallationToken(request())
      );
      expect(error.code).toBe("github_provider_invalid_response");
      expect(error.message).toBe(
        `GitHub installation token response exceeded ${maximumBytes} bytes`,
      );
    }

    expect(providerCalls).toBe(2);
    expect(readerCalls).toBe(0);
    expect(cancellations).toBe(2);
  });

  test("rejects streamed overflow and never caches it", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(maximumBytes));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }), { status: 201 });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await capturedError(() =>
        minter.getInstallationToken(request())
      );
      expect(error.code).toBe("github_provider_invalid_response");
      expect(error.message).toContain(`exceeded ${maximumBytes} bytes`);
    }
    expect(providerCalls).toBe(2);
  });

  test("maps unreadable bodies to one fixed credential diagnostic without cache admission", async () => {
    let providerCalls = 0;
    const secret = "github_pat_provider-body-secret";
    const minter = createMinter(async () => {
      providerCalls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          throw new Error(`reader echoed ${secret}`);
        },
      }), { status: 201 });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectFixedTransportFailure(minter, secret);
    }
    expect(providerCalls).toBe(2);
  });

  test("maps custom reader-acquisition failures to one fixed diagnostic without cache admission", async () => {
    let providerCalls = 0;
    const secret = "stn.tok_reader-acquisition-secret";
    const minter = createMinter(async () => {
      providerCalls += 1;
      return responseWithBody({
        getReader() {
          throw new Error(`reader acquisition echoed ${secret}`);
        },
      } as unknown as ReadableStream<Uint8Array>);
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectFixedTransportFailure(minter, secret);
    }
    expect(providerCalls).toBe(2);
  });

  test("maps locked native streams to one fixed diagnostic without cache admission", async () => {
    let providerCalls = 0;
    let lock: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const minter = createMinter(async () => {
      providerCalls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(tokenPayloadBytes(`locked-${providerCalls}`));
          controller.close();
        },
      });
      lock = stream.getReader();
      return responseWithBody(stream);
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectFixedTransportFailure(minter);
      lock?.releaseLock();
      lock = undefined;
    }
    expect(providerCalls).toBe(2);
  });

  test("maps release failure after a complete body to one fixed diagnostic without cache admission", async () => {
    let providerCalls = 0;
    const secret = "sk-proj-release-secret";
    const minter = createMinter(async () => {
      providerCalls += 1;
      return scriptedReaderResponse({
        chunks: [tokenPayloadBytes(`release-${providerCalls}`)],
        releaseError: new Error(`release echoed ${secret}`),
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectFixedTransportFailure(minter, secret);
    }
    expect(providerCalls).toBe(2);
  });

  test("keeps bounded overflow authoritative when release also fails", async () => {
    let providerCalls = 0;
    const secret = "xoxb-release-overflow-secret";
    const minter = createMinter(async () => {
      providerCalls += 1;
      return scriptedReaderResponse({
        chunks: [new Uint8Array(maximumBytes + 1)],
        releaseError: new Error(`release echoed ${secret}`),
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await capturedError(() =>
        minter.getInstallationToken(request())
      );
      expect(error.code).toBe("github_provider_invalid_response");
      expect(error.message).toBe(
        `GitHub installation token response exceeded ${maximumBytes} bytes`,
      );
      expect(error.message).not.toContain(secret);
    }
    expect(providerCalls).toBe(2);
  });

  test("rejects invalid UTF-8 and invalid JSON with fixed diagnostics", async () => {
    for (const [bytes, message] of [
      [
        new Uint8Array([0xff]),
        "GitHub installation token response was not valid UTF-8",
      ],
      [
        new TextEncoder().encode("{provider-prose"),
        "GitHub returned a non-JSON response",
      ],
    ] as const) {
      let providerCalls = 0;
      const minter = createMinter(async () => {
        providerCalls += 1;
        return new Response(bytes.slice(), { status: 201 });
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = await capturedError(() =>
          minter.getInstallationToken(request())
        );
        expect(error.code).toBe("github_provider_invalid_response");
        expect(error.message).toBe(message);
      }
      expect(providerCalls).toBe(2);
    }
  });

  test("derives HTTP failures from status without reading provider error prose", async () => {
    let providerCalls = 0;
    let readerCalls = 0;
    let cancellations = 0;
    const secret = "Bearer github_pat_error-body-secret";
    const minter = createMinter(async () => {
      providerCalls += 1;
      return controlledUnreadResponse({
        status: 401,
        contentLength: String(maximumBytes + 10_000),
        onReader: () => {
          readerCalls += 1;
          throw new Error(`body echoed ${secret}`);
        },
        onCancel: () => {
          cancellations += 1;
        },
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await capturedError(() =>
        minter.getInstallationToken(request())
      );
      expect(error.code).toBe("github_app_credential_rejected");
      expect(error.message).toBe(
        "GitHub could not mint installation token (HTTP 401)",
      );
      expect(error.message).not.toContain(secret);
    }

    expect(providerCalls).toBe(2);
    expect(readerCalls).toBe(0);
    expect(cancellations).toBe(2);
  });
});

function request() {
  return {
    repositoryFullName,
    permission: { name: "contents" as const, access: "read" as const },
  };
}

function createMinter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubAppInstallationTokenMinter {
  return new GitHubAppInstallationTokenMinter({
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: [repositoryFullName],
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
    now: () => fixedNow,
  });
}

function tokenResponse(token: string): Response {
  return Response.json(tokenPayload(token), { status: 201 });
}

function tokenPayload(token: string) {
  return {
    token,
    expires_at: "2026-07-31T01:00:00.000Z",
    permissions: { contents: "read", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  };
}

function tokenPayloadBytes(token: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(tokenPayload(token)));
}

function responseWithBody(
  body: ReadableStream<Uint8Array>,
  status = 201,
  headers: HeadersInit = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body,
  } as unknown as Response;
}

function controlledUnreadResponse(input: {
  status: number;
  contentLength: string;
  onReader: () => void;
  onCancel: () => void;
}): Response {
  const body = {
    async cancel() {
      input.onCancel();
    },
    getReader() {
      input.onReader();
      throw new Error("Controlled response body reader was invoked");
    },
  } as unknown as ReadableStream<Uint8Array>;
  return responseWithBody(body, input.status, {
    "content-length": input.contentLength,
  });
}

function scriptedReaderResponse(input: {
  chunks: Uint8Array[];
  releaseError?: Error;
}): Response {
  let index = 0;
  const reader = {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const chunk = input.chunks[index];
      index += 1;
      return chunk
        ? { done: false, value: chunk }
        : { done: true, value: undefined };
    },
    async cancel() {},
    releaseLock() {
      if (input.releaseError) throw input.releaseError;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const body = {
    getReader() {
      return reader;
    },
  } as unknown as ReadableStream<Uint8Array>;
  return responseWithBody(body);
}

async function expectFixedTransportFailure(
  minter: GitHubAppInstallationTokenMinter,
  secret?: string,
): Promise<void> {
  const error = await capturedError(() =>
    minter.getInstallationToken(request())
  );
  expect(error.code).toBe("github_credential_mint_failed");
  expect(error.message).toBe(
    "GitHub installation token response could not be read",
  );
  if (secret) expect(error.message).not.toContain(secret);
}

async function capturedError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    return error as GitHubProviderRejectedError;
  }
  throw new Error("Expected GitHub installation token mint to reject");
}
