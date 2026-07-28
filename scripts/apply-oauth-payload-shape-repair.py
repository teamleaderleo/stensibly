from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, found {count}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/hosted-auth.ts",
    '    if (!payload) throw new ProviderFailure("token_exchange", "malformed_response");\n',
    '''    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderFailure("token_exchange", "malformed_response");
    }
''',
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    '''    expectFailure(
      await captureFailure(malformed.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      [EXCHANGE_INPUT.code],
      "malformed_response",
    );

    const missing = githubClient(singleUseFetch(tokenResponse({ scope: "" })));
''',
    '''    expectFailure(
      await captureFailure(malformed.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      [EXCHANGE_INPUT.code],
      "malformed_response",
    );

    for (const payload of ["scalar", []]) {
      const invalidShape = githubClient(singleUseFetch(tokenResponse(payload)));
      expectFailure(
        await captureFailure(invalidShape.exchangeCode(EXCHANGE_INPUT)),
        "token_exchange",
        [EXCHANGE_INPUT.code, "scalar"],
        "malformed_response",
      );
    }

    const missing = githubClient(singleUseFetch(tokenResponse({ scope: "" })));
''',
)
