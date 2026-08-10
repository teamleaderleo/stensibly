import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("dashboard setup MCP endpoint continuation", () => {
  test("renders the admitted server endpoint instead of deriving another endpoint", async () => {
    const entry = await readFile("site/project-setup-status-entry.js", "utf8");
    expect(entry).toContain("mcpEndpointSection(setup.mcpEndpoint)");
    expect(entry).toContain("value.textContent = endpoint");
    expect(entry).toContain("heading.textContent = 'MCP endpoint'");
    expect(entry).not.toContain("`${connection.endpoint}/mcp`");
  });

  test("copies only from an explicit user action and adds no server write", async () => {
    const entry = await readFile("site/project-setup-status-entry.js", "utf8");
    const clickIndex = entry.indexOf("copy.addEventListener('click'");
    const clipboardIndex = entry.indexOf("navigator.clipboard", clickIndex);
    const writeIndex = entry.indexOf("clipboard.writeText(endpoint)", clipboardIndex);
    expect(clickIndex).toBeGreaterThanOrEqual(0);
    expect(clipboardIndex).toBeGreaterThan(clickIndex);
    expect(writeIndex).toBeGreaterThan(clipboardIndex);
    expect(entry).toContain("Public endpoint only");
    expect(entry).toContain("Copy unavailable · select the endpoint above");
    expect(entry).not.toContain("method: 'POST'");
    expect(entry).not.toContain("method: 'PUT'");
    expect(entry).not.toContain("method: 'DELETE'");
  });

  test("reuses the existing setup-status GET instead of adding a second endpoint read", async () => {
    const entry = await readFile("site/project-setup-status-entry.js", "utf8");
    expect(entry.match(/\/setup-status/g)?.length).toBe(1);
    expect(entry.match(/method: 'GET'/g)?.length).toBe(1);
  });
});
