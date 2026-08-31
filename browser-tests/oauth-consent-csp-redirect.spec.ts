import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";

test("consent CSP permits the exact validated callback redirect origin", async ({ page }) => {
  let resolveCallback!: () => void;
  const callbackReached = new Promise<void>((resolve) => {
    resolveCallback = resolve;
  });
  const callbackServer = createServer((request, response) => {
    expect(request.url).toBe("/callback?code=verified");
    resolveCallback();
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("connected");
  });
  const callbackPort = await listen(callbackServer);
  const callbackOrigin = `http://127.0.0.1:${callbackPort}`;

  const authorizationServer = createServer((request, response) => {
    if (request.url === "/authorize") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; form-action 'self' ${callbackOrigin}`,
      });
      response.end(
        '<form method="post" action="/consent"><button type="submit">Connect Codex</button></form>',
      );
      return;
    }
    if (request.url === "/consent" && request.method === "POST") {
      response.writeHead(302, { location: `${callbackOrigin}/callback?code=verified` });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const authorizationPort = await listen(authorizationServer);

  try {
    await page.goto(`http://127.0.0.1:${authorizationPort}/authorize`);
    await page.getByRole("button", { name: "Connect Codex" }).click();
    await callbackReached;
    await expect(page).toHaveURL(`${callbackOrigin}/callback?code=verified`);
    await expect(page.getByText("connected")).toBeVisible();
  } finally {
    await Promise.all([close(authorizationServer), close(callbackServer)]);
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser fixture server did not bind a TCP port");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
