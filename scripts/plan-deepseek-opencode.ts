import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  planDeepSeekOpenCodeEpisode,
  type DeepSeekHarnessEffort,
  type DeepSeekHarnessPhase,
} from "../src/deepseek-harness-campaign.js";

const parsed = parseArgs({
  options: {
    episode: { type: "string" },
    phase: { type: "string", default: "observe" },
    effort: { type: "string", default: "high" },
    worktree: { type: "string" },
    runtime: { type: "string" },
    prompt: { type: "string" },
    "wall-seconds": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const episodeId = required(parsed.values.episode, "--episode");
const worktree = required(parsed.values.worktree, "--worktree");
const runtimeDirectory = required(parsed.values.runtime, "--runtime");
const promptPath = required(parsed.values.prompt, "--prompt");
const prompt = await readFile(promptPath, "utf8");
const wallTimeSeconds = parsed.values["wall-seconds"] === undefined
  ? undefined
  : Number(parsed.values["wall-seconds"]);

const plan = planDeepSeekOpenCodeEpisode({
  episodeId,
  phase: parsed.values.phase as DeepSeekHarnessPhase,
  effort: parsed.values.effort as DeepSeekHarnessEffort,
  worktree,
  runtimeDirectory,
  prompt,
  wallTimeSeconds,
});

console.log(JSON.stringify(plan, null, 2));

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
