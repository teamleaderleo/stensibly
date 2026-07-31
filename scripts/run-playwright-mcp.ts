import { resolve } from "node:path";
import {
  createPlaywrightMcpEnvironment,
  validatePlaywrightMcpArgs,
} from "./browser-evidence-policy.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const args = validatePlaywrightMcpArgs(process.argv.slice(2), repositoryRoot);
const environment = createPlaywrightMcpEnvironment(process.env);
const child = Bun.spawn(["bunx", "playwright", "mcp", ...args], {
  cwd: repositoryRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: environment,
});

process.exit(await child.exited);
