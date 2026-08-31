#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { executeGlaedaOwnedWorkstationRunV1 } from "../src/glaeda-owned-workstation-runner.js";
import { RunnerMcpHttpClient } from "../src/runner-mcp-http-client.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    endpoint: { type: "string", default: "https://api.stensibly.com/runner/mcp" },
    project: { type: "string" },
    "run-id": { type: "string" },
    "token-file": { type: "string" },
    "canary-script": { type: "string" },
    "profile-generation": { type: "string" },
    "node-id": { type: "string", default: "big-red" },
    "node-generation": { type: "string" },
    "capability-snapshot": { type: "string" },
    "glaeda-runtime": { type: "string" },
    "os-class": { type: "string", default: process.platform === "darwin" ? "macos" : "linux" },
    architecture: { type: "string", default: process.arch === "arm64" ? "arm64" : "x86_64" },
    "lease-seconds": { type: "string", default: "900" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: bun run glaeda:workstation -- [options]

Required:
  --project SLUG
  --run-id RUN_ID
  --token-file PATH
  --canary-script PATH
  --profile-generation sha256:...
  --node-generation INTEGER
  --capability-snapshot sha256:...
  --glaeda-runtime sha256:...

The runner claims one exact Stensibly run, reserves the existing workstation
command ledger fence, consumes one exact immutable Glaeda request on this node,
settles its bounded result, and terminates. It is not a daemon or scheduler.`);
  process.exit(0);
}

try {
  const tokenFile = required(values["token-file"], "--token-file");
  const token = await readPrivateToken(tokenFile);
  const runner = new RunnerMcpHttpClient({
    endpoint: required(values.endpoint, "--endpoint"),
    token,
  });
  const result = await executeGlaedaOwnedWorkstationRunV1({
    runner,
    project: required(values.project, "--project"),
    runId: required(values["run-id"], "--run-id"),
    profileGeneration: required(values["profile-generation"], "--profile-generation"),
    canaryScriptPath: required(values["canary-script"], "--canary-script"),
    node: {
      id: required(values["node-id"], "--node-id"),
      generation: positiveInteger(values["node-generation"], "--node-generation"),
      capabilitySnapshotSha256: required(values["capability-snapshot"], "--capability-snapshot"),
      osClass: osClass(values["os-class"]),
      architectureClass: architecture(values.architecture),
      glaedaRuntimeSha256: required(values["glaeda-runtime"], "--glaeda-runtime"),
    },
    leaseSeconds: positiveInteger(values["lease-seconds"], "--lease-seconds"),
  });
  console.log(JSON.stringify({ schema: "glaeda-owned-workstation-run/v1", ...result }));
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(JSON.stringify({
    schema: "glaeda-owned-workstation-run/v1",
    outcome: "failed",
    problem: clip(message, 1_000),
  }));
  process.exit(1);
}

async function readPrivateToken(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Runner token file must be a regular file readable only by its owner");
  }
  const token = (await Bun.file(path).text()).trim();
  if (!/^stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/u.test(token)) {
    throw new Error("Runner token file does not contain a Stensibly API token");
  }
  return token;
}

function required(value: unknown, option: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${option} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function osClass(value: unknown): "linux" | "macos" {
  const admitted = required(value, "--os-class");
  if (admitted !== "linux" && admitted !== "macos") throw new Error("--os-class must be linux or macos");
  return admitted;
}

function architecture(value: unknown): "x86_64" | "arm64" {
  const admitted = required(value, "--architecture");
  if (admitted !== "x86_64" && admitted !== "arm64") {
    throw new Error("--architecture must be x86_64 or arm64");
  }
  return admitted;
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
