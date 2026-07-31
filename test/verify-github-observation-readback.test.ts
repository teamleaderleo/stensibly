import { describe, expect, test } from "bun:test";
import {
  formatGitHubObservationReadbackReceipt,
  parseVerifyGitHubObservationReadbackArgs,
  redactGitHubObservationVerifierSecrets,
  verifyGitHubObservationReadback,
} from "../src/verify-github-observation-readback.ts";

const token = `stn.tok_1234567890abcdef1234567890abcdef.${"a".repeat(43)}`;
const repository = "teamleaderleo/stensibly";
const revision = "b".repeat(40);
const endpoint = "https://api.stensibly.com";
const requestUrl = `${endpoint}/api/v1/github/repository-observations?repository=${repository.replace("/", "%2F")}&limit=100`;
const maximumResponseBytes = 1024 * 1024;

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    observations: [{
      id: "observation-row-1",
      createdAt: "2026-08-01T00:00:02.000Z",
      observation: {
        provider: "github",
        eventType: "push",
        repository,
        containsRawContent: false,
        observationId: "github:push:delivery-live-readback",
        deliveryId: "delivery-live-readback",
        semanticFingerprint: `sha256:${"c".repeat(64)}`,
        receivedAt: "2026-08-01T00:00:01.000Z",
        relationships: { revision },
        ...overrides,
      },
    }],
  };
}

