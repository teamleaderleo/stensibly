import { resolve } from "node:path";
import { validatePlaywrightMcpArgs } from "./browser-evidence-policy.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const args = validatePlaywrightMcpArgs(process.argv.slice(2), repositoryRoot);
const child = Bun.spawn(["bunx", "playwright", "mcp", ...args], {
  cwd: repositoryRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

process.exit(await child.exited);
