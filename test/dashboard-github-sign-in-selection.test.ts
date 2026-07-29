import { describe, expect, test } from "bun:test";

const bridgeFile = () => Bun.file(
  new URL("../site/hosted-session-bridge.js", import.meta.url),
).text();

describe("dashboard GitHub sign-in selection", () => {
  test("the primary GitHub action always selects the hosted session", async () => {
    const bridge = await bridgeFile();
    const beginSignIn = between(
      bridge,
      "function beginGithubSignIn()",
      "function preserveHostedSignOut()",
    );
    const activateSession = between(
      bridge,
      "function activateHostedSession()",
      "function readSavedEndpoint()",
    );

    expect(beginSignIn).toContain("const endpoint = DEFAULT_ENDPOINT;");
    expect(beginSignIn).toContain("persistEndpoint(endpoint);");
    expect(beginSignIn).toContain("activateHostedSession();");
    expect(beginSignIn).toContain("endpointInput.value = endpoint;");
    expect(beginSignIn).not.toContain("selectedEndpoint");
    expect(activateSession).toContain("sessionStorage.setItem(STORAGE_KEY, sentinel);");
    expect(bridge).not.toContain(
      "GitHub sign-in only works with api.stensibly.com. Use an API token for another endpoint.",
    );
  });
});

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing source markers: ${startMarker} / ${endMarker}`);
  }
  return source.slice(start, end);
}
