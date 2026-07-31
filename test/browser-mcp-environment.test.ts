import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPlaywrightMcpEnvironment } from "../scripts/browser-evidence-policy.ts";

const repositoryRoot = join(import.meta.dir, "..");
const launcher = readFileSync(join(repositoryRoot, "scripts", "run-playwright-mcp.ts"), "utf8");

describe("Playwright MCP child environment", () => {
  test("retains only reviewed execution paths and locale", () => {
    const environment = createPlaywrightMcpEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/operator",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      GITHUB_TOKEN: "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456",
      HTTPS_PROXY: "https://operator:secret@example.invalid",
      STENSIBLY_TOKEN: "stn.tok_abcdefghijklmnopqrstuvwxyz",
    });

    expect(environment).toEqual({
      HOME: "/home/operator",
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin",
      TMPDIR: "/tmp",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  test("rejects credential-shaped and control-bearing admitted values with fixed prose", () => {
    for (const value of [
      "/tmp/github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "/tmp/stn.tok_abcdefghijklmnopqrstuvwxyz",
      "/tmp/line\nbreak",
    ]) {
      let message = "";
      try {
        createPlaywrightMcpEnvironment({ HOME: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Playwright MCP execution environment contains an unsafe admitted value");
      expect(message).not.toContain(value);
    }
  });

  test("launches with the admitted environment instead of the parent process envelope", () => {
    expect(launcher).toContain("createPlaywrightMcpEnvironment(process.env)");
    expect(launcher).toContain("env: environment");
    expect(launcher).not.toContain("env: { ...process.env }");
  });
});
