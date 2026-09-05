#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  executeGlaedaVerifyFocusedRunV1,
  executeGlaedaVerifyRequiredRunV1,
} from "../src/glaeda-verify-focused-runner.js";
import { RunnerMcpHttpClient } from "../src/runner-mcp-http-client.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    endpoint: { type: "string", default: "https://api.stensibly.com/runner/mcp" },
    "verification-profile": { type: "string", default: "focused" },
    project: { type: "string" },
    "run-id": { type: "string" },
    "token-file": { type: "string" },
    "python-interpreter": { type: "string" },
    "verify-script": { type: "string" },
    "verify-implementation": { type: "string" },
    "repository-root": { type: "string" },
    "state-root": { type: "string" },
    "cargo-root": { type: "string" },
    "rustup-root": { type: "string" },
    "profile-generation": { type: "string" },
    "node-id": { type: "string", default: "big-red" },
    "node-generation": { type: "string" },
    "glaeda-runtime": { type: "string" },
    "lease-seconds": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: bun run glaeda:verify-focused -- [exact local runner options]

Claims one dispatched named verification run, invokes the fixed Glaeda profile under
credentialless_project, settles its compact receipt, and exits. The caller cannot
supply shell, argv, environment, executable, remote URL, mutable ref, or credential.`);
  process.exit(0);
}

try {
  const token = await readPrivateToken(required(values["token-file"], "--token-file"));
  const execute = verificationExecutor(values["verification-profile"]);
  const result = await execute({
    runner: new RunnerMcpHttpClient({ endpoint: required(values.endpoint, "--endpoint"), token }),
    project: required(values.project, "--project"),
    runId: required(values["run-id"], "--run-id"),
    profileGeneration: required(values["profile-generation"], "--profile-generation"),
    pythonInterpreterPath: required(values["python-interpreter"], "--python-interpreter"),
    verifyScriptPath: required(values["verify-script"], "--verify-script"),
    verifyImplementationPath: required(
      values["verify-implementation"],
      "--verify-implementation",
    ),
    repositoryRoot: required(values["repository-root"], "--repository-root"),
    stateRoot: required(values["state-root"], "--state-root"),
    cargoRoot: required(values["cargo-root"], "--cargo-root"),
    rustupRoot: required(values["rustup-root"], "--rustup-root"),
    node: {
      id: required(values["node-id"], "--node-id"),
      generation: positiveInteger(values["node-generation"], "--node-generation"),
      osClass: "linux",
      architectureClass: "x86_64",
      glaedaRuntimeSha256: required(values["glaeda-runtime"], "--glaeda-runtime"),
    },
    ...(values["lease-seconds"] === undefined
      ? {}
      : { leaseSeconds: positiveInteger(values["lease-seconds"], "--lease-seconds") }),
  });
  console.log(JSON.stringify({ schema: "glaeda-verify-focused-run/v1", ...result }));
  // A settled failed verification is a normal typed result, but must still fail
  // the invoking worker/CI command so it cannot advance as a successful check.
  if (result.outcome === "failed") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(JSON.stringify({
    schema: "glaeda-verify-focused-run/v1",
    outcome: "failed",
    problem: message.length <= 1_000 ? message : `${message.slice(0, 999)}…`,
  }));
  process.exit(1);
}

async function readPrivateToken(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Runner token file must be a regular owner-only file");
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

function verificationExecutor(value: unknown) {
  if (value === "focused") return executeGlaedaVerifyFocusedRunV1;
  if (value === "required") return executeGlaedaVerifyRequiredRunV1;
  throw new Error("--verification-profile must be focused or required");
}

function positiveInteger(value: unknown, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be positive`);
  return parsed;
}