function responseAt(
  url: string,
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function jsonResponseAt(
  url: string,
  body: unknown,
  init: ResponseInit = {},
): Response {
  const text = JSON.stringify(body);
  return responseAt(url, text, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function verifierOptions(overrides: Partial<Parameters<typeof verifyGitHubObservationReadback>[0]> = {}) {
  return {
    endpoint,
    token,
    repository,
    revision,
    ...overrides,
  };
}

function exactLimitBody(): string {
  const body = responseBody({ padding: "" });
  const initial = JSON.stringify(body);
  const paddingLength = maximumResponseBytes - new TextEncoder().encode(initial).byteLength;
  if (paddingLength < 0) throw new Error("Fixture base exceeds response ceiling");
  (body.observations[0]!.observation as Record<string, unknown>).padding = "x".repeat(paddingLength);
  const text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength !== maximumResponseBytes) {
    throw new Error("Exact-limit fixture construction failed");
  }
  return text;
}

describe("hosted GitHub observation readback verifier", () => {
  test("parses exact environment-backed inputs", () => {
    const parsed = parseVerifyGitHubObservationReadbackArgs([], {
      STENSIBLY_TOKEN: token,
      STENSIBLY_ENDPOINT: endpoint,
      GITHUB_REPOSITORY: repository,
      TARGET_REVISION: revision,
    });
    expect(parsed).toEqual({
      help: false,
      options: {
        endpoint,
        token,
        repository,
        revision,
        limit: 100,
      },
    });
  });

  test("finds the exact deployed push through the confined request", async () => {
    const requests: Request[] = [];
    let redirect: RequestRedirect | undefined;
    const receipt = await verifyGitHubObservationReadback(verifierOptions({ limit: 50 }), async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      redirect = init?.redirect;
      return jsonResponseAt(request.url, responseBody());
    });

    expect(requests).toHaveLength(1);
    const requested = requests[0]!;
    expect(requested.url).toBe(
      `${endpoint}/api/v1/github/repository-observations?repository=${repository.replace("/", "%2F")}&limit=50`,
    );
    expect(requested.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(requested.headers.get("accept-encoding")).toBe("identity");
    expect(redirect).toBe("error");
    expect(receipt).toEqual({
      repository,
      revision,
      observationId: "github:push:delivery-live-readback",
      deliveryId: "delivery-live-readback",
      semanticFingerprint: `sha256:${"c".repeat(64)}`,
      receivedAt: "2026-08-01T00:00:01.000Z",
      createdAt: "2026-08-01T00:00:02.000Z",
    });
    const output = formatGitHubObservationReadbackReceipt(receipt);
    expect(output).toContain(`revision=${revision}`);
    expect(output).not.toContain(token);
  });

  test("rejects unreviewed endpoints and padded identities before fetch", async () => {
    const invalidEndpoints = [
      "https://example.com",
      "http://api.stensibly.com",
      "https://user@api.stensibly.com",
      "https://api.stensibly.com/path",
      "https://api.stensibly.com?query=1",
      "https://api.stensibly.com#fragment",
      " https://api.stensibly.com",
      "https://api.stensibly.com ",
    ];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponseAt(requestUrl, responseBody());
    };
    for (const value of invalidEndpoints) {
      await expect(verifyGitHubObservationReadback(verifierOptions({ endpoint: value }), fetchImpl))
        .rejects.toThrow("exact reviewed Stensibly HTTPS origin");
    }
    for (const value of [` ${repository}`, `${repository} `]) {
      await expect(verifyGitHubObservationReadback(verifierOptions({ repository: value }), fetchImpl))
        .rejects.toThrow("exact lowercase owner/name");
    }
    for (const value of [` ${revision}`, `${revision} `]) {
      await expect(verifyGitHubObservationReadback(verifierOptions({ revision: value }), fetchImpl))
        .rejects.toThrow("exact lowercase 40-character");
    }
    expect(calls).toBe(0);
  });

  test("rejects redirect and wrong response URL before body intake", async () => {
    let cancelled = 0;
    const body = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(responseBody())));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const redirected = responseAt(requestUrl, body());
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => redirected))
      .rejects.toThrow("unexpected URL");

    const wrongUrl = responseAt("https://api.stensibly.com/unexpected", body());
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => wrongUrl))
      .rejects.toThrow("unexpected URL");
    expect(cancelled).toBe(2);
  });

  test("keeps hostile HTTP bodies out of diagnostics", async () => {
    const hostile = "::error:: bearer ghp_private openai-sk-private slack-xoxb-private observation prose";
    let cancelled = false;
    const response = responseAt(requestUrl, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(hostile));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 500 });
    let error: unknown;
    try {
      await verifyGitHubObservationReadback(verifierOptions(), async () => response);
    } catch (caught) {
      error = caught;
    }
    const diagnostic = redactGitHubObservationVerifierSecrets(error, token);
    expect(diagnostic).toBe("Hosted observation readback returned HTTP 500");
    expect(diagnostic).not.toContain(hostile);
    expect(cancelled).toBe(true);
  });

  test("rejects hostile successful observation identities before receipt output", async () => {
    const hostileIdentity = "github:push:delivery-live-readback\n::error::retained-command";
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => jsonResponseAt(
      requestUrl,
      responseBody({ observationId: hostileIdentity }),
    ))).rejects.toThrow("inconsistent observation identity");
  });

  test("bounds declared and streamed response bytes before parse", async () => {
    let declaredCancelled = false;
    const declaredOverflow = responseAt(requestUrl, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123, 125]));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": String(maximumResponseBytes + 1) },
    });
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => declaredOverflow))
      .rejects.toThrow("exceeded 1 MiB");
    expect(declaredCancelled).toBe(true);

    let streamedCancelled = false;
    const streamedOverflow = responseAt(requestUrl, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maximumResponseBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        streamedCancelled = true;
      },
    }));
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => streamedOverflow))
      .rejects.toThrow("exceeded 1 MiB");
    expect(streamedCancelled).toBe(true);
  });

  test("copies admitted stream chunks before producer mutation", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(responseBody()));
    const split = Math.floor(bytes.byteLength / 2);
    const oversizedBacking = new Uint8Array(maximumResponseBytes * 2);
    const first = oversizedBacking.subarray(0, split);
    first.set(bytes.subarray(0, split));
    const second = bytes.slice(split);
    let started = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (started) return;
        started = true;
        controller.enqueue(first);
        setTimeout(() => {
          first.fill(0x78);
          controller.enqueue(second);
          controller.close();
        }, 0);
      },
    });

    const receipt = await verifyGitHubObservationReadback(
      verifierOptions(),
      async () => responseAt(requestUrl, stream),
    );
    expect(receipt.revision).toBe(revision);
  });

  test("times out and cancels a stalled response body", async () => {
    let cancelled = false;
    const stalled = responseAt(requestUrl, new ReadableStream<Uint8Array>({
      pull() {
        // Leave the first read pending until the verifier deadline cancels it.
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(verifyGitHubObservationReadback(
      verifierOptions({ timeoutMs: 100 }),
      async () => stalled,
    )).rejects.toThrow("Request timed out after 100ms");
    expect(cancelled).toBe(true);
  });

  test("rejects invalid or conflicting response lengths", async () => {
    for (const contentLength of ["01", "1, 2", "-1", "9007199254740992"]) {
      await expect(verifyGitHubObservationReadback(verifierOptions(), async () => responseAt(
        requestUrl,
        "{}",
        { headers: { "content-length": contentLength } },
      ))).rejects.toThrow("invalid Content-Length");
    }
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => responseAt(
      requestUrl,
      "{}",
      { headers: { "content-length": "3" } },
    ))).rejects.toThrow("length did not match");
  });

  test("rejects invalid UTF-8 and JSON with fixed diagnostics", async () => {
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => responseAt(
      requestUrl,
      new Uint8Array([0xc3, 0x28]),
    ))).rejects.toThrow("invalid UTF-8");
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => responseAt(
      requestUrl,
      "{",
    ))).rejects.toThrow("invalid JSON");
  });

  test("accepts an exact 1 MiB canonical response", async () => {
    const text = exactLimitBody();
    const receipt = await verifyGitHubObservationReadback(verifierOptions(), async () => responseAt(
      requestUrl,
      text,
      { headers: { "content-length": String(maximumResponseBytes) } },
    ));
    expect(receipt.revision).toBe(revision);
  });

  test("fails closed when the exact revision is absent", async () => {
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => jsonResponseAt(
      requestUrl,
      responseBody({ relationships: { revision: "d".repeat(40) } }),
    ))).rejects.toThrow(
      `No signed push observation for ${repository}@${revision} was found`,
    );
  });

  test("rejects malformed envelopes and credential-shaped diagnostics", async () => {
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => jsonResponseAt(
      requestUrl,
      { observations: [], unexpected: true },
    ))).rejects.toThrow("noncanonical envelope");

    expect(redactGitHubObservationVerifierSecrets(
      new Error(`backend rejected ${token}`),
      token,
    )).toBe("backend rejected [REDACTED]");
  });

  test("rejects aliases and unbounded reads before network access", async () => {
    let calls = 0;
    await expect(verifyGitHubObservationReadback(verifierOptions({
      repository: "TeamLeaderLeo/Stensibly",
    }), async () => {
      calls += 1;
      return jsonResponseAt(requestUrl, responseBody());
    })).rejects.toThrow("exact lowercase owner/name");
    expect(calls).toBe(0);

    expect(() => parseVerifyGitHubObservationReadbackArgs([
      "--repository", repository,
      "--revision", revision,
      "--limit", "101",
    ], { STENSIBLY_TOKEN: token })).toThrow("between 1 and 100");
  });

  test("publishes fixed request failures", async () => {
    await expect(verifyGitHubObservationReadback(verifierOptions(), async () => {
      throw new Error("private provider failure body");
    })).rejects.toThrow("Hosted observation readback request failed");
  });
});
