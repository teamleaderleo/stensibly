import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { readPrincipal } from "../site/session-context.js";

describe("hosted account dashboard context regression", () => {
  test("accepts the redacted hosted account principal contract", () => {
    expect(readPrincipal({
      principal: {
        kind: "account",
        name: "Dashboard member",
        workspace: "default",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
        accountId: "must-not-survive",
      },
      capabilities: { read: true, write: true, admin: false },
    })).toEqual({
      principal: {
        kind: "account",
        name: "Dashboard member",
        workspace: "default",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
      },
      capabilities: { read: true, write: true, admin: false },
    });
  });

  test("persists the normalized endpoint before hosted sidecars read connection storage", async () => {
    const bridge = await readFile(new URL("../site/hosted-session-bridge.js", import.meta.url), "utf8");
    expect(bridge).toContain("persistEndpoint(savedEndpoint)");
    expect(bridge).toContain("localStorage.setItem('stensiblyEndpoint', endpoint)");
    expect(bridge.indexOf("persistEndpoint(savedEndpoint)"))
      .toBeLessThan(bridge.indexOf("installSessionMarker(savedEndpoint)"));
  });
});
