from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/hosted-auth.ts",
    '''    this.fetchImpl = options.fetch ?? fetch;''',
    '''    const fetchImpl = options.fetch;
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);''',
)

replace_once(
    "test/hosted-auth-github-preflight.test.ts",
    '''  test("serializes the one-shot token exchange form body explicitly", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        access_token: "github-token-sentinel",
        scope: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.exchangeCode(EXCHANGE_INPUT)).resolves.toBe("github-token-sentinel");
    expect(requests).toHaveLength(1);
    expect(typeof requests[0]?.init?.body).toBe("string");
    expect(requests[0]?.init?.cache).toBeUndefined();
    expect(requests[0]?.init?.redirect).toBeUndefined();
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("code")).toBe(EXCHANGE_INPUT.code);
    expect(body.get("redirect_uri")).toBe(EXCHANGE_INPUT.redirectUri);
    expect(body.get("code_verifier")).toBe(EXCHANGE_INPUT.codeVerifier);
  });
});''',
    '''  test("serializes the one-shot token exchange form body explicitly", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        access_token: "github-token-sentinel",
        scope: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.exchangeCode(EXCHANGE_INPUT)).resolves.toBe("github-token-sentinel");
    expect(requests).toHaveLength(1);
    expect(typeof requests[0]?.init?.body).toBe("string");
    expect(requests[0]?.init?.cache).toBeUndefined();
    expect(requests[0]?.init?.redirect).toBeUndefined();
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("code")).toBe(EXCHANGE_INPUT.code);
    expect(body.get("redirect_uri")).toBe(EXCHANGE_INPUT.redirectUri);
    expect(body.get("code_verifier")).toBe(EXCHANGE_INPUT.codeVerifier);
  });

  test("invokes injected fetch without rebinding its receiver", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      requests.push({ input, init });
      return Promise.resolve(new Response(null, { status: 405 }));
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.prepareExchange()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});''',
)
