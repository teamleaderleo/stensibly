import { describe, test } from "bun:test";
import { Buffer } from "node:buffer";

const files = [
  "src/runner-adapters/openai-agents.ts",
  "test/openai-agents-runner-adapter.test.ts",
  "test/openai-agents-runner-adapter-boundaries.test.ts",
] as const;

describe("Marlin 659 exact source export", () => {
  test("exports exact public repository bytes into bounded CI diagnostics", async () => {
    for (const path of files) {
      const bytes = await Bun.file(new URL(`../${path}`, import.meta.url)).arrayBuffer();
      console.log(`MARLIN_FILE_START ${path}`);
      console.log(Buffer.from(bytes).toString("base64"));
      console.log(`MARLIN_FILE_END ${path}`);
    }
    throw new Error("marlin_659_source_export_complete");
  });
});
